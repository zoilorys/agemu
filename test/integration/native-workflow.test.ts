import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { writeConfig } from '../helpers/config.js';

type CliResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repository, 'dist/cli/main.js');
const fixtureProject = path.join(repository, 'test/fixtures/NativeFixture/NativeFixture.xcodeproj');
const enabled = process.env.AGEMU_NATIVE === '1';

function run(root: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(stdout) as CliResult); }
      catch { reject(new Error(`agemu returned invalid JSON. stderr: ${stderr}`)); }
    });
  });
}

function data(result: CliResult, step: string): Record<string, unknown> {
  if (!result.ok) throw new Error(`${step}: ${result.error.code}: ${result.error.message}`);
  return result.data;
}

test.skipIf(!enabled)('proves the public native workflow', async (context) => {
  const udid = process.env.AGEMU_NATIVE_SIMULATOR_UDID;
  if (!udid) context.skip('set AGEMU_NATIVE_SIMULATOR_UDID to one available iOS Simulator UDID');

  const root = path.join(repository, '.agemu', 'native-workflow', udid);
  await mkdir(root, { recursive: true });
  const runId = randomUUID();
  let launched = false;
  let bootedByTest = false;
  let retainEvidence = false;
  let evidence = root;

  await writeConfig(root, `${JSON.stringify({
    version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: fixtureProject,
    scheme: 'NativeFixture',
    configuration: 'Debug',
    bundleId: 'dev.agemu.agemu-native-fixture' },
    simulator: { udid },
  }, null, 2)}\n`);

  try {
    const listed = await run(root, ['simulator', 'list']);
    if (!listed.ok) context.skip(`Xcode Simulator tools unavailable: ${listed.error.message}`);
    const devices = listed.data.devices as Array<{ udid: string; state: string }>;
    const selected = devices.find((device) => device.udid === udid);
    if (!selected) {
      context.skip(`configured simulator ${udid} is not available in an installed iOS runtime`);
    }

    const doctor = data(await run(root, ['doctor']), 'doctor');
    if (doctor.ready !== true) {
      const checks = doctor.checks as Record<string, { ok: boolean; message: string }>;
      const missing = ['xcode', 'simctl', 'simulator'].filter((name) => checks[name]?.ok === false);
      if (missing.length > 0) context.skip(`native prerequisite unavailable: ${missing.map((name) => `${name}: ${checks[name].message}`).join('; ')}`);
      throw new Error(`doctor: ${JSON.stringify(checks)}`);
    }

    const boot = data(await run(root, ['simulator', 'boot']), 'simulator boot');
    expect((boot.device as { udid: string; state: string })).toMatchObject({ udid, state: 'Booted' });
    bootedByTest = selected.state !== 'Booted';

    const build = data(await run(root, ['build']), 'build');
    retainEvidence = true;
    expect(build).toMatchObject({ bundleId: 'dev.agemu.agemu-native-fixture', udid });
    data(await run(root, ['app', 'install']), 'app install');
    data(await run(root, ['app', 'launch', `--env=AGEMU_NATIVE_RUN_ID=${runId}`]), 'app launch');
    launched = true;

    const status = data(await run(root, ['app', 'status']), 'app status');
    expect(status).toMatchObject({ action: 'status', udid, bundleId: 'dev.agemu.agemu-native-fixture', running: true, foreground: null, run: null });
    expect(status.pid).toBeGreaterThan(0);
    expect(status.capturedAt).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
    const inventory = data(await run(root, ['app', 'list']), 'app list');
    expect(inventory).toMatchObject({ action: 'list', udid, bundleId: null });
    expect(inventory.apps).toEqual(expect.arrayContaining([expect.objectContaining({ bundleId: 'dev.agemu.agemu-native-fixture', executableName: 'NativeFixture' })]));
    const priorClipboard = data(await run(root, ['clipboard', 'read']), 'clipboard read before').text as string;
    const text = '第一行\n$HOME; $(false)\n';
    try {
      expect(data(await run(root, ['clipboard', 'write', `--text=${text}`]), 'clipboard write')).toMatchObject({ action: 'write', udid });
      expect(data(await run(root, ['clipboard', 'read']), 'clipboard roundtrip').text).toBe(text);
    } finally { data(await run(root, ['clipboard', 'write', `--text=${priorClipboard}`]), 'clipboard restore'); }

    const shortcut = data(await run(root, ['ui', 'tap', '--backend=xctest', '--id=saveDraftButton']), 'ui tap shortcut');
    expect(shortcut).toMatchObject({ backend: 'xctest', actions: 1, completed: 1, screenshots: [], recordings: [], inspections: [] });
    data(await run(root, ['ui', 'assert-value', '--backend=xctest', '--id=gestureStatus', '--value=draft']), 'ui assertion shortcut');
    data(await run(root, ['app', 'restart', `--env=AGEMU_NATIVE_RUN_ID=${runId}`]), 'restore fixture before gestures');

    const observation = data(await run(root, ['observe']), 'observe');
    const screenshot = path.join(root, String(observation.screenshot));
    expect((await stat(screenshot)).size).toBeGreaterThan(0);
    evidence = path.join(root, String(observation.run));

    let logs: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      logs = data(await run(root, ['logs', 'show', '--last=1m', '--level=info', '--limit=200']), 'logs show');
      if ((logs.logs as string[]).some((line) => line.includes(`agemu-native-run:${runId}`))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(logs?.logs).toEqual(expect.arrayContaining([expect.stringContaining(`agemu-native-run:${runId}`)]));
    await access(path.join(root, String(logs?.artifact)));

    const gestures = data(await run(root, ['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { swipe: { identifier: 'resultsList', direction: 'up' } },
        { assertValue: { identifier: 'gestureStatus', value: 'scrolled' } },
        { longPress: { identifier: 'pressTarget', duration: 1 } },
        { assertValue: { identifier: 'gestureStatus', value: 'pressed' } },
        { launch: {} },
        { swipe: { from: { x: 120, y: 650 }, to: { x: 120, y: 250 } } },
        { assertValue: { identifier: 'gestureStatus', value: 'scrolled' } },
        { longPress: { x: 120, y: 125, duration: 1 } },
        { assertValue: { identifier: 'gestureStatus', value: 'pressed' } },
        { screenshot: { name: 'after' } },
      ],
    })]), 'ui run gestures');
    expect(gestures).toMatchObject({ backend: 'xctest', runnerResult: { completed: 10 } });
    expect(gestures.screenshots).toEqual([`${String(gestures.run)}/screenshots/9-after.png`]);
    const shot = await readFile(path.join(root, (gestures.screenshots as string[])[0]));
    expect(shot.length).toBeGreaterThan(0);
    expect(shot.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const videos = data(await run(root, ['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { startVideoRecording: { name: 'scroll' } },
        { swipe: { identifier: 'resultsList', direction: 'up' } },
        { assertValue: { identifier: 'gestureStatus', value: 'scrolled' } },
        { wait: { duration: 1 } },
        { stopVideoRecording: {} },
        { startVideoRecording: { name: 'press' } },
        { longPress: { identifier: 'pressTarget', duration: 1 } },
        { assertValue: { identifier: 'gestureStatus', value: 'pressed' } },
        { wait: { duration: 1 } },
        { stopVideoRecording: {} },
      ],
    })]), 'ui run videos');
    expect(videos).toMatchObject({ backend: 'xctest', completed: 11, actions: 11, runnerResult: { completed: 11 }, screenshots: [], inspections: [] });
    expect(videos).not.toHaveProperty('screenshotExportError');
    const recordings = videos.recordings as string[];
    expect(recordings).toHaveLength(2);
    for (const file of recordings) {
      const recording = await readFile(path.join(root, file));
      expect(recording.length).toBeGreaterThan(1000);
      expect(recording.subarray(4, 8).toString('ascii')).toBe('ftyp');
      expect(recording.includes(Buffer.from('moov'))).toBe(true);
      expect(recording.includes(Buffer.from('mdat'))).toBe(true);
    }
    expect(videos.artifacts).toMatchObject({ recordings, screenshots: [] });

    const failed = await run(root, ['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { wait: { identifier: 'missing', timeout: 1 } },
        { longPress: { identifier: 'pressTarget', duration: 1 } },
      ],
    })]);
    expect(failed).toMatchObject({ ok: false, error: { code: 'UI_DELIVERY_FAILED',
      details: { failedAction: { index: 1, kind: 'wait' }, completed: 1 } } });
    const failureShot = (failed as { error: { details: { failureScreenshot: string } } }).error.details.failureScreenshot;
    expect(path.basename(failureShot)).toBe('failure.png');
    expect((await stat(path.join(root, failureShot))).size).toBeGreaterThan(0);
    const untouched = data(await run(root, ['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ assertValue: { identifier: 'gestureStatus', value: 'idle' } }],
    })]), 'ui run after failure');
    expect(untouched).toMatchObject({ backend: 'xctest', runnerResult: { completed: 1 }, screenshots: [] });
    expect(untouched).not.toHaveProperty('screenshotExportError');

    // Item 24 sits at y=1440 in the 1500-pt scroll view, below the visible area after launch.
    const offscreen = data(await run(root, ['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ launch: {} }, { assertExists: { label: 'Item 24' } }, { assertNotVisible: { label: 'Item 24' } }],
    })]), 'ui run off-screen assertions');
    expect(offscreen).toMatchObject({ backend: 'xctest', runnerResult: { completed: 3 } });
    const hidden = await run(root, ['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ launch: {} }, { assertVisible: { label: 'Item 24' } }],
    })]);
    expect(hidden).toMatchObject({ ok: false, error: { code: 'UI_DELIVERY_FAILED',
      details: { failedAction: { index: 1, kind: 'assertVisible', message: 'element is not visible: Item 24 (exists but has no on-screen geometry)' } } } });

    data(await run(root, ['app', 'terminate']), 'app terminate');
    launched = false;
    if (bootedByTest) {
      const shutdown = data(await run(root, ['simulator', 'shutdown']), 'simulator shutdown');
      expect((shutdown.device as { udid: string; state: string })).toMatchObject({ udid, state: 'Shutdown' });
      bootedByTest = false;
    }
    retainEvidence = false;
  } finally {
    if (launched) {
      const terminated = await run(root, ['app', 'terminate']);
      if (!terminated.ok) console.error(`cleanup failed; retained ${root}: ${terminated.error.message}`);
      else launched = false;
    }
    if (bootedByTest) {
      const shutdown = await run(root, ['simulator', 'shutdown']);
      if (!shutdown.ok) console.error(`simulator cleanup failed; retained ${root}: ${shutdown.error.message}`);
      else bootedByTest = false;
    }
    if (retainEvidence || launched || bootedByTest) console.error(`native evidence retained at ${evidence}`);
  }
}, 900_000);
