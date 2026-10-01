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

    // The crash launch is the latest agemu launch, so the launch window holds that crash alone.
    const sinceLaunch = data(await run(['crashes', 'list', '--since=launch', '--limit=100']), 'crashes list --since=launch');
    expect((sinceLaunch.crashes as typeof crashes).map((item) => item.incidentId)).toEqual([crash.incidentId]);

    const invalid = await run(['crashes', 'list', '--since=abc']);
    expect(invalid).toMatchObject({ ok: false, error: { code: 'COMMAND_INVALID' } });
  }, 180_000);

  test('scopes logs to the latest agemu launch', async () => {
    const earlier = `earlier-${Date.now()}`;
    const latest = `latest-${Date.now()}`;
    data(await run(['app', 'restart', `--env=AGEMU_NATIVE_RUN_ID=${earlier}`]), 'app restart (earlier)');
    // Ensure the earlier line falls in an earlier second than the next launch; log show --start has second precision.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    data(await run(['app', 'restart', `--env=AGEMU_NATIVE_RUN_ID=${latest}`]), 'app restart (latest)');

    let logs: string[] = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      logs = data(await run(['logs', 'show', '--since=launch', '--limit=10000']), 'logs show --since=launch').logs as string[];
      if (logs.some((line) => line.includes(`agemu-native-run:${latest}`))) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(logs.some((line) => line.includes(`agemu-native-run:${latest}`))).toBe(true);
    expect(logs.some((line) => line.includes(`agemu-native-run:${earlier}`))).toBe(false);

    const conflicting = await run(['logs', 'show', '--since=launch', '--last=1m']);
    expect(conflicting).toMatchObject({ ok: false, error: { code: 'COMMAND_INVALID' } });
  }, 180_000);

  test('logs stream stops on a live --until match well before the duration', async () => {
    const id = `stream-${Date.now()}`;
    const startedAt = Date.now();
    const streaming = run(['logs', 'stream', '--duration=30s', `--until=agemu-native-run:${id}`]);
    // log stream needs a moment to attach before the line is emitted.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const launched = run(['app', 'restart', `--env=AGEMU_NATIVE_RUN_ID=${id}`]);
    const [streamed, restart] = await Promise.all([streaming, launched]);
    const elapsed = Date.now() - startedAt;
    data(restart, 'app restart');
    const result = data(streamed, 'logs stream');
    expect(result).toMatchObject({ matched: true, stoppedBy: 'until', matchedLine: expect.stringContaining(`agemu-native-run:${id}`) });
    expect(elapsed).toBeLessThan(20_000);
    await access(path.join(root, result.artifact as string));
  }, 120_000);

  test('logs stream returns after the duration without a match and rejects invalid options', async () => {
    const startedAt = Date.now();
    const result = data(await run(['logs', 'stream', '--duration=3s', '--until=agemu-never-matches-[0-9a-f]{40}']), 'logs stream');
    const elapsed = Date.now() - startedAt;
    expect(result).toMatchObject({ matched: false, stoppedBy: 'duration' });
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    // Duration plus the 3 s stop grace, plus CLI startup.
    expect(elapsed).toBeLessThan(10_000);

    expect(await run(['logs', 'stream', '--duration=11m'])).toMatchObject({ ok: false, error: { code: 'COMMAND_INVALID' } });
    expect(await run(['logs', 'stream', '--duration=5s', '--until=('])).toMatchObject({ ok: false, error: { code: 'COMMAND_INVALID' } });
  }, 60_000);
});
