import { appendFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../core/redact.js';

export type Run = { id: string; directory: string; relativeDirectory: string };

export async function createRun(root: string, now = new Date()): Promise<Run> {
  const id = `${now.toISOString().replaceAll(':', '-')}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const directory = path.join(root, '.agemu', 'runs', id);
  await mkdir(directory, { recursive: true });
  return { id, directory, relativeDirectory: path.relative(root, directory) };
}

export function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redactValue(item, secrets)]));
  }
  return value;
}

async function acquireLock(directory: string): Promise<() => Promise<void>> {
  const lock = path.join(directory, 'events.lock');
  const deadline = Date.now() + 10_000;
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

export async function appendEvent(root: string, event: Record<string, unknown>, secrets: string[]): Promise<void> {
  const directory = path.join(root, '.agemu');
  await mkdir(directory, { recursive: true });
  const line = `${JSON.stringify(redactValue(event, secrets))}\n`;
  const release = await acquireLock(directory);
  try {
    await appendFile(path.join(directory, 'events.jsonl'), line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  } finally {
    await release();
  }
}
