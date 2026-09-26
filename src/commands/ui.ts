import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { listDevices, resolveDevice } from '../native/simctl.js';
import { runProcess, type ProcessResult, type RunOptions } from '../process/run-process.js';
import { idbCompatible, tryRunIdbPlan } from './idb-ui.js';
import { createRecordingBridge, startVideoRecording, type Recording } from './video-recording.js';

export type UiPlan = { version: 1; actions: unknown[] };
export type Point = { x: number; y: number };
export type Swipe = ({ direction: 'up' | 'down' | 'left' | 'right'; identifier?: string; label?: string } | { from: Point; to: Point }) & { duration?: number };
export type LongPress = { identifier?: string; label?: string; x?: number; y?: number; duration?: number };
type Dependencies = {
  run?: (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  runnerProject?: string;
  now?: () => Date;
  backend?: 'auto' | 'idb' | 'xctest';
  startRecording?: (udid: string, file: string) => Promise<Recording>;
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
  let recording = false;
  for (const [index, raw] of plan.actions.entries()) {
    if (!object(raw)) continue;
    if ('startVideoRecording' in raw || 'stopVideoRecording' in raw) {
      const keys = Object.keys(raw);
      if (keys.length !== 1 || !object(raw[keys[0]])) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: recording action must contain one object`);
      const value = raw[keys[0]] as Record<string, unknown>;
      if (keys[0] === 'startVideoRecording') {
        if (recording || Object.keys(value).some(key => key !== 'name') || (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim()))) {
          throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: invalid or nested startVideoRecording`);
        }
        recording = true;
      } else {
        if (!recording || Object.keys(value).length !== 0) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: stopVideoRecording has no active recording`);
        recording = false;
      }
      continue;
    }
    if ('swipe' in raw) {
      const swipe = raw.swipe;
      const directional = object(swipe) && ['up', 'down', 'left', 'right'].includes(String(swipe.direction))
        && swipe.from === undefined && swipe.to === undefined
        && (swipe.identifier === undefined || typeof swipe.identifier === 'string')
        && (swipe.label === undefined || typeof swipe.label === 'string');
      const coordinates = object(swipe) && swipe.direction === undefined && swipe.identifier === undefined && swipe.label === undefined
        && point(swipe.from) && point(swipe.to)
        && (swipe.from.x !== swipe.to.x || swipe.from.y !== swipe.to.y);
      if ((!directional && !coordinates) || (object(swipe) && swipe.duration !== undefined && (!Number.isFinite(swipe.duration) || Number(swipe.duration) <= 0))) {
        throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: swipe needs a direction or distinct from/to coordinates and a positive duration`);
      }
    }
    if ('wait' in raw) {
      const wait = raw.wait;
      const target = object(wait) && (typeof wait.identifier === 'string' || typeof wait.label === 'string');
      const pause = object(wait) && wait.identifier === undefined && wait.label === undefined && wait.timeout === undefined
        && typeof wait.duration === 'number' && Number.isFinite(wait.duration) && wait.duration >= 0;
      if (!object(wait) || (!target && !pause) || (target && (wait.duration !== undefined || (wait.timeout !== undefined
        && (typeof wait.timeout !== 'number' || !Number.isFinite(wait.timeout) || wait.timeout < 0))))) {
        throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: wait needs a target and optional timeout, or a nonnegative duration`);
      }
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
  if (recording) throw new CliError('UI_VALIDATION_FAILED', 'Every startVideoRecording needs a matching stopVideoRecording');
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
  if (plan.actions.some(action => typeof action === 'object' && action !== null && 'startVideoRecording' in action)) {
    const segments: Array<{ actions: unknown[]; recording?: 'start' | 'stop'; name?: string }> = [];
    let actions: unknown[] = [];
    for (const raw of plan.actions) {
      const action = raw as Record<string, Record<string, unknown>>;
      if ('startVideoRecording' in action || 'stopVideoRecording' in action) {
        if (actions.length) segments.push({ actions });
        actions = [];
        segments.push('startVideoRecording' in action
          ? { actions: [], recording: 'start', name: action.startVideoRecording.name as string | undefined }
          : { actions: [], recording: 'stop' });
      } else actions.push(raw);
    }
    if (actions.length) segments.push({ actions });
    const actionSegments = segments.filter(segment => !segment.recording);
    const supportsIdb = actionSegments.every(segment => idbCompatible({ version: 1, actions: segment.actions }));
    let useIdb = false;
    if (backend !== 'xctest' && supportsIdb) {
      try {
        const probe = await run('idb', ['ui', 'describe-all', '--api', 'axbridge', '--udid', udid], { timeoutMs: 8_000 });
        useIdb = probe.exitCode === 0 && Array.isArray(JSON.parse(probe.stdout));
      } catch { /* XCTest can run the complete plan. */ }
    }
    if (!useIdb) {
      if (backend === 'idb') throw new CliError('UI_DELIVERY_FAILED', 'idb is unavailable or the UI plan is incompatible with idb');
      const bridge = await createRecordingBridge(udid, directory, config.root, dependencies.startRecording ?? startVideoRecording);
      try {
        const result = await runUiSegment(config, plan, udid, directory, run, 'xctest', dependencies, bridge.port);
        return { ...result, durationMs: Date.now() - runStarted, recordings: bridge.recordings };
      } finally { await bridge.close(); }
    }
    const outputs: Array<Record<string, unknown>> = [];
    const recordings: string[] = [];
    let active: Recording | undefined;
    try {
      for (const [index, segment] of segments.entries()) {
        if (segment.recording === 'start') {
          const name = segment.name?.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'video';
          const file = path.join(directory, `${recordings.length + 1}-${name}.mp4`);
          active = await (dependencies.startRecording ?? startVideoRecording)(udid, file);
          recordings.push(path.relative(config.root, file));
        } else if (segment.recording === 'stop') {
          const recording = active!;
          active = undefined;
          await recording.stop();
        } else {
          const location = path.join(directory, `segment-${index}`);
          await mkdir(location, { recursive: true });
          outputs.push(await runUiSegment(config, { version: 1, actions: segment.actions }, udid, location, run, 'idb', dependencies));
        }
      }
    } finally {
      if (active) await active.stop();
    }
    return { run: path.relative(config.root, directory), udid, actions: plan.actions.length, durationMs: Date.now() - runStarted, recordings, segments: outputs };
  }
  return { ...await runUiSegment(config, plan, udid, directory, run, backend, dependencies), durationMs: Date.now() - runStarted };
}

async function runUiSegment(config: LoadedConfig, plan: UiPlan, udid: string, directory: string,
  run: NonNullable<Dependencies['run']>, backend: 'auto' | 'idb' | 'xctest', dependencies: Dependencies, videoPort?: number) {
  if (backend !== 'xctest') {
    const fast = await tryRunIdbPlan(config, plan, udid, directory, run);
    if (fast) return fast;
    if (backend === 'idb') throw new CliError('UI_DELIVERY_FAILED', 'idb is unavailable or the UI plan is incompatible with idb');
  }
  const built = await buildUiRunner(config, { ...dependencies, resolveUdid: async () => udid });
  const json = await checked(run, 'plutil', ['-convert', 'json', '-o', '-', built.manifest], 'Unable to read the XCTest run manifest');
  const manifestValue = JSON.parse(json.stdout) as unknown;
  const encodedPlan = Buffer.from(JSON.stringify({ ...plan, bundleId: targetBundleId(config) }), 'utf8').toString('base64');
  if (injectEnvironment(manifestValue, { AGEMU_PLAN_BASE64: encodedPlan, ...(videoPort === undefined ? {} : { AGEMU_VIDEO_PORT: String(videoPort) }) }) === 0) {
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
    run: path.relative(config.root, directory), udid: built.udid, bundleId: redact(targetBundleId(config), config.redactions ?? []),
    backend: 'xctest', runnerCached: built.cached,
    actions: plan.actions.length, runnerResult, resultBundle: path.relative(config.root, resultBundle), transcript: path.relative(config.root, transcript),
  };
}
