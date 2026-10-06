import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { writeConfig } from '../helpers/config.js';
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const devices = (state = 'Booted') => ({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'PHONE', name: 'Phone', state, isAvailable: true }] } });
const nativeApp = { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' };
const emptyArtifacts = { screenshots: [], recordings: [], logs: [], reports: [], files: [], transcript: null, backend: null };
async function fixture(state = 'Booted') {
  const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-discovery-'));
  const calls = path.join(root, 'calls.jsonl');
  const pasteboard = path.join(root, 'pasteboard');
  await writeConfig(root, JSON.stringify({ version: 2, platform: 'ios', app: nativeApp, simulator: { udid: 'PHONE' }, redactions: ['top-secret'] }));
  await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[1] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(devices(state)))});
if (args[1] === 'spawn' && args[3] === 'launchctl') process.stdout.write('PID Status Label\\n123 0 UIKitApplication:com.example.app[a]\\n');
if (args[1] === 'listapps') process.stdout.write('{ "com.example.app" = { CFBundleIdentifier = "com.example.app"; CFBundleDisplayName = "Example App"; }; }');
if (args[1] === 'pbcopy') { const parts = []; process.stdin.on('data', part => parts.push(part)); process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(pasteboard)}, Buffer.concat(parts))); }
if (args[1] === 'pbpaste') process.stdout.write(fs.readFileSync(${JSON.stringify(pasteboard)}));
if (args[1] === 'io' && args[3] === 'screenshot') fs.writeFileSync(args[4], 'screen');
`, { mode: 0o700 });
  const tree = [{ type: 'Application', AXLabel: 'Example App', frame: { x: 0, y: 0, width: 400, height: 800 } },
    { type: 'Button', AXUniqueId: 'save', AXLabel: 'Save', frame: { x: 20, y: 20, width: 80, height: 40 } }];
  await writeFile(path.join(root, 'idb'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(['idb', ...args]) + '\\n');
if (args[1] === 'describe-all') process.stdout.write(${JSON.stringify(JSON.stringify(tree))});
if (args[0] === 'screenshot') fs.writeFileSync(args[1], 'screen');
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` };
  const execute = async (argv: string[]) => JSON.parse((await run(process.execPath, [cli, ...argv], { cwd: root, env })).stdout).data;
  const invoked = async (): Promise<string[][]> => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, env, execute, invoked, pasteboard, dispose: () => rm(root, { recursive: true, force: true }) };
}

describe('command discovery and dispatch', () => {
  it('discovers runtime restrictions and limit bounds without an app configuration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-no-config-'));
    try {
      const plain = JSON.parse((await run(process.execPath, [cli, 'commands'], { cwd: root })).stdout).data;
      expect(plain).toMatchObject({ action: 'commands', udid: null, bundleId: null, run: null, runtime: null, artifacts: emptyArtifacts });
      expect(plain.commands.find((command: { command: string }) => command.command === 'app reload').availability).toMatchObject({ available: null, reason: expect.any(String) });
      const expo = JSON.parse((await run(process.execPath, [cli, 'capabilities', '--runtime=expo-go'], { cwd: root })).stdout).data;
      const find = (name: string) => expo.commands.find((command: { command: string }) => command.command === name);
      expect(find('build').availability.available).toBe(false);
      expect(find('app install').availability.available).toBe(false);
      expect(find('app reload').availability.available).toBe(true);
      expect(find('logs show').options.limit.integer).toMatchObject({ min: 0, max: 10000, default: 100 });
      expect(find('crashes list').options.limit.integer).toMatchObject({ min: 1, max: 100, default: 10 });
      expect(expo.ui.backends.idb).toMatchObject({ foregroundIdentity: null, inspectionScope: 'foreground-tree', depth: null, targetlessDirectionalSwipe: false, videoRecording: true });
      expect(expo.ui.backends.xctest).toMatchObject({ foregroundIdentity: null, inspectionScope: 'configured-app', limitations: [expect.stringContaining('foreground identity')] });
      expect(expo.ui.backends.xctest.videoRecording).toBe(true);
      expect(expo.ui.semantics).toMatchObject({ openUrlConfirmDefault: false, regex: expect.stringContaining('no flags, backreferences, lookaround') });
      expect(expo.ui.actions.startVideoRecording.backends).toContain('idb');
      expect(expo.ui.toolAvailability).toMatchObject({ idb: null, xctest: null, reason: expect.any(String) });
      // A broken local config must not prevent obtaining the static command vocabulary.
      await writeConfig(root, '{broken');
      const broken = JSON.parse((await run(process.execPath, [cli, 'commands'], { cwd: root })).stdout).data;
      expect(broken.configurationAvailability.available).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);

  it('executes discovered app/clipboard handlers and preserves exact private clipboard input', async () => {
    const f = await fixture();
    try {
      const catalog = await f.execute(['commands']);
      const statusCommand = catalog.commands.find((command: { command: string }) => command.command === 'app status');
      const status = await f.execute(statusCommand.command.split(' '));
      expect(status).toMatchObject({ action: 'status', udid: 'PHONE', bundleId: 'com.example.app', pid: 123, running: true, foreground: null, run: null, artifacts: emptyArtifacts });
      expect(Number.isNaN(Date.parse(status.capturedAt))).toBe(false);
      const list = await f.execute(['app', 'list']);
      expect(list).toMatchObject({ action: 'list', udid: 'PHONE', bundleId: null, apps: [{ bundleId: 'com.example.app', name: 'Example App' }] });
      const input = 'Unicode 第一行\ntop-secret $(false); $HOME\n';
      const copied = await f.execute(['clipboard', 'write', `--text=${input}`]);
      expect(copied).toMatchObject({ action: 'write', udid: 'PHONE', bundleId: null, artifacts: emptyArtifacts });
      expect(await readFile(f.pasteboard, 'utf8')).toBe(input);
      const read = await f.execute(['clipboard', 'read']);
      expect(read.text).toBe('Unicode 第一行\n[REDACTED] $(false); $HOME\n');
      const invocations = await f.invoked();
      expect(invocations.find(args => args[1] === 'pbcopy')).toEqual(['simctl', 'pbcopy', 'PHONE']);
      const events = await readFile(path.join(f.root, '.agemu', 'events.jsonl'), 'utf8');
      expect(events).not.toContain('top-secret');
      expect(events).not.toContain('$(false)');
      expect(events.split('\n').filter(Boolean).map(line => JSON.parse(line).command)).toEqual(['app status', 'app list', 'clipboard write', 'clipboard read']);
    } finally { await f.dispose(); }
  }, 20000);

  it('executes tap/type/screenshot shortcuts as validated single-action plans with normal UI evidence', async () => {
    const f = await fixture();
    try {
      const capability = await f.execute(['capabilities']);
      const tapCommand = capability.ui.shortcuts.tap as string;
      const help = JSON.parse((await run(process.execPath, [cli, ...tapCommand.split(' '), '--help'], { cwd: f.root, env: f.env })).stdout).data.help;
      expect(help).toContain('--id=VALUE');
      const tapped = await f.execute([...tapCommand.split(' '), '--id=save', '--backend=idb']);
      expect(tapped).toMatchObject({ completed: 1, actions: 1, bundleId: 'com.example.app', backend: 'idb', screenshots: [], recordings: [], inspections: [] });
      expect((await f.invoked()).find(args => args[0] === 'idb' && args[1] === 'ui' && args[2] === 'tap')).toContain('save');
      const typed = await f.execute(['ui', 'type', '--id=save', '--text=Hello world', '--backend=idb']);
      expect(typed.completed).toBe(1);
      expect((await f.invoked()).find(args => args[0] === 'idb' && args[2] === 'text')).toEqual(['idb', 'ui', 'text', '--udid', 'PHONE', '--', 'Hello world']);
      const shot = await f.execute(['ui', 'screenshot', '--name=save screen', '--backend=idb']);
      expect(shot.artifacts.screenshots).toEqual(shot.screenshots);
      expect(shot.screenshots[0]).toMatch(/screenshots\/0-save_screen\.png$/);
      expect(shot.artifacts.transcript).toBe(shot.transcript);
      const inspected = await f.execute(['ui', 'inspect', '--backend=idb']);
      expect(inspected).toMatchObject({ foreground: null, completed: 2, actions: 2, recordings: [], backendArtifacts: {} });
      expect(inspected.artifacts.screenshots).toEqual([inspected.screenshot]);
      expect(inspected.inspections).toHaveLength(1);
      const events = (await readFile(path.join(f.root, '.agemu', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(events.map(event => event.command)).toEqual(['ui tap', 'ui type', 'ui screenshot', 'ui inspect']);
    } finally { await f.dispose(); }
  }, 20000);

  it('rejects invalid shortcuts and unknown flags before device or backend work', async () => {
    const f = await fixture();
    try {
      for (const argv of [['ui', 'tap', '--id=save', '--x=1', '--y=2'], ['ui', 'assert-text', '--id=save', '--matches=(?=secret)'], ['ui', 'type', '--id=save']]) {
        await expect(run(process.execPath, [cli, ...argv], { cwd: f.root, env: f.env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('UI_VALIDATION_FAILED') });
      }
      await expect(run(process.execPath, [cli, 'ui', 'tap', '--bogus=save'], { cwd: f.root, env: f.env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Unknown option --bogus for ui tap') });
      expect(await f.invoked()).toEqual([]);
      await expect(run(process.execPath, [cli, 'ui', 'run', '--plan-json={"version":1,"actions":[{"top-secret":{}}]}'], { cwd: f.root, env: f.env }))
        .rejects.toMatchObject({ code: 1, stdout: expect.not.stringContaining('top-secret') });
    } finally { await f.dispose(); }
  }, 20000);

  it('rejects discovered commands on a stopped device and returns the primary error even when events fail', async () => {
    const f = await fixture('Shutdown');
    await mkdir(path.join(f.root, '.agemu', 'events.jsonl'), { recursive: true });
    try {
      await expect(run(process.execPath, [cli, 'app', 'status'], { cwd: f.root, env: f.env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('SIMULATOR_NOT_BOOTED') });
      await expect(run(process.execPath, [cli, 'clipboard', 'write', '--text=top-secret'], { cwd: f.root, env: f.env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('SIMULATOR_NOT_BOOTED') });
      expect((await f.invoked()).every(args => args[1] === 'list')).toBe(true);
    } finally { await f.dispose(); }
  }, 20000);

  it('reuses device selection across diagnostic evidence and records each command once', async () => {
    const f = await fixture();
    try {
      const diagnosis = await f.execute(['diagnose']);
      expect(diagnosis).toMatchObject({ action: 'diagnose', udid: 'PHONE', bundleId: 'com.example.app', run: null });
      expect(diagnosis.artifacts.screenshots).toEqual([diagnosis.evidence.observation.screenshot]);
      expect((await f.invoked()).filter(args => args[1] === 'list')).toHaveLength(1);
      const events = (await readFile(path.join(f.root, '.agemu', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.command === 'diagnose')).toHaveLength(1);
      expect(events.filter(event => event.command === 'observe')).toHaveLength(1);
    } finally { await f.dispose(); }
  }, 20000);

  it('reloads only the configured project server through the wired app handler', async () => {
    const f = await fixture();
    let requestCount = 0;
    const listener = createServer((req, res) => {
      if (req.url === '/status') res.end('packager-status:running');
      else if (req.url === '/reload') { requestCount++; res.end('OK'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    try {
      await writeConfig(f.root, JSON.stringify({ version: 2, platform: 'ios', app: { ...nativeApp, type: 'react-native', root: '.', port }, simulator: { udid: 'PHONE' } }));
      await writeFile(path.join(f.root, 'lsof'), `#!${process.execPath}\nconst args = process.argv.slice(2); process.stdout.write(args.includes('-t') ? '4242\\n' : ${JSON.stringify(`n${await realpath(f.root)}\n`)});\n`, { mode: 0o700 });
      // Exclude macOS's first-launch inspection from the server probe's budget.
      await run(path.join(f.root, 'lsof'), ['-t'], { cwd: f.root, env: f.env });
      const catalog = await f.execute(['commands']);
      expect(catalog.commands.find((command: { command: string }) => command.command === 'app reload').availability.available).toBe(true);
      const result = await f.execute(['app', 'reload']);
      expect(result).toMatchObject({ action: 'reload', reloadRequested: true, port, udid: 'PHONE', bundleId: 'com.example.app', run: null });
      expect(requestCount).toBe(1);
    } finally {
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
      await f.dispose();
    }
  }, 20000);
});
