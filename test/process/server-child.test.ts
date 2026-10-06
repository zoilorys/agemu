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

  it.each([
    { name: 'drops NODE_ENV=test', nodeEnv: 'test', expoMode: undefined, output: 'ARGS=start --port 8081 NODE_ENV=unset MARKER=kept' },
    { name: 'keeps any other NODE_ENV', nodeEnv: 'development', expoMode: undefined, output: 'ARGS=start --port 8081 NODE_ENV=development MARKER=kept' },
    { name: 'starts Expo in its mode without NODE_ENV=test', nodeEnv: 'test', expoMode: 'dev-client', output: 'ARGS=start --dev-client --port 8081 NODE_ENV=unset MARKER=kept' },
  ])('$name for the project server', async ({ nodeEnv, expoMode, output }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-supervisor-'));
    const cli = path.join(root, 'cli.cjs');
    const log = path.join(root, 'metro.log');
    const secrets = path.join(root, 'redactions.json');
    try {
      await writeFile(cli, "process.stdout.write(`ARGS=${process.argv.slice(2).join(' ')} NODE_ENV=${process.env.NODE_ENV ?? 'unset'} MARKER=${process.env.AGEMU_TEST_MARKER}`);");
      await writeFile(secrets, '[]', { mode: 0o600 });
      const supervisor = fileURLToPath(new URL('../../dist/process/server-child.js', import.meta.url));
      const args = [supervisor, 'test-token', root, '8081', cli, log, secrets, ...(expoMode ? [expoMode] : [])];
      const result = await runProcess(process.execPath, args, { timeoutMs: 3000, env: { ...process.env, NODE_ENV: nodeEnv, AGEMU_TEST_MARKER: 'kept' } });
      expect(result.exitCode).toBe(0);
      expect(await readFile(log, 'utf8')).toBe(output);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
