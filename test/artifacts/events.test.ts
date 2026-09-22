import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { appendEvent } from '../../src/artifacts/runs.js';

const run = promisify(execFile);
const moduleFile = fileURLToPath(new URL('../../dist/artifacts/runs.js', import.meta.url));

describe('diagnostic events', () => {
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
