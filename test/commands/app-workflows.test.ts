import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { reloadApp, resolveExpoProjectUrl, controlApp } from '../../src/commands/app.js';
import { appStatus, listInstalledApps } from '../../src/commands/app-status.js';
import { clipboard } from '../../src/commands/clipboard.js';
import { CliError } from '../../src/core/errors.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const native: LoadedConfig = { version: 2, platform: 'ios', root: '/repo', redactions: ['top-secret'],
  app: { type: 'native', project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' } };
const expo: LoadedConfig = { ...native, app: { type: 'expo', root: '/repo', port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' } };
const rn: LoadedConfig = { ...native, app: { type: 'react-native', root: '/repo', port: 8081, project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' } };
const device = (state = 'Booted') => async () => [{ udid: 'PHONE', name: 'Phone', runtime: 'iOS-18-0', state, isAvailable: true }];
const ok = (stdout = ''): ProcessResult => ({ stdout, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 });
const project = { listDevices: device(), serverStatus: async () => ({ running: true }) };
const serverClosures: Array<() => Promise<void>> = [];
afterAll(async () => { await Promise.all(serverClosures.map(close => close())); });
async function http(handler: Parameters<typeof createServer>[0]) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  serverClosures.push(() => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }));
  return (instance.address() as { port: number }).port;
}

describe('project launch and reload', () => {
  it('falls back to the legacy Expo endpoint and accepts the verified local URL', async () => {
    const requested: string[] = [];
    const port = await http((req, res) => {
      requested.push(req.url!);
      if (req.url!.startsWith('/_expo/open')) { res.writeHead(404); res.end(); }
      else { res.writeHead(307, { location: `exp://127.0.0.1:${port}` }); res.end(); }
    });
    const config = { ...expo, app: { ...expo.app, port } } as LoadedConfig;
    await expect(resolveExpoProjectUrl(config, project)).resolves.toBe(`exp://127.0.0.1:${port}`);
    expect(requested).toEqual(['/_expo/open?platform=ios&runtime=expo', '/_expo/link?platform=ios&choice=expo-go']);
  });

  it('rejects project collisions before sending a URL or reload request', async () => {
    let requests = 0;
    const dependencies = { ...project, serverStatus: async () => ({ running: true, collision: true }),
      request: (async () => { requests++; return new Response(); }) as typeof fetch };
    await expect(resolveExpoProjectUrl(expo, dependencies)).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    await expect(reloadApp(rn, dependencies)).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    expect(requests).toBe(0);
  });

  it.each(['exp://127.0.0.1:9999', 'exp://evil.example:8081', 'https://127.0.0.1:8081'])('rejects a mismatched Expo project URL %s', async url => {
    await expect(resolveExpoProjectUrl(expo, { ...project, resolveExpoUrl: async () => url })).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
  });

  it('bounds a response that sends headers but never finishes its body', async () => {
    const port = await http((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"url":'); });
    const config = { ...expo, app: { ...expo.app, port } } as LoadedConfig;
    await expect(resolveExpoProjectUrl(config, { ...project, requestTimeoutMs: 100 })).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT', details: { timeoutMs: 100 } });
  });

  it('bounds a hung injected URL resolver too', async () => {
    await expect(resolveExpoProjectUrl(expo, { ...project, requestTimeoutMs: 10, resolveExpoUrl: () => new Promise(() => {}) }))
      .rejects.toMatchObject({ code: 'PROCESS_TIMEOUT' });
  });

  it('reloads the configured RN port and reports a request, without claiming app completion', async () => {
    const requests: Array<{ url: string | undefined; method: string | undefined }> = [];
    const port = await http((req, res) => { requests.push({ url: req.url, method: req.method }); res.end('OK'); });
    const config = { ...rn, app: { ...rn.app, port } } as LoadedConfig;
    await expect(reloadApp(config, project)).resolves.toEqual({ action: 'reload', udid: 'PHONE', bundleId: 'com.example.app', port, reloadRequested: true });
    expect(requests).toEqual([{ url: '/reload', method: 'GET' }]);
  });

  it('reloads Expo Go through the project server and identifies its host', async () => {
    const request = (async (url: string | URL | Request) => { expect(String(url)).toBe('http://127.0.0.1:8081/reload'); return new Response('OK'); }) as typeof fetch;
    await expect(reloadApp(expo, { ...project, request })).resolves.toMatchObject({ bundleId: 'host.exp.Exponent', reloadRequested: true });
  });

  it('rejects failed reload HTTP responses and redacts request failures', async () => {
    await expect(reloadApp(rn, { ...project, request: (async () => new Response('', { status: 503 })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('HTTP 503') });
    await expect(reloadApp(rn, { ...project, request: (async () => { throw new Error('top-secret denied'); }) as typeof fetch }))
      .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'Unable to request Metro reload: [REDACTED] denied' });
  });

  it('bounds a Metro response that never starts', async () => {
    const port = await http(() => {});
    const config = { ...rn, app: { ...rn.app, port } } as LoadedConfig;
    await expect(reloadApp(config, { ...project, requestTimeoutMs: 100 })).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT' });
  });

  it('rejects native reload and shutdown devices before network work', async () => {
    const request = (async () => { throw new Error('must not call'); }) as typeof fetch;
    await expect(reloadApp(native, { ...project, request })).rejects.toMatchObject({ code: 'WORKFLOW_UNSUPPORTED' });
    await expect(reloadApp(rn, { ...project, listDevices: device('Shutdown'), request })).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
    await expect(controlApp(native, 'launch', {}, { listDevices: device('Shutdown'), runner: async () => { throw new Error('must not call'); } }))
      .rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
  });
});

describe('app status', () => {
  const status = (listing: string) => appStatus(native, { listDevices: device(), runner: async () => ok(listing) });
  it('reports an exact running service PID with foreground explicitly unavailable', async () => {
    await expect(status('PID Status Label\n123 0 UIKitApplication:com.example.app[abc][rb-legacy]\n'))
      .resolves.toMatchObject({ running: true, pid: 123, foreground: null, unavailable: { running: null, pid: null, foreground: expect.any(String) } });
  });
  it('does not confuse similarly named apps or text inside another label with the configured bundle', async () => {
    await expect(status('PID Status Label\n123 0 UIKitApplication:com.example.app.other[abc]\n124 0 Debugger:UIKitApplication:com.example.app[abc]\n'))
      .resolves.toMatchObject({ running: false, pid: null });
  });
  it('does not treat a registered service without a PID as running', async () => {
    await expect(status('PID Status Label\n- 0 UIKitApplication:com.example.app[abc]\n')).resolves.toMatchObject({ running: false, pid: null });
  });
  it.each(['garbage', '', 'PID Status Label\n0 0 UIKitApplication:com.example.app[abc]\n',
    'PID Status Label\n123 0 UIKitApplication:com.example.app[a]\n456 0 UIKitApplication:com.example.app[b]\n'])
  ('reports unavailable for missing, malformed or ambiguous evidence', async listing => {
    await expect(status(listing)).resolves.toMatchObject({ running: null, pid: null, unavailable: { running: expect.any(String) } });
  });
  it('exposes a redacted inspection failure as unavailable evidence', async () => {
    await expect(appStatus(native, { listDevices: device(), runner: async () => ({ ...ok(), stderr: 'top-secret denied', exitCode: 1 }) }))
      .resolves.toMatchObject({ running: null, pid: null, unavailable: { running: '[REDACTED] denied' } });
  });
});

describe('installed applications', () => {
  it.runIf(process.platform === 'darwin')('uses the native plist parser for quoted names and nested app metadata', async () => {
    const apps = '{ "com.z.app" = { CFBundleIdentifier = "com.z.app"; CFBundleDisplayName = "Quoted \\"name\\"; with semicolon"; CFBundleExecutable = Z; Extra = { nested = true; }; }; "com.a.app" = { CFBundleIdentifier = "com.a.app"; }; }';
    await expect(listInstalledApps(native, { listDevices: device(), runner: async () => ok(apps) })).resolves.toMatchObject({
      udid: 'PHONE', apps: [{ bundleId: 'com.a.app', name: null, executableName: null, type: null },
        { bundleId: 'com.z.app', name: 'Quoted "name"; with semicolon', executableName: 'Z', type: null }],
    });
  });
  it.runIf(process.platform === 'darwin').each(['{ broken', '[]', '{ "com.other" = { CFBundleIdentifier = "com.example.app"; }; }'])('rejects malformed or conflicting inventory data', async listing => {
    await expect(listInstalledApps(native, { listDevices: device(), runner: async () => ok(listing) })).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
  });
  it('reports simctl errors with the attempted command and redacted stderr', async () => {
    await expect(listInstalledApps(native, { listDevices: device(), runner: async () => ({ ...ok(), exitCode: 3, stderr: 'top-secret denied' }) }))
      .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: '[REDACTED] denied', details: { command: ['xcrun', 'simctl', 'listapps', 'PHONE'] } });
  });
});

describe('clipboard', () => {
  it('writes actual stdin without exposing shell-like content in process arguments', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agemu-clipboard-'));
    const beforePath = process.env.PATH;
    const captured = path.join(directory, 'captured.json');
    const text = '第一行\n$HOME; $(false)\n';
    try {
      await writeFile(path.join(directory, 'xcrun'), `#!${process.execPath}
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ args: process.argv.slice(2), text: Buffer.concat(chunks).toString('utf8') })));
`, { mode: 0o700 });
      process.env.PATH = `${directory}${path.delimiter}${beforePath ?? ''}`;
      await clipboard(native, 'write', { text }, { listDevices: device() });
      expect(JSON.parse(await readFile(captured, 'utf8'))).toEqual({ args: ['simctl', 'pbcopy', 'PHONE'], text });
    } finally {
      if (beforePath === undefined) delete process.env.PATH; else process.env.PATH = beforePath;
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);
  it('preserves exact multiline Unicode content on read and sends write content through stdin dependency', async () => {
    const text = '第一行\nspace value\n$HOME; $(false)\n';
    const calls: string[][] = [];
    await expect(clipboard(native, 'read', {}, { listDevices: device(), runner: async args => { calls.push(args); return ok(text); } }))
      .resolves.toMatchObject({ action: 'read', text });
    expect(calls).toEqual([['pbpaste', 'PHONE']]);
    let copied: unknown;
    await expect(clipboard(native, 'write', { text }, { listDevices: device(), copy: async (udid, value) => { copied = { udid, value }; return ok(); } }))
      .resolves.toEqual({ action: 'write', udid: 'PHONE' });
    expect(copied).toEqual({ udid: 'PHONE', value: text });
  });
  it('accepts empty clipboard content but rejects missing text before process work', async () => {
    const copies: string[] = [];
    const dependencies = { listDevices: device(), copy: async (_udid: string, text: string) => { copies.push(text); return ok(); } };
    await clipboard(native, 'write', { text: '' }, dependencies);
    await expect(clipboard(native, 'write', {}, dependencies)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(copies).toEqual(['']);
  });
  it('returns redacted structured copy errors without putting content in command details', async () => {
    await expect(clipboard(native, 'write', { text: 'top-secret' }, { listDevices: device(), copy: async () => ({ ...ok(), stderr: 'rejected top-secret', exitCode: 2 }) }))
      .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'rejected [REDACTED]', details: { command: ['xcrun', 'simctl', 'pbcopy', 'PHONE'] } });
    await expect(clipboard(native, 'write', { text: 'top-secret' }, { listDevices: device(), copy: async () => { throw new CliError('PROCESS_TIMEOUT', 'top-secret stalled'); } }))
      .rejects.toMatchObject({ code: 'PROCESS_TIMEOUT', message: '[REDACTED] stalled' });
  });
  it('refuses shutdown simulator access before reading or writing', async () => {
    const dependencies = { listDevices: device('Shutdown'), runner: async () => { throw new Error('must not read'); }, copy: async () => { throw new Error('must not copy'); } };
    await expect(clipboard(native, 'read', {}, dependencies)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
    await expect(clipboard(native, 'write', { text: 'text' }, dependencies)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
  });
});
