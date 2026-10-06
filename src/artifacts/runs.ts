import { appendFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../core/redact.js';
import { CliError } from '../core/errors.js';

export type Run = { id: string; directory: string; relativeDirectory: string };

export async function createRun(root: string, now = new Date()): Promise<Run> {
  const id = `${now.toISOString().replaceAll(':', '-')}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const directory = path.join(root, '.agemu', 'runs', id);
  await mkdir(directory, { recursive: true });
  return { id, directory, relativeDirectory: path.relative(root, directory) };
}

// Keeps the input's shape (only string contents and keys change), so callers keep their static type.
export function redactValue<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redactValue(item, secrets)])) as T;
  }
  return value;
}

export type EventOptions = { lockTimeoutMs?: number };

async function acquireLock(directory: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lock = path.join(directory, 'events.lock');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lock);
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export async function appendEvent(root: string, event: Record<string, unknown>, secrets: string[], options: EventOptions = {}): Promise<void> {
  const directory = path.join(root, '.agemu');
  await mkdir(directory, { recursive: true });
  const line = `${JSON.stringify(redactValue(event, secrets))}\n`;
  const release = await acquireLock(directory, options.lockTimeoutMs ?? 10_000);
  try {
    await appendFile(path.join(directory, 'events.jsonl'), line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  } finally {
    await release();
  }
}

/** Evidence recording never replaces the outcome; the default lock budget is 100 ms. */
export async function bestEffortEvent(root: string, event: Record<string, unknown>, secrets: string[], options: EventOptions = {}): Promise<void> {
  try { await appendEvent(root, event, secrets, { lockTimeoutMs: options.lockTimeoutMs ?? 100 }); } catch { /* The operation owns the outcome. */ }
}

const summaryKeys = ['run', 'udid', 'bundleId', 'backend', 'action'];

/** Shared CLI boundary; avoids persisting raw process output in failure details. */
export async function recordCommand<T>(config: { root: string; redactions?: string[] }, command: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = new Date();
  const base = { at: startedAt.toISOString(), command };
  let data: T;
  try { data = await operation(); }
  catch (error) {
    const normalized = error instanceof CliError ? error : new CliError('PROCESS_FAILED', error instanceof Error ? error.message : String(error));
    const { result: _, ...details } = normalized.details ?? {};
    await bestEffortEvent(config.root, {
      ...base, status: 'error', durationMs: Date.now() - startedAt.getTime(),
      error: { code: normalized.code, message: normalized.message }, ...(normalized.details ? { details } : {}),
    }, config.redactions ?? []);
    throw error;
  }
  const source = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const summary = Object.fromEntries(summaryKeys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  await bestEffortEvent(config.root, { ...base, status: 'ok', durationMs: Date.now() - startedAt.getTime(), summary }, config.redactions ?? []);
  return data;
}
