import { writeFile } from 'node:fs/promises';
import { redact } from '../core/redact.js';

export type BuildError = { file?: string; line?: number; column?: number; message: string };

const located = /^(\/[^:]+):(\d+)(?::(\d+))?: (?:fatal )?error: (.+)$/;
const unlocated = /^(?:xcodebuild: |clang: |ld: )?(?:fatal )?error: (.+)$/;
const expo = /^CommandError: (.+)$/;

/** Parses compiler and build errors from xcodebuild or Expo output, de-duplicated in first-seen order. */
export function parseBuildErrors(output: string, limit = 20): BuildError[] {
  const errors: BuildError[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    if (errors.length >= limit) break;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let error: BuildError | undefined;
    const match = located.exec(line);
    if (match) {
      error = { file: match[1], line: Number(match[2]), ...(match[3] ? { column: Number(match[3]) } : {}), message: match[4] };
    } else {
      const message = unlocated.exec(line)?.[1] ?? expo.exec(line)?.[1];
      if (message !== undefined) error = { message };
    }
    if (!error) continue;
    const key = `${error.file ?? ''}:${error.line ?? ''}:${error.column ?? ''}:${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(error);
  }
  return errors;
}

/** `errors` parsed from the redacted output, or the last 20 non-empty lines as `tail` when none parse. */
export function buildFailureDetails(stdout: string, stderr: string, secrets: string[]): { errors: BuildError[] } | { tail: string[] } {
  const output = redact(`${stdout}\n${stderr}`, secrets);
  const errors = parseBuildErrors(output);
  if (errors.length > 0) return { errors };
  return { tail: output.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim()).slice(-20) };
}

export type BuildLog = { stdout: string; stderr: string; executionError?: string };

const section = (text: string) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/** Writes an already-redacted build log as plain text: stdout, stderr, and any execution error. */
export async function writeBuildLog(file: string, log: BuildLog): Promise<void> {
  let text = `${section(log.stdout)}--- stderr ---\n${section(log.stderr)}`;
  if (log.executionError !== undefined) text += `--- execution error ---\n${section(log.executionError)}`;
  await writeFile(file, text, { mode: 0o600 });
}
