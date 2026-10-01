import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type ParsedIps = { header: Record<string, unknown>; body?: Record<string, unknown> };
export type CrashFrame = { image: string | null; symbol: string | null; offset: number | null; sourceFile: string | null; sourceLine: number | null };
export type CrashSummary = {
  file: string; incidentId: string | null; timestamp: string; bundleId: string | null; process: string | null;
  exceptionType: string | null; signal: string | null; termination: string | null; message: string | null; frames: CrashFrame[];
};
export type FoundCrash = { path: string; text: string; summary: CrashSummary };
export type CrashQuery = { directory: string; since: Date; bundleId: string; executableName?: string; limit: number };

const maxFrames = 15;
const maxMessage = 2_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Line 1 is the JSON header; the rest is the JSON body. A body that fails to parse is omitted. */
export function parseIpsReport(contents: string): ParsedIps {
  const newline = contents.indexOf('\n');
  const header = record(JSON.parse(newline < 0 ? contents : contents.slice(0, newline)));
  if (!header) throw new Error('Crash report header is not a JSON object');
  if (newline < 0) return { header };
  try { return { header, body: record(JSON.parse(contents.slice(newline + 1))) }; }
  catch { return { header }; }
}

/** Converts `YYYY-MM-DD HH:MM:SS(.ss) ±HHMM` to an ISO string; undefined when unparsable. */
export function crashTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-])(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const time = Date.parse(`${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(strings);
  const object = record(value);
  return object ? Object.values(object).flatMap(strings) : [];
}

function termination(value: unknown): string | null {
  const object = record(value);
  if (!object) return null;
  const indicator = text(object.indicator);
  if (indicator) return indicator;
  const parts = [text(object.namespace), object.code === undefined ? null : String(object.code)].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function frames(body: Record<string, unknown> | undefined): CrashFrame[] {
  const threads = Array.isArray(body?.threads) ? body.threads : [];
  const faulting = number(body?.faultingThread);
  const thread = record(faulting === null ? threads.find((item) => record(item)?.triggered === true) : threads[faulting]);
  const images = Array.isArray(body?.usedImages) ? body.usedImages : [];
  const list = Array.isArray(thread?.frames) ? thread.frames : [];
  return list.slice(0, maxFrames).map((item) => {
    const frame = record(item) ?? {};
    const imageIndex = number(frame.imageIndex);
    return {
      image: imageIndex === null ? null : text(record(images[imageIndex])?.name),
      symbol: text(frame.symbol),
      offset: number(frame.imageOffset),
      sourceFile: text(frame.sourceFile),
      sourceLine: number(frame.sourceLine),
    };
  });
}

export function summarizeCrash(file: string, parsed: ParsedIps, fallbackTimestamp?: Date): CrashSummary {
  const { header, body } = parsed;
  const exception = record(body?.exception);
  const message = strings(body?.asi).join('\n');
  return {
    file,
    incidentId: text(header.incident_id),
    timestamp: crashTimestamp(header.timestamp) ?? (fallbackTimestamp ?? new Date(0)).toISOString(),
    bundleId: text(header.bundleID),
    process: text(body?.procName) ?? text(header.app_name) ?? text(header.name),
    exceptionType: text(exception?.type),
    signal: text(exception?.signal),
    termination: termination(body?.termination),
    message: message ? message.slice(0, maxMessage) : null,
    frames: frames(body),
  };
}

/**
 * The header's bundleID identifies the app when present. Reports without one fall back to the
 * executable name, which another app with the same executable could share.
 */
function matches(parsed: ParsedIps, bundleId: string, executableName?: string): boolean {
  const reported = text(parsed.header.bundleID);
  if (reported) return reported === bundleId;
  if (!executableName) return false;
  return parsed.header.app_name === executableName || parsed.body?.procName === executableName;
}

export async function findCrashReports(query: CrashQuery): Promise<{ crashes: FoundCrash[]; skipped: number }> {
  let names: string[];
  try { names = await readdir(query.directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { crashes: [], skipped: 0 };
    throw error;
  }
  const since = query.since.getTime();
  const found: FoundCrash[] = [];
  let skipped = 0;
  for (const name of names.filter((item) => item.endsWith('.ips'))) {
    const file = path.join(query.directory, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      // A report is written after its crash, so an older modification time rules it out without reading it.
      if (info.mtimeMs < since) continue;
      const contents = await readFile(file, 'utf8');
      const parsed = parseIpsReport(contents);
      if (String(parsed.header.bug_type) !== '309' || !matches(parsed, query.bundleId, query.executableName)) continue;
      const summary = summarizeCrash(name, parsed, info.mtime);
      if (Date.parse(summary.timestamp) < since) continue;
      found.push({ path: file, text: contents, summary });
    } catch { skipped += 1; }
  }
  found.sort((left, right) => Date.parse(right.summary.timestamp) - Date.parse(left.summary.timestamp));
  return { crashes: found.slice(0, query.limit), skipped };
}
