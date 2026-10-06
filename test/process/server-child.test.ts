import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/process/run-process.js';

describe('server supervisor output', () => {
  it('redacts UTF-8 secrets split between byte chunks and drains the final output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-supervisor-'));
    const cli = path.join(root, 'cli.cjs');
    const log = path.join(root, 'metro.log');
    const secrets = path.join(root, 'redactions.json');
    try {
      await writeFile(cli, "const value = Buffer.from('秘密'); process.stdout.write(value.subarray(0, 2)); setTimeout(() => { process.stdout.write(value.subarray(2)); process.stdout.end(' final output'); }, 20);");
      await writeFile(secrets, JSON.stringify(['秘密']), { mode: 0o600 });
      const supervisor = fileURLToPath(new URL('../../dist/process/server-child.js', import.meta.url));
      const result = await runProcess(process.execPath, [supervisor, 'test-token', root, '8081', cli, log, secrets], { timeoutMs: 3000 });
      expect(result.exitCode).toBe(0);
      expect(await readFile(log, 'utf8')).toBe('[REDACTED] final output');
      await expect(readFile(secrets)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('starts the project server without the caller NODE_ENV', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-supervisor-'));
    const cli = path.join(root, 'cli.cjs');
    const log = path.join(root, 'metro.log');
    const secrets = path.join(root, 'redactions.json');
    try {
      await writeFile(cli, "process.stdout.write(`NODE_ENV=${process.env.NODE_ENV ?? 'unset'} MARKER=${process.env.AGEMU_TEST_MARKER}`);");
      await writeFile(secrets, '[]', { mode: 0o600 });
      const supervisor = fileURLToPath(new URL('../../dist/process/server-child.js', import.meta.url));
      const result = await runProcess(process.execPath, [supervisor, 'test-token', root, '8081', cli, log, secrets], { timeoutMs: 3000, env: { ...process.env, NODE_ENV: 'test', AGEMU_TEST_MARKER: 'kept' } });
      expect(result.exitCode).toBe(0);
      expect(await readFile(log, 'utf8')).toBe('NODE_ENV=unset MARKER=kept');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
