import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test, type TestContext } from 'vitest';

// Uses only the Simulator named by AGEMU_NATIVE_SIMULATOR_UDID. Never erase or delete it;
// erase/delete cases must create and remove their own throwaway device.
type CliResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repository, 'dist/cli/main.js');
const fixtureProject = path.join(repository, 'test/fixtures/NativeFixture/NativeFixture.xcodeproj');
const bundleId = 'dev.agemu.agemu-native-fixture';
const udid = process.env.AGEMU_NATIVE_SIMULATOR_UDID;
const enabled = process.env.AGEMU_NATIVE === '1' && !!udid;
const execFileAsync = promisify(execFile);

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

async function installed(): Promise<boolean> {
  return execFileAsync('xcrun', ['simctl', 'get_app_container', udid!, bundleId]).then(() => true, () => false);
}

describe.skipIf(!enabled)('simulator control on a real Simulator', () => {
  const root = path.join(repository, '.agemu', 'simulator-control', udid ?? 'unset');
  let skipReason: string | undefined;
  let bootedByTest = false;

  const ready = (context: TestContext) => { if (skipReason) context.skip(skipReason); };

  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, '.agemu.json'), `${JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: fixtureProject, scheme: 'NativeFixture', configuration: 'Debug', bundleId },
      simulator: { udid },
    }, null, 2)}\n`);

    const listed = await run(root, ['simulator', 'list']);
    if (!listed.ok) { skipReason = `Xcode Simulator tools unavailable: ${listed.error.message}`; return; }
    const selected = (listed.data.devices as Array<{ udid: string; state: string }>).find((device) => device.udid === udid);
    if (!selected) { skipReason = `configured simulator ${udid} is not available in an installed iOS runtime`; return; }

    const doctor = data(await run(root, ['doctor']), 'doctor');
    if (doctor.ready !== true) {
      const checks = doctor.checks as Record<string, { ok: boolean; message: string }>;
      const missing = ['xcode', 'simctl', 'simulator'].filter((name) => checks[name]?.ok === false);
      if (missing.length > 0) { skipReason = `native prerequisite unavailable: ${missing.map((name) => `${name}: ${checks[name].message}`).join('; ')}`; return; }
      throw new Error(`doctor: ${JSON.stringify(checks)}`);
    }

    const boot = data(await run(root, ['simulator', 'boot']), 'simulator boot');
    expect(boot.device).toMatchObject({ udid, state: 'Booted' });
    bootedByTest = selected.state !== 'Booted';
    expect(data(await run(root, ['build']), 'build')).toMatchObject({ bundleId, udid });
    data(await run(root, ['app', 'install']), 'app install');
  }, 900_000);

  afterAll(async () => {
    if (!bootedByTest) return;
    const shutdown = await run(root, ['simulator', 'shutdown']);
    if (!shutdown.ok) console.error(`simulator cleanup failed; retained ${root}: ${shutdown.error.message}`);
  }, 120_000);

  test('app uninstall --yes removes the app and app install restores it', async (context) => {
    ready(context);
    expect(await installed()).toBe(true);
    try {
      expect(data(await run(root, ['app', 'uninstall', '--yes']), 'app uninstall')).toEqual({ action: 'uninstall', udid, bundleId });
      expect(await installed()).toBe(false);
      expect(await run(root, ['app', 'launch'])).toMatchObject({ ok: false, error: { code: 'PROCESS_FAILED' } });
    } finally {
      data(await run(root, ['app', 'install']), 'app install');
    }
    expect(await installed()).toBe(true);
  }, 300_000);

  test('privacy grant then reset photos succeed for the fixture app', async (context) => {
    ready(context);
    expect(data(await run(root, ['privacy', 'grant', '--service=photos']), 'privacy grant')).toMatchObject({ action: 'grant', service: 'photos', udid, bundleId });
    expect(data(await run(root, ['privacy', 'reset', '--service=photos']), 'privacy reset')).toMatchObject({ action: 'reset', service: 'photos', udid, bundleId });
  }, 120_000);

  test('location list is non-empty, and set and clear succeed', async (context) => {
    ready(context);
    const listed = data(await run(root, ['location', 'list']), 'location list');
    const scenarios = listed.scenarios as string[];
    expect(scenarios).toContain('City Run');
    expect(scenarios.some((name) => name === 'Name' || name.startsWith('='))).toBe(false);
    try {
      expect(data(await run(root, ['location', 'set', '--coordinate=37.3349,-122.0090']), 'location set')).toMatchObject({ action: 'set', udid, coordinate: '37.3349,-122.0090' });
    } finally {
      expect(data(await run(root, ['location', 'clear']), 'location clear')).toMatchObject({ action: 'clear', udid });
    }
  }, 120_000);

  test('push delivers a payload to the fixture app and saves it as evidence', async (context) => {
    ready(context);
    const input = '{"aps":{"alert":"agemu"}}';
    const result = data(await run(root, ['push', `--payload-json=${input}`]), 'push');
    expect(result).toMatchObject({ udid, bundleId, bytes: input.length });
    expect(await readFile(path.join(root, result.payload as string), 'utf8')).toBe(input);
  }, 120_000);
});
