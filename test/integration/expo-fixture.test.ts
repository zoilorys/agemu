import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

type CliResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
type JsMessage = { level: string; text: string };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repository, 'dist/cli/main.js');
const fixture = path.join(repository, 'test/fixtures/ExpoFixture');
const enabled = process.env.AGEMU_EXPO_FIXTURE === '1';
const mode = process.env.AGEMU_EXPO_MODE ?? 'development-build';
const port = Number(process.env.AGEMU_EXPO_PORT ?? 8088);
const bundleId = 'dev.agemu.expo-fixture';
const expoGoHost = 'host.exp.Exponent';

// Vitest sets NODE_ENV=test, which makes the Expo dev server refuse to start; run agemu as a user shell would.
const userEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_ENV' && !name.startsWith('VITEST')));

function run(root: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: userEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(stdout) as CliResult); }
      catch { reject(new Error(`agemu ${args.join(' ')} returned invalid JSON. stderr: ${stderr}`)); }
    });
  });
}

function data(result: CliResult, step: string): Record<string, unknown> {
  if (!result.ok) throw new Error(`${step}: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details ?? {}).slice(0, 2000)}`);
  return result.data;
}

const plan = (actions: unknown[]) => `--plan-json=${JSON.stringify({ version: 1, actions })}`;
const ui = (root: string, step: string, actions: unknown[]) =>
  run(root, ['ui', 'run', '--backend=xctest', '--timeout=600', plan(actions)]).then((result) => data(result, step));

type Node = { identifier?: string; label?: string; type?: string };
function nodes(inspection: unknown): Node[] {
  const found: Node[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      found.push(value as Node);
      Object.values(value).forEach(visit);
    }
  };
  visit(inspection);
  return found;
}

function label(inspection: unknown, identifier: string): string {
  const found = nodes(inspection).filter((node) => node.identifier === identifier && typeof node.label === 'string');
  if (found.length !== 1) throw new Error(`expected one ${identifier} element, found ${found.length}`);
  return found[0].label!;
}

function pngSize(file: Buffer): { width: number; height: number } {
  expect(file.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(file.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

test.skipIf(!enabled)(`proves the public Expo ${mode} workflow on the fixture`, async () => {
  const udid = process.env.AGEMU_EXPO_SIMULATOR_UDID;
  if (!udid) throw new Error('set AGEMU_EXPO_SIMULATOR_UDID to the Simulator assigned to this fixture run');
  if (mode !== 'development-build' && mode !== 'expo-go') throw new Error('AGEMU_EXPO_MODE must be development-build or expo-go');
  await access(path.join(fixture, 'node_modules/expo/package.json')).catch(() => {
    throw new Error('install fixture dependencies first: npm ci --prefix test/fixtures/ExpoFixture');
  });

  const root = path.join(repository, '.agemu', 'expo-fixture', udid, mode);
  await mkdir(root, { recursive: true });
  const token = `run-${randomUUID().slice(0, 8)}`;
  let bootedByTest = false;
  let launched = false;
  let serverStarted = false;
  let installedByTest = false;

  await writeFile(path.join(root, '.agemu.json'), `${JSON.stringify({
    version: 2, platform: 'ios',
    app: { type: 'expo', root: fixture, port, launchTarget: mode, ...(mode === 'expo-go' ? { hostBundleId: expoGoHost } : { bundleId }) },
    simulator: { udid },
  }, null, 2)}\n`);

  try {
    const devices = data(await run(root, ['simulator', 'list']), 'simulator list').devices as Array<{ udid: string; state: string }>;
    const selected = devices.find((device) => device.udid === udid);
    if (!selected) throw new Error(`Simulator ${udid} is not available`);
    const doctor = data(await run(root, ['doctor']), 'doctor');
    expect(doctor.ready, JSON.stringify(doctor.checks)).toBe(true);

    data(await run(root, ['simulator', 'boot']), 'simulator boot');
    bootedByTest = selected.state !== 'Booted';
    const installed = (data(await run(root, ['app', 'list']), 'app list').apps as Array<{ bundleId: string }>).map((app) => app.bundleId);

    if (mode === 'development-build') {
      const build = data(await run(root, ['build']), 'build');
      expect(build).toMatchObject({ appType: 'expo', bundleId, udid, executableName: 'ExpoFixture' });
      data(await run(root, ['app', 'install']), 'app install');
      installedByTest = !installed.includes(bundleId);
    } else {
      if (!installed.includes(expoGoHost)) throw new Error(`Expo Go is not installed on ${udid}; see test/fixtures/ExpoFixture/README.md`);
      expect(await run(root, ['build'])).toMatchObject({ ok: false, error: { code: 'WORKFLOW_UNSUPPORTED' } });
    }

    const before = data(await run(root, ['server', 'status']), 'server status before start');
    expect(before).toMatchObject({ running: false, owned: false, port });
    expect(before, `port ${port} is occupied by another process`).not.toHaveProperty('collision');
    const started = data(await run(root, ['server', 'start']), 'server start');
    serverStarted = true;
    expect(started).toMatchObject({ running: true, owned: true, reused: false, port });
    expect(data(await run(root, ['server', 'status']), 'server status')).toMatchObject({ running: true, owned: true, port, pid: started.pid });

    // `app launch` alone must get past iOS's first "Open in …?" prompt for the project scheme.
    data(await run(root, ['app', 'launch']), 'app launch');
    launched = true;
    // The first bundle can take minutes on a cold Metro cache.
    const opened = await ui(root, 'wait for fixture UI', [{ wait: { identifier: 'fixtureTitle', timeout: 300 } }, { inspect: {} }]);
    // Expo Go shows its developer-menu introduction once per install; the development build disables it in app.json.
    // Its dismissed sheet can leave an empty accessibility snapshot, so relaunch from the settled host.
    if (nodes(opened.inspections).some((node) => node.type === 'button' && node.label === 'Continue')) {
      data(await run(root, ['ui', 'tap', '--backend=xctest', '--label=Continue', '--type=button']), 'dismiss Expo Go introduction');
      data(await run(root, ['app', 'restart']), 'app restart after introduction');
      await ui(root, 'wait for relaunched fixture UI', [{ wait: { identifier: 'fixtureTitle', timeout: 120 } }]);
    }
    const loaded = await ui(root, 'fixture UI', [
      { assertText: { identifier: 'fixtureTitle', equals: 'agemu Expo fixture' } },
      { assertText: { identifier: 'counterValue', equals: 'count:0' } },
      { assertText: { identifier: 'savedValue', equals: 'saved:(none)' } },
      { inspect: {} },
    ]);
    const session = label(loaded.inspections, 'sessionValue');
    expect(session).toMatch(/^session:[a-z0-9]+$/);

    const observed = data(await run(root, ['observe']), 'observe');
    const screenshot = await readFile(path.join(root, String(observed.screenshot)));
    const size = pngSize(screenshot);
    expect(size.width).toBeGreaterThan(300);
    expect(size.height).toBeGreaterThan(size.width);

    const interacted = await ui(root, 'interact', [
      { type: { identifier: 'draftInput', text: token } },
      { tap: { identifier: 'saveButton' } },
      { assertText: { identifier: 'savedValue', equals: `saved:${token}` } },
      { tap: { identifier: 'incrementButton' } },
      { tap: { identifier: 'incrementButton' } },
      { assertText: { identifier: 'counterValue', equals: 'count:2' } },
      { screenshot: { name: 'interacted' } },
    ]);
    const shot = await readFile(path.join(root, (interacted.screenshots as string[])[0]));
    expect(pngSize(shot)).toEqual(size);
    expect(shot.equals(screenshot)).toBe(false);

    // Capture starts first; the app's 3 s probe burst outlasts the tap, so later ticks land inside the capture.
    const capture = run(root, ['logs', 'js', '--duration=90s', `--until=^agemu-expo-probe:done:${token}$`]);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    data(await run(root, ['ui', 'tap', '--backend=xctest', '--id=probeButton']), 'tap probe');
    const logs = data(await capture, 'logs js');
    expect(logs).toMatchObject({ stoppedBy: 'until', matched: true, matchedMessage: `agemu-expo-probe:done:${token}`, bundleId: mode === 'expo-go' ? expoGoHost : bundleId, port });
    const messages = logs.messages as JsMessage[];
    const probes = messages.filter((message) => message.text.startsWith('agemu-expo-probe:'));
    for (const level of ['log', 'warn', 'error']) {
      expect(probes).toContainEqual(expect.objectContaining({ level, text: `agemu-expo-probe:${level}:${token}:10` }));
    }
    expect(probes.every((message) => message.text.includes(token))).toBe(true);
    const persisted = (await readFile(path.join(root, String(logs.artifact)), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as JsMessage);
    expect(persisted.map((message) => message.text)).toContain(`agemu-expo-probe:done:${token}`);
    await ui(root, 'probe status', [{ assertText: { identifier: 'probeStatus', equals: 'probe:done:10' } }]);

    const reloaded = data(await run(root, ['app', 'reload']), 'app reload');
    expect(reloaded).toMatchObject({ reloadRequested: true, port });
    const after = await ui(root, 'observe reload', [
      { wait: { label: 'count:0', timeout: 120 } },
      { assertText: { identifier: 'savedValue', equals: 'saved:(none)' } },
      { assertText: { identifier: 'probeStatus', equals: 'probe:idle' } },
      { inspect: {} },
    ]);
    const reloadedSession = label(after.inspections, 'sessionValue');
    expect(reloadedSession).toMatch(/^session:[a-z0-9]+$/);
    expect(reloadedSession).not.toBe(session);

    data(await run(root, ['app', 'terminate']), 'app terminate');
    launched = false;
    expect(data(await run(root, ['server', 'stop']), 'server stop')).toMatchObject({ stopped: true, port });
    serverStarted = false;
    expect(data(await run(root, ['server', 'status']), 'server status after stop')).toMatchObject({ running: false, owned: false });
  } finally {
    const cleanup = async (step: string, args: string[]) => {
      const result = await run(root, args);
      if (!result.ok) console.error(`${step} failed; evidence retained at ${root}: ${result.error.message}`);
    };
    if (launched) await cleanup('app terminate', ['app', 'terminate']);
    if (serverStarted) await cleanup('server stop', ['server', 'stop']);
    if (installedByTest) await cleanup('app uninstall', ['app', 'uninstall', '--yes']);
    if (bootedByTest) await cleanup('simulator shutdown', ['simulator', 'shutdown']);
  }
}, 3_600_000);
