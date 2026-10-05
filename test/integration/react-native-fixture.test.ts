import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

type CliResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
type Element = { identifier?: string; label?: string; value?: string };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repository, 'dist/cli/main.js');
const fixture = path.join(repository, 'test/fixtures/ReactNativeFixture');
const enabled = process.env.AGEMU_REACT_NATIVE_FIXTURE === '1';
const bundleId = 'dev.agemu.react-native-fixture';
const port = 8087;

// Vitest sets NODE_ENV=test; Metro inherits it through agemu and @react-native/dev-middleware then refuses to start.
const { NODE_ENV: _, ...env } = process.env;

function run(root: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(stdout) as CliResult); }
      catch { reject(new Error(`agemu ${args[0]} returned invalid JSON. stderr: ${stderr}`)); }
    });
  });
}

function data(result: CliResult, step: string): Record<string, unknown> {
  if (!result.ok) throw new Error(`${step}: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details ?? {})}`);
  return result.data;
}

async function png(root: string, file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(path.join(root, file));
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function prerequisites(): Promise<void> {
  const missing: string[] = [];
  for (const [file, fix] of [
    [cli, 'pnpm build'],
    [path.join(fixture, 'node_modules/react-native/package.json'), 'npm ci (in the fixture)'],
    [path.join(fixture, 'ios/ReactNativeFixture.xcworkspace'), 'npm run pods (in the fixture)'],
  ] as const) {
    try { await access(file); } catch { missing.push(`${path.relative(repository, file)}: run ${fix}`); }
  }
  const [podfile, manifest] = await Promise.all(['ios/Podfile.lock', 'ios/Pods/Manifest.lock'].map((file) => readFile(path.join(fixture, file), 'utf8').catch(() => '')));
  if (!manifest || podfile !== manifest) missing.push('ios/Pods is missing or stale: run npm run pods (in the fixture)');
  if (missing.length > 0) throw new Error(`React Native fixture prerequisites are missing; see test/fixtures/ReactNativeFixture/README.md:\n${missing.join('\n')}`);
}

test.skipIf(!enabled)('drives the bare React Native fixture through the public CLI', async () => {
  const udid = process.env.AGEMU_REACT_NATIVE_SIMULATOR_UDID;
  if (!udid) throw new Error('set AGEMU_REACT_NATIVE_SIMULATOR_UDID to the iOS Simulator reserved for this suite');
  await prerequisites();

  const root = path.join(repository, '.agemu', 'react-native-fixture', udid);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, '.agemu.json'), `${JSON.stringify({
    version: 2, platform: 'ios',
    app: { type: 'react-native', root: fixture, port, workspace: path.join(fixture, 'ios/ReactNativeFixture.xcworkspace'), scheme: 'ReactNativeFixture', configuration: 'Debug', bundleId },
    simulator: { udid },
  }, null, 2)}\n`);
  const cmd = (args: string[]) => run(root, args);
  const plan = (step: string, actions: unknown[]) => cmd(['ui', 'run', '--backend=xctest', '--timeout=600', `--plan-json=${JSON.stringify({ version: 1, actions })}`]).then((result) => data(result, step));
  const inspect = async () => {
    const result = data(await cmd(['ui', 'inspect', '--backend=xctest', '--timeout=300']), 'ui inspect');
    expect(result).toMatchObject({ udid, bundleId });
    return new Map((result.elements as Element[]).filter((element) => element.identifier).map((element) => [element.identifier!, element.value || element.label]));
  };
  // Typed into the app and echoed by its console probes, so captured messages belong to this run.
  const token = `rn${randomBytes(4).toString('hex')}`;
  let bootedByTest = false;
  let launched = false;
  let serverStarted = false;

  try {
    const devices = data(await cmd(['simulator', 'list']), 'simulator list').devices as Array<{ udid: string; state: string; name: string }>;
    const selected = devices.find((device) => device.udid === udid);
    if (!selected) throw new Error(`Simulator ${udid} is not available in an installed iOS runtime`);
    const doctor = data(await cmd(['doctor']), 'doctor');
    expect(doctor, JSON.stringify(doctor.checks)).toMatchObject({ ready: true });

    const boot = data(await cmd(['simulator', 'boot']), 'simulator boot');
    expect(boot.device).toMatchObject({ udid, state: 'Booted' });
    bootedByTest = selected.state !== 'Booted';

    const build = data(await cmd(['build', '--timeout=3600']), 'build');
    expect(build).toMatchObject({ appType: 'react-native', bundleId, udid, executableName: 'ReactNativeFixture' });
    expect(data(await cmd(['app', 'install']), 'app install')).toMatchObject({ udid, bundleId });
    expect(data(await cmd(['ui', 'build-runner', '--timeout=1800']), 'ui build-runner')).toMatchObject({ udid });

    const before = data(await cmd(['server', 'status']), 'server status before start');
    if (before.collision) throw new Error(`port ${port} is already used by another process; stop it before running this suite`);
    expect(before).toMatchObject({ running: false, owned: false, port });
    const started = data(await cmd(['server', 'start']), 'server start');
    serverStarted = true;
    expect(started).toMatchObject({ running: true, owned: true, reused: false, port });
    expect(data(await cmd(['server', 'status']), 'server status')).toMatchObject({ running: true, owned: true, port, pid: started.pid });

    expect(data(await cmd(['app', 'launch']), 'app launch')).toMatchObject({ udid, bundleId });
    launched = true;
    // The first bundle compiles in Metro; the app renders only after loading it from port 8087.
    const interaction = await plan('ui run interaction', [
      { wait: { identifier: 'fixtureReady', timeout: 240 } },
      { assertText: { identifier: 'counterValue', equals: 'count 0' } },
      { tap: { identifier: 'draftInput' } },
      { type: { identifier: 'draftInput', text: token } },
      { pressKey: { key: 'return' } },
      { tap: { identifier: 'saveButton' } },
      { assertText: { identifier: 'savedValue', equals: `saved ${token}` } },
      { tap: { identifier: 'incrementButton' } },
      { tap: { identifier: 'incrementButton' } },
      { tap: { identifier: 'incrementButton' } },
      { assertText: { identifier: 'counterValue', equals: 'count 3' } },
      { screenshot: { name: 'interacted' } },
    ]);
    expect(interaction).toMatchObject({ backend: 'xctest', udid, completed: 12 });
    const shot = await png(root, (interaction.screenshots as string[])[0]!);
    expect(shot.height).toBeGreaterThan(shot.width);
    const status = data(await cmd(['app', 'status']), 'app status');
    expect(status).toMatchObject({ udid, bundleId, running: true });
    const pid = status.pid as number;
    const loaded = await inspect();
    expect(loaded.get('counterValue')).toBe('count 3');
    expect(loaded.get('savedValue')).toBe(`saved ${token}`);
    const firstLoad = loaded.get('loadId');
    expect(firstLoad).toMatch(/^load [0-9a-z]+$/);

    // logs js returns only messages logged while it is connected, so probe repeatedly during the capture.
    const capture = cmd(['logs', 'js', '--duration=3m', `--until=agemu-rn-probe info ${token} \\d+`, '--limit=50']);
    let captured: CliResult | undefined;
    void capture.then((result) => { captured = result; }, () => undefined);
    for (let attempt = 0; attempt < 4 && !captured; attempt += 1) {
      await plan('ui run console probes', [
        { wait: { duration: 2 } },
        { tap: { identifier: 'consoleProbeButton' } },
        { wait: { duration: 2 } },
        { tap: { identifier: 'consoleProbeButton' } },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const logs = data(await capture, 'logs js');
    expect(logs).toMatchObject({ udid, bundleId, port, matched: true, stoppedBy: 'until' });
    const messages = logs.messages as Array<{ level: string; text: string }>;
    const sequence = /(\d+)$/.exec(String(logs.matchedMessage))![1];
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'log', text: `agemu-rn-probe log ${token} ${sequence}` }),
      expect.objectContaining({ level: 'info', text: `agemu-rn-probe info ${token} ${sequence}` }),
    ]));
    const persisted = (await readFile(path.join(root, String(logs.artifact)), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { text: string });
    expect(persisted.map((message) => message.text)).toContain(`agemu-rn-probe info ${token} ${sequence}`);

    expect(data(await cmd(['app', 'reload']), 'app reload')).toMatchObject({ udid, bundleId, port, reloadRequested: true });
    let reloaded = await inspect();
    for (let attempt = 0; attempt < 3 && reloaded.get('loadId') === firstLoad; attempt += 1) reloaded = await inspect();
    // A JavaScript reload re-evaluates the bundle and resets React state inside the same native process.
    expect(reloaded.get('loadId')).toMatch(/^load [0-9a-z]+$/);
    expect(reloaded.get('loadId')).not.toBe(firstLoad);
    expect(reloaded.get('counterValue')).toBe('count 0');
    expect(reloaded.get('savedValue')).toBe('nothing saved');
    expect(data(await cmd(['app', 'status']), 'app status after reload')).toMatchObject({ running: true, pid });

    const observation = data(await cmd(['observe']), 'observe');
    expect(observation).toMatchObject({ udid });
    const observed = await png(root, String(observation.screenshot));
    expect(observed).toEqual(shot);

    expect(data(await cmd(['app', 'terminate']), 'app terminate')).toMatchObject({ udid, bundleId });
    launched = false;
    expect(data(await cmd(['app', 'status']), 'app status after terminate')).toMatchObject({ running: false });
    expect(data(await cmd(['server', 'stop']), 'server stop')).toMatchObject({ stopped: true, port });
    serverStarted = false;
    const stopped = data(await cmd(['server', 'status']), 'server status after stop');
    expect(stopped).toMatchObject({ running: false, owned: false, port });
    expect(stopped).not.toHaveProperty('collision');
    if (bootedByTest) {
      expect(data(await cmd(['simulator', 'shutdown']), 'simulator shutdown').device).toMatchObject({ udid, state: 'Shutdown' });
      bootedByTest = false;
    }
  } finally {
    if (launched) await cmd(['app', 'terminate']).catch(() => undefined);
    if (serverStarted) await cmd(['server', 'stop']).catch(() => undefined);
    if (bootedByTest) await cmd(['simulator', 'shutdown']).catch(() => undefined);
  }
}, 90 * 60_000);
