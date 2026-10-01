import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

type CliResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repository, 'dist/cli/main.js');
const fixtureProject = path.join(repository, 'test/fixtures/NativeFixture/NativeFixture.xcodeproj');
const udid = process.env.AGEMU_NATIVE_SIMULATOR_UDID;
const enabled = process.env.AGEMU_NATIVE === '1' && Boolean(udid);
const root = path.join(repository, '.agemu', 'diagnostics-evidence', udid ?? 'unset');

function run(args: string[]): Promise<CliResult> {
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

describe.skipIf(!enabled)('diagnostics evidence on Simulator', () => {
  let bootedByTest = false;
  let installed = false;

  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, '.agemu.json'), `${JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: fixtureProject, scheme: 'NativeFixture', configuration: 'Debug', bundleId: 'dev.agemu.agemu-native-fixture' },
      simulator: { udid },
    }, null, 2)}\n`);
    const devices = data(await run(['simulator', 'list']), 'simulator list').devices as Array<{ udid: string; state: string }>;
    const selected = devices.find((device) => device.udid === udid);
    if (!selected) throw new Error(`configured simulator ${udid} is not available`);
    const doctor = data(await run(['doctor']), 'doctor');
    if (doctor.ready !== true) throw new Error(`doctor: ${JSON.stringify(doctor.checks)}`);
    // Set before boot so cleanup shuts the Simulator down even if boot itself fails part way.
    bootedByTest = selected.state !== 'Booted';
    const boot = data(await run(['simulator', 'boot']), 'simulator boot');
    expect(boot.device).toMatchObject({ udid, state: 'Booted' });
    data(await run(['build']), 'build');
    data(await run(['app', 'install']), 'app install');
    installed = true;
  }, 900_000);

  afterAll(async () => {
    if (installed) {
      const terminated = await run(['app', 'terminate']);
      if (!terminated.ok) console.error(`app cleanup failed: ${terminated.error.message}`);
    }
    if (bootedByTest) {
      const shutdown = await run(['simulator', 'shutdown']);
      if (!shutdown.ok) console.error(`simulator cleanup failed; retained ${root}: ${shutdown.error.message}`);
    }
  }, 300_000);

  test('finds the fixture crash with its faulting frames', async () => {
    const before = new Set(((data(await run(['crashes', 'list', '--since=5m', '--limit=100']), 'crashes list before').crashes) as Array<{ incidentId: string }>)
      .map((crash) => crash.incidentId));
    // The app crashes during launch, so launch may report success or failure; the crash report is the evidence.
    await run(['app', 'launch', '--env=AGEMU_FIXTURE_CRASH=1']);

    type Frame = { symbol: string | null; sourceFile: string | null; sourceLine: number | null };
    let crashes: Array<{ incidentId: string; exceptionType: string | null; signal: string | null; frames: Frame[]; file: string }> = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const listed = data(await run(['crashes', 'list', '--since=5m', '--limit=100']), 'crashes list');
      crashes = (listed.crashes as typeof crashes).filter((crash) => !before.has(crash.incidentId));
      if (crashes.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(crashes.length).toBeGreaterThan(0);
    const [crash] = crashes;
    // Simulator reports carry no asi for fatalError; the faulting frames identify the call site instead.
    expect(crash).toMatchObject({ exceptionType: 'EXC_BAD_INSTRUCTION', signal: 'SIGILL' });
    expect(crash.frames.some((frame) => frame.symbol?.includes('_assertionFailure'))).toBe(true);
    expect(crash.frames).toContainEqual(expect.objectContaining({
      symbol: expect.stringContaining('AppDelegate'), sourceFile: 'AppDelegate.swift', sourceLine: expect.any(Number),
    }));
    await access(path.join(root, crash.file));

    const invalid = await run(['crashes', 'list', '--since=abc']);
    expect(invalid).toMatchObject({ ok: false, error: { code: 'COMMAND_INVALID' } });
  }, 180_000);
});
