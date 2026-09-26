import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { server } from '../../src/commands/server.js';
import type { LoadedConfig } from '../../src/config/config.js';

const roots: string[] = [];
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('Metro server', () => {
  it('starts, reuses, and stops a real project child', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-server-'));
    roots.push(root);
    const cliDir = path.join(root, 'node_modules', 'react-native');
    await mkdir(cliDir, { recursive: true });
    await writeFile(path.join(cliDir, 'cli.js'), "const http = require('node:http'); const port = Number(process.argv.at(-1)); process.stdout.write('x'.repeat(131072) + 'SECRET' + 'VALUE'); process.stdout.write(' SECRET'); setTimeout(() => process.stdout.write('VALUE end'), 30); const server = http.createServer((q, s) => s.end('packager-status:running')); server.listen(port, '127.0.0.1'); process.on('SIGTERM', () => server.close());\n");
    const config: LoadedConfig = { version: 2, platform: 'ios', root, simulator: { udid: 'unused' }, redactions: ['SECRETVALUE'], app: { type: 'react-native', root, port: await freePort(), project: path.join(root, 'ios', 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'app.test' } };
    try {
      const started = await server(config, 'start');
      expect(started).toMatchObject({ running: true, owned: true, reused: false });
      await new Promise(resolve => setTimeout(resolve, 100));
      const command = execFileSync('ps', ['-p', String(started.pid), '-o', 'command='], { encoding: 'utf8' });
      expect(command).not.toContain('SECRETVALUE');
      const output = await readFile(path.join(root, '.agemu', 'metro.log'), 'utf8');
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('SECRETVALUE');
      expect(output).not.toContain('SECRET');
      expect((await readdir(path.join(root, '.agemu'))).some(name => name.startsWith('server-redactions-'))).toBe(false);
      expect(await server(config, 'status')).toMatchObject({ running: true, owned: true });
      expect(await server(config, 'start')).toMatchObject({ running: true, owned: true, reused: true });
      const changed = { ...config, app: { ...config.app, port: await freePort() } } as LoadedConfig;
      await expect(server(changed, 'start')).rejects.toThrow(/stop it before changing/);
      expect(await server(config, 'status')).toMatchObject({ running: true, owned: true });
      expect(await server(changed, 'stop')).toMatchObject({ stopped: true, port: config.app.port });
      expect(await server(config, 'status')).toMatchObject({ running: false, owned: false });
      const foreign = createHttpServer((_request, response) => response.end('packager-status:running'));
      await new Promise<void>(resolve => foreign.listen(config.app.port, '127.0.0.1', resolve));
      try {
        expect(await server(config, 'status')).toMatchObject({ running: false, owned: false, collision: true });
        await expect(server(config, 'start')).rejects.toThrow(/identity cannot be verified/);
        expect(await server(config, 'stop')).toMatchObject({ stopped: false });
        expect(foreign.listening).toBe(true);
      } finally { await new Promise<void>(resolve => foreign.close(() => resolve())); }
    } finally { await server(config, 'stop'); }
  }, 60_000);
});
