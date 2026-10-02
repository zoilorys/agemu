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
});
