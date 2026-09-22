import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { listDevices, resolveDevice } from '../native/simctl.js';
import { runProcess, type ProcessResult } from '../process/run-process.js';

export type UiPlan = { version: 1; actions: unknown[] };
type Dependencies = {
  run?: (executable: string, args: string[]) => Promise<ProcessResult>;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  runnerProject?: string;
  now?: () => Date;
};

const bundledRunner = fileURLToPath(new URL('../../runner/AgentRunner.xcodeproj', import.meta.url));

function validatePlan(value: unknown): UiPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('UI_VALIDATION_FAILED', 'The UI plan must be an object');
  const plan = value as Record<string, unknown>;
  if (plan.version !== 1 || !Array.isArray(plan.actions) || plan.actions.length === 0) {
    throw new CliError('UI_VALIDATION_FAILED', 'The UI plan requires version 1 and at least one action');
  }
  return value as UiPlan;
}

async function findXctestrun(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.xctestrun')) return candidate;
    if (entry.isDirectory()) {
      const nested = await findXctestrun(candidate);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function injectEnvironment(value: unknown, environment: Record<string, string>): number {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) count += injectEnvironment(item, environment);
    return count;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.TestBundlePath === 'string') {
    record.EnvironmentVariables = { ...(record.EnvironmentVariables as Record<string, string> | undefined), ...environment };
    count += 1;
  }
  for (const child of Object.values(record)) count += injectEnvironment(child, environment);
  return count;
}

async function checked(run: NonNullable<Dependencies['run']>, executable: string, args: string[], message: string): Promise<ProcessResult> {
  const result = await run(executable, args);
  if (result.exitCode !== 0) throw new CliError('UI_DELIVERY_FAILED', message, { exitCode: result.exitCode, stderr: result.stderr });
  return result;
}

export async function buildUiRunner(config: LoadedConfig, dependencies: Dependencies = {}, rebuild = false) {
  const run = dependencies.run ?? runProcess;
  const udid = await (dependencies.resolveUdid?.(config)
    ?? (config.simulator.udid || listDevices().then(devices => resolveDevice(devices, config.simulator).udid)));
  const derivedData = path.join(config.root, '.agemu', 'RunnerDerivedData');
  const project = dependencies.runnerProject ?? bundledRunner;
  let manifest = rebuild ? undefined : await findXctestrun(derivedData).catch(() => undefined);
  const cached = Boolean(manifest);
  if (!manifest) {
    await checked(run, 'xcodebuild', [
      '-project', project, '-scheme', 'AgentRunner', '-configuration', 'Debug',
      '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derivedData, 'build-for-testing',
    ], 'Unable to build the XCTest UI runner');
    manifest = await findXctestrun(derivedData);
  }
  if (!manifest) throw new CliError('BUILD_FAILED', 'xcodebuild did not produce an .xctestrun file');
  return { udid, derivedData, manifest, cached };
}

export async function runUiPlan(config: LoadedConfig, planFile: string, dependencies: Dependencies = {}) {
  const run = dependencies.run ?? runProcess;
  let value: unknown;
  try { value = JSON.parse(await readFile(planFile, 'utf8')) as unknown; }
  catch (error) { throw new CliError('UI_VALIDATION_FAILED', `Cannot read UI plan: ${error instanceof Error ? error.message : String(error)}`); }
  const plan = validatePlan(value);
  const built = await buildUiRunner(config, dependencies);
  const now = dependencies.now?.() ?? new Date();
  const directory = path.join(config.root, '.agemu', 'runs', now.toISOString().replaceAll(':', '-'));
  await mkdir(directory, { recursive: true });
  const json = await checked(run, 'plutil', ['-convert', 'json', '-o', '-', built.manifest], 'Unable to read the XCTest run manifest');
  const manifestValue = JSON.parse(json.stdout) as unknown;
  const encodedPlan = Buffer.from(JSON.stringify({ ...plan, bundleId: config.bundleId }), 'utf8').toString('base64');
  if (injectEnvironment(manifestValue, { AGEMU_PLAN_BASE64: encodedPlan }) === 0) {
    throw new CliError('BUILD_FAILED', 'The XCTest run manifest contains no test target');
  }
  const manifest = path.join(path.dirname(built.manifest), `AgentRunner-${process.pid}-${Date.now()}.xctestrun`);
  await writeFile(manifest, JSON.stringify(manifestValue), { mode: 0o600 });
  await checked(run, 'plutil', ['-convert', 'xml1', manifest], 'Unable to write the XCTest run manifest');
  const resultBundle = path.join(directory, 'AgentRunner.xcresult');
  const result = await run('xcodebuild', [
    'test-without-building', '-xctestrun', manifest, '-destination', `platform=iOS Simulator,id=${built.udid}`,
    '-resultBundlePath', resultBundle,
  ]).finally(() => unlink(manifest).catch(() => undefined));
  const transcript = path.join(directory, 'xcodebuild.log');
  await writeFile(transcript, redact(`${result.stdout}${result.stderr}`, config.redactions ?? []), { mode: 0o600 });
  if (result.exitCode !== 0) {
    throw new CliError('UI_DELIVERY_FAILED', 'The XCTest UI plan failed', {
      exitCode: result.exitCode, resultBundle: path.relative(config.root, resultBundle), transcript: path.relative(config.root, transcript),
    });
  }
  const marker = result.stdout.split(/\r?\n/).find(line => line.includes('AGEMU_RESULT:'));
  const runnerResult = marker ? JSON.parse(Buffer.from(marker.slice(marker.indexOf('AGEMU_RESULT:') + 13), 'base64').toString('utf8')) : undefined;
  return {
    run: path.relative(config.root, directory), udid: built.udid, bundleId: redact(config.bundleId, config.redactions ?? []),
    actions: plan.actions.length, runnerResult, resultBundle: path.relative(config.root, resultBundle), transcript: path.relative(config.root, transcript),
  };
}
