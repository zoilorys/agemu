import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { appendEvent, bestEffortEvent, recordCommand } from '../../src/artifacts/runs.js';
import { CliError } from '../../src/core/errors.js';

const run = promisify(execFile);
const moduleFile = fileURLToPath(new URL('../../dist/artifacts/runs.js', import.meta.url));

describe('diagnostic events', () => {
  it('abandons best-effort recording promptly when another process holds the event lock', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-events-contention-'));
    try {
      await mkdir(path.join(root, '.agemu/events.lock'), { recursive: true });
      const start = performance.now();
      await bestEffortEvent(root, { status: 'ok' }, [], { lockTimeoutMs: 25 });
      expect(performance.now() - start).toBeLessThan(500);
      await expect(readFile(path.join(root, '.agemu/events.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps command success and the original error when the event file is unwritable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-events-unwritable-'));
    const config = { root };
    const result = { run: '.agemu/runs/example', bundleId: 'com.example.app' };
    const failure = new CliError('PROCESS_TIMEOUT', 'original failure', { completed: 2 });
    try {
      await mkdir(path.join(root, '.agemu', 'events.jsonl'), { recursive: true });
      await expect(recordCommand(config, 'build', async () => result)).resolves.toBe(result);
      await expect(recordCommand(config, 'ui run', async () => { throw failure; })).rejects.toBe(failure);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('redacts failure summaries and omits captured raw process output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-events-boundary-'));
    const failure = new CliError('PROCESS_TIMEOUT', 'secret-value timed out', { failedAction: { message: 'secret-value' }, result: { stdout: 'very large raw output' } });
    try {
      await expect(recordCommand({ root, redactions: ['secret-value'] }, 'ui run', async () => { throw failure; })).rejects.toBe(failure);
      const contents = await readFile(path.join(root, '.agemu/events.jsonl'), 'utf8');
      expect(contents).not.toContain('secret-value');
      expect(contents).not.toContain('very large raw output');
      expect(JSON.parse(contents)).toMatchObject({ status: 'error', error: { code: 'PROCESS_TIMEOUT', message: '[REDACTED] timed out' }, details: { failedAction: { message: '[REDACTED]' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes concurrent redacted events as complete JSON lines', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-events-'));
    try {
      await Promise.all(Array.from({ length: 40 }, (_, index) => appendEvent(root, {
        index, command: ['xcrun', 'secret-value'], nested: { message: `event ${index} secret-value` },
      }, ['secret-value'])));
      const contents = await readFile(path.join(root, '.agemu/events.jsonl'), 'utf8');
      const lines = contents.trimEnd().split('\n');
      expect(lines).toHaveLength(40);
      expect(lines.map((line) => JSON.parse(line)).map((event) => event.index).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index));
      expect(contents).not.toContain('secret-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('serializes event writes from concurrent CLI processes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-events-processes-'));
    try {
      await Promise.all(Array.from({ length: 24 }, (_, index) => run(process.execPath, [
        '--input-type=module', '-e',
        `import { appendEvent } from ${JSON.stringify(moduleFile)}; await appendEvent(process.argv[1], { index: Number(process.argv[2]), payload: 'x'.repeat(8192) }, []);`,
        root, String(index),
      ])));
      const contents = await readFile(path.join(root, '.agemu/events.jsonl'), 'utf8');
      const events = contents.trimEnd().split('\n').map((line) => JSON.parse(line) as { index: number; payload: string });
      expect(events).toHaveLength(24);
      expect(events.map(({ index }) => index).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, index) => index));
      expect(events.every(({ payload }) => payload.length === 8192)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
