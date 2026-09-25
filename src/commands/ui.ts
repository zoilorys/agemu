import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { listDevices, resolveDevice } from '../native/simctl.js';
import { runProcess, type ProcessResult, type RunOptions } from '../process/run-process.js';
import { tryRunIdbPlan } from './idb-ui.js';

export type UiPlan = { version: 1; actions: unknown[] };
export type Point = { x: number; y: number };
export type Swipe = { direction: 'up' | 'down' | 'left' | 'right'; identifier?: string; label?: string } | { from: Point; to: Point };
export type LongPress = { identifier?: string; label?: string; x?: number; y?: number; duration?: number };
type Dependencies = {
  run?: (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  runnerProject?: string;
  now?: () => Date;
  backend?: 'auto' | 'idb' | 'xctest';
};

const bundledRunner = fileURLToPath(new URL('../../runner/AgentRunner.xcodeproj', import.meta.url));

function validatePlan(value: unknown): UiPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('UI_VALIDATION_FAILED', 'The UI plan must be an object');
  const plan = value as Record<string, unknown>;
  if (plan.version !== 1 || !Array.isArray(plan.actions) || plan.actions.length === 0) {
    throw new CliError('UI_VALIDATION_FAILED', 'The UI plan requires version 1 and at least one action');
  }
  const object = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  const point = (item: unknown): item is Point => object(item) && Number.isFinite(item.x) && Number.isFinite(item.y);
  for (const [index, raw] of plan.actions.entries()) {
    if (!object(raw)) continue;
    if ('swipe' in raw) {
      const swipe = raw.swipe;
      const directional = object(swipe) && ['up', 'down', 'left', 'right'].includes(String(swipe.direction))
        && swipe.from === undefined && swipe.to === undefined
        && (swipe.identifier === undefined || typeof swipe.identifier === 'string')
        && (swipe.label === undefined || typeof swipe.label === 'string');
      const coordinates = object(swipe) && swipe.direction === undefined && swipe.identifier === undefined && swipe.label === undefined
        && point(swipe.from) && point(swipe.to)
        && (swipe.from.x !== swipe.to.x || swipe.from.y !== swipe.to.y);
      if (!directional && !coordinates) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: swipe needs a direction or distinct from/to coordinates`);
    }
    if ('longPress' in raw) {
      const press = raw.longPress;
      const target = object(press) && (typeof press.identifier === 'string' || typeof press.label === 'string');
      const coordinates = object(press) && Number.isFinite(press.x) && Number.isFinite(press.y);
      if (!object(press) || (!target && !coordinates) || (press.duration !== undefined && (!Number.isFinite(press.duration) || Number(press.duration) <= 0))) {
        throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: longPress needs a target or coordinates and a positive duration`);
      }
    }
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
  if (manifest) {
    const builtAt = (await stat(manifest)).mtimeMs;
    const sources = [path.join(project, 'project.pbxproj'), path.join(path.dirname(project), 'AgentRunner', 'AgentRunner.swift')];
    const changed = await Promise.all(sources.map(source => stat(source).then(info => info.mtimeMs > builtAt).catch(() => false)));
    if (changed.some(Boolean)) manifest = undefined;
  }
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

export async function runUiPlan(config: LoadedConfig, source: { file: string } | { json: string }, dependencies: Dependencies = {}) {
  const run = dependencies.run ?? runProcess;
  let value: unknown;
  try { value = JSON.parse('file' in source ? await readFile(source.file, 'utf8') : source.json) as unknown; }
  catch (error) { throw new CliError('UI_VALIDATION_FAILED', `Cannot read UI plan: ${error instanceof Error ? error.message : String(error)}`); }
  const plan = validatePlan(value);
  const backend = dependencies.backend ?? 'auto';
  if (!['auto', 'idb', 'xctest'].includes(backend)) throw new CliError('UI_VALIDATION_FAILED', 'UI backend must be auto, idb, or xctest');
  const runStarted = Date.now();
  const now = dependencies.now?.() ?? new Date();
  const directory = path.join(config.root, '.agemu', 'runs', now.toISOString().replaceAll(':', '-'));
  await mkdir(directory, { recursive: true });
  const udid = await (dependencies.resolveUdid?.(config)
    ?? (config.simulator.udid || listDevices().then(devices => resolveDevice(devices, config.simulator).udid)));
  if (backend !== 'xctest') {
    const fast = await tryRunIdbPlan(config, plan, udid, directory, run);
    if (fast) return { ...fast, durationMs: Date.now() - runStarted };
    if (backend === 'idb') throw new CliError('UI_DELIVERY_FAILED', 'idb is unavailable or the UI plan is incompatible with idb');
  }
  const built = await buildUiRunner(config, { ...dependencies, resolveUdid: async () => udid });
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
    backend: 'xctest', runnerCached: built.cached, durationMs: Date.now() - runStarted,
    actions: plan.actions.length, runnerResult, resultBundle: path.relative(config.root, resultBundle), transcript: path.relative(config.root, transcript),
  };
}
