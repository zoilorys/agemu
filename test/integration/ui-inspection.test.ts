import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

type CliResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repository, 'dist/cli/main.js');
const fixtureProject = path.join(repository, 'test/fixtures/NativeFixture/NativeFixture.xcodeproj');
const udid = process.env.AGEMU_NATIVE_SIMULATOR_UDID ?? '';
const enabled = process.env.AGEMU_NATIVE === '1' && udid !== '';
const root = path.join(repository, '.agemu', 'ui-inspection', udid);

const springboardRoot = `${root}-springboard`;

function run(args: string[], cwd: string = root): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

describe.skipIf(!enabled)('ui inspection fixture', () => {
  let bootedByTest = false;

  beforeAll(async () => {
    const config = (bundleId: string) => `${JSON.stringify({
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: fixtureProject,
      scheme: 'NativeFixture',
      configuration: 'Debug',
      bundleId },
      simulator: { udid },
    }, null, 2)}\n`;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, '.agemu.json'), config('dev.agemu.agemu-native-fixture'));
    await mkdir(springboardRoot, { recursive: true });
    await writeFile(path.join(springboardRoot, '.agemu.json'), config('com.apple.springboard'));

    const listed = data(await run(['simulator', 'list']), 'simulator list');
    const selected = (listed.devices as Array<{ udid: string; state: string }>).find((device) => device.udid === udid);
    if (!selected) throw new Error(`simulator ${udid} is not available`);
    bootedByTest = selected.state !== 'Booted';
    data(await run(['simulator', 'boot']), 'simulator boot');
    data(await run(['build']), 'build');
    data(await run(['app', 'install']), 'app install');
  }, 300_000);

  afterAll(async () => {
    const terminated = await run(['app', 'terminate']);
    if (!terminated.ok) console.error(`app terminate failed: ${terminated.error.message}`);
    if (bootedByTest) {
      const shutdown = await run(['simulator', 'shutdown']);
      if (!shutdown.ok) console.error(`simulator shutdown failed: ${shutdown.error.message}`);
    }
  }, 120_000);

  test('inspects the fixture as a normalized element list through XCTest', async () => {
    const inspected = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ launch: {} }, { inspect: {} }],
    })]), 'ui run inspect');
    const inspections = (inspected.runnerResult as { inspections: Array<{ index: number; elements: Array<Record<string, unknown>> }> }).inspections;
    expect(inspections.map(inspection => inspection.index)).toEqual([1]);
    const elements = inspections[0]!.elements;
    expect(elements).toContainEqual(expect.objectContaining({ type: 'textField', identifier: 'nameField', visible: true }));
    expect(elements).toContainEqual(expect.objectContaining({ identifier: 'row', label: 'Item 24', visible: false }));
  }, 300_000);

  // Relies on the app launched by the previous test; leaves it terminated (the next test launches it).
  test('ui inspect reads the running fixture and asks for a launch when it is not running', async () => {
    type Inspected = { elements: Array<Record<string, unknown>>; counts: { total: number; visible: number }; screenshot?: string };
    const visible = data(await run(['ui', 'inspect', '--backend=xctest']), 'ui inspect') as unknown as Inspected;
    expect(visible.elements).toContainEqual(expect.objectContaining({ identifier: 'saveButton', visible: true }));
    expect(visible.elements).not.toContainEqual(expect.objectContaining({ label: 'Item 24' }));
    expect(visible.screenshot).toEqual(expect.any(String));

    const all = data(await run(['ui', 'inspect', '--backend=xctest', '--all']), 'ui inspect --all') as unknown as Inspected;
    expect(all.elements).toContainEqual(expect.objectContaining({ label: 'Item 24', visible: false }));
    expect(all.counts.total).toBeGreaterThan(all.counts.visible);

    data(await run(['app', 'terminate']), 'app terminate');
    const stopped = await run(['ui', 'inspect', '--backend=xctest']);
    expect(stopped).toMatchObject({ ok: false, error: { code: 'UI_DELIVERY_FAILED', message: expect.stringContaining('Launch the app first') } });
  }, 600_000);

  test('targets elements by labelContains and index', async () => {
    const targeted = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { tap: { labelContains: 'Save', index: 1 } },
        { assertValue: { identifier: 'gestureStatus', value: 'draft' } },
        { assertExists: { identifier: 'row', index: 24 } },
      ],
    })]), 'ui run targeting');
    expect(targeted).toMatchObject({ backend: 'xctest', runnerResult: { completed: 4 } });

    const offscreen = await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ assertVisible: { identifier: 'row', index: 24 } }],
    })]);
    expect(offscreen).toMatchObject({ ok: false, error: { code: 'UI_DELIVERY_FAILED', details: { failedAction: { index: 0, kind: 'assertVisible', message: expect.stringContaining('exists but not hittable') } } } });
  }, 300_000);

  test('types, taps, and opens URLs in the fixture', async () => {
    const typed = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { type: { identifier: 'nameField', text: 'Ada' } },
        { tap: { identifier: 'saveButton' } },
        { assertValue: { identifier: 'gestureStatus', value: 'saved:Ada' } },
      ],
    })]), 'ui run type and tap');
    expect(typed).toMatchObject({ backend: 'xctest', runnerResult: { completed: 4 } });

    data(await run(['app', 'open-url', '--url=agemufixture://hello/world']), 'app open-url');
    // iOS shows a SpringBoard "Open in ..." prompt only the first time a scheme is opened; the URL is
    // delivered after Open is tapped. Later opens skip it, so a missing prompt is not a failure.
    const prompt = await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ tap: { label: 'Open' } }, { wait: { duration: 1 } }],
    })], springboardRoot);
    if (!prompt.ok && !prompt.error.message.includes('No matches found')) {
      throw new Error(`ui run accept open-url prompt: ${prompt.error.code}: ${prompt.error.message}`);
    }
    const opened = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { wait: { duration: 1 } },
        { assertValue: { identifier: 'gestureStatus', value: 'opened:hello/world' } },
      ],
    })]), 'ui run after open-url');
    expect(opened).toMatchObject({ backend: 'xctest', runnerResult: { completed: 2 } });
  }, 300_000);

  test('opens a deep link and terminates the app within a plan', async () => {
    const opened = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { openUrl: { url: 'agemufixture://deep/link' } },
        { wait: { duration: 1 } },
        { assertValue: { identifier: 'gestureStatus', value: 'opened:deep/link' } },
        { terminate: {} },
        { assertNotVisible: { identifier: 'saveButton' } },
      ],
    })]), 'ui run openUrl and terminate');
    expect(opened).toMatchObject({ backend: 'xctest', runnerResult: { completed: 6 } });
  }, 300_000);

  test('scrolls a list until a row is visible and asserts text', async () => {
    const scrolled = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { scrollUntilVisible: { target: { label: 'Item 24' }, in: { identifier: 'resultsList' } } },
        { assertVisible: { label: 'Item 24' } },
        { assertText: { label: 'Item 24', matches: '^Item \\d+$' } },
      ],
    })]), 'ui run scrollUntilVisible and assertText');
    expect(scrolled).toMatchObject({ backend: 'xctest', runnerResult: { completed: 4 } });

    const mismatch = await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ launch: {} }, { assertText: { identifier: 'gestureStatus', equals: 'wrong' } }],
    })]);
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'UI_DELIVERY_FAILED', details: { failedAction: {
      index: 1, kind: 'assertText', message: expect.stringMatching(/^text does not match: expected equals wrong, got idle/),
    } } } });
  }, 600_000);

  test('clears a field whose text equals its placeholder', async () => {
    const cleared = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { type: { identifier: 'nameField', text: 'Name' } },
        { clear: { identifier: 'nameField' } },
        { type: { identifier: 'nameField', text: 'Bo' } },
        { pressKey: { key: 'return' } },
        { tap: { identifier: 'saveButton' } },
        { assertValue: { identifier: 'gestureStatus', value: 'saved:Bo' } },
      ],
    })]), 'ui run clear placeholder text');
    expect(cleared).toMatchObject({ backend: 'xctest', runnerResult: { completed: 7 } });
  }, 300_000);

  // Must stay last: it leaves the app backgrounded.
  test('clears a field, presses return, and presses Home', async () => {
    const edited = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [
        { launch: {} },
        { type: { identifier: 'nameField', text: 'Ada' } },
        { clear: { identifier: 'nameField' } },
        { type: { identifier: 'nameField', text: 'Bo' } },
        { pressKey: { key: 'return' } },
        { tap: { identifier: 'saveButton' } },
        { assertValue: { identifier: 'gestureStatus', value: 'saved:Bo' } },
      ],
    })]), 'ui run clear and return');
    expect(edited).toMatchObject({ backend: 'xctest', runnerResult: { completed: 7 } });

    // Home backgrounds the app; later tests must start with launch.
    const home = data(await run(['ui', 'run', '--backend=xctest', '--plan-json=' + JSON.stringify({
      version: 1, actions: [{ launch: {} }, { pressButton: { button: 'home' } }, { assertNotVisible: { identifier: 'saveButton' } }],
    })]), 'ui run home');
    expect(home).toMatchObject({ backend: 'xctest', runnerResult: { completed: 3 } });
  }, 600_000);
});
