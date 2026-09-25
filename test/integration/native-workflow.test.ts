import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

type CliResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };

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

  await writeFile(path.join(root, '.agemu.json'), `${JSON.stringify({
    version: 1,
    project: fixtureProject,
    scheme: 'NativeFixture',
    configuration: 'Debug',
    bundleId: 'dev.agemu.agemu-native-fixture',
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
}, 180_000);
