import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { createRun, redactValue } from '../artifacts/runs.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { listDevices, resolveDevice } from '../native/simctl.js';
import { deadline, runProcess, type Deadline, type ProcessResult, type RunOptions } from '../process/run-process.js';
import { idbCompatible, screenshotName, tryRunIdbPlan } from './idb-ui.js';
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
  /** Deadline for the whole command; defaults to 15 minutes. */
  timeoutMs?: number;
  /** Internal: the single `ui run` deadline shared with the runner build. */
  deadline?: Deadline;
};

export const defaultUiTimeoutMs = 900_000;
const runnerBundleId = 'dev.agemu.agemu-agent-runner.xctrunner';

const isTimeout = (error: unknown): error is CliError => error instanceof CliError && error.code === 'PROCESS_TIMEOUT';

const bundledRunner = fileURLToPath(new URL('../../runner/AgentRunner.xcodeproj', import.meta.url));

const targetFields = ['identifier', 'label'];
/** Accepted fields per action kind; every plan action must use exactly one of these kinds. */
const actionFields: Record<string, string[] | undefined> = {
  launch: ['arguments', 'environment'],
  wait: [...targetFields, 'timeout', 'duration'],
  type: [...targetFields, 'text'],
  tap: [...targetFields, 'x', 'y'],
  swipe: [...targetFields, 'direction', 'from', 'to', 'duration'],
  longPress: [...targetFields, 'x', 'y', 'duration'],
  assertVisible: targetFields,
  assertExists: targetFields,
  assertNotVisible: targetFields,
  assertValue: [...targetFields, 'value'],
  screenshot: ['name'],
  inspect: [],
  startVideoRecording: ['name'],
  stopVideoRecording: [],
};
const targetedActions = new Set(['tap', 'type', 'assertVisible', 'assertExists', 'assertNotVisible', 'assertValue']);

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
    const fail = (message: string): never => { throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: ${message}`); };
    if (!object(raw) || Object.keys(raw).length !== 1) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: must contain exactly one action`);
    const [kind] = Object.keys(raw);
    const fields = actionFields[kind];
    if (!fields) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: unknown action ${kind}`);
    const input = raw[kind];
    if (!object(input)) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: ${kind} must be an object`);
    for (const field of Object.keys(input)) if (!fields.includes(field)) fail(`${kind} does not accept ${field}`);
    const optionalString = (field: string) => input[field] === undefined || typeof input[field] === 'string';
    if (targetedActions.has(kind)) {
      const targets = ['identifier', 'label'].filter(field => input[field] !== undefined);
      const targetValid = targets.length === 1 && typeof input[targets[0]] === 'string';
      const coordinates = input.x !== undefined || input.y !== undefined;
      if (kind === 'tap' && coordinates) {
        if (targets.length > 0 || !Number.isFinite(input.x) || !Number.isFinite(input.y)) fail('tap needs one string identifier or label, or finite x and y, not both');
      } else if (!targetValid) fail(`${kind} needs exactly one string identifier or label`);
    }
    if (kind === 'type' && typeof input.text !== 'string') fail('type needs string text');
    if (kind === 'assertValue' && typeof input.value !== 'string') fail('assertValue needs string value');
    if (kind === 'screenshot' && !optionalString('name')) fail('screenshot name must be a string');
    if (kind === 'launch') {
      if (input.arguments !== undefined && (!Array.isArray(input.arguments) || !input.arguments.every(item => typeof item === 'string'))) {
        fail('launch arguments must be an array of strings');
      }
      if (input.environment !== undefined && (!object(input.environment)
        || !Object.entries(input.environment).every(([name, entry]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof entry === 'string'))) {
        fail('launch environment must map valid variable names to strings');
      }
    }
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

const stderrLimit = 4_000;

type Limit = { deadline: Deadline; label: string };

function limitExceeded(limit: Limit, details: Record<string, unknown> = {}): CliError {
  return new CliError('PROCESS_TIMEOUT', `${limit.label} exceeded ${limit.deadline.ms / 1000} s`, { timeoutSeconds: limit.deadline.ms / 1000, ...details });
}

async function checked(run: NonNullable<Dependencies['run']>, executable: string, args: string[], message: string, secrets: string[],
  limit: Limit): Promise<ProcessResult> {
  let result: ProcessResult;
  try { result = await run(executable, args, { timeoutMs: limit.deadline.remaining() }); }
  catch (error) { throw isTimeout(error) ? limitExceeded(limit) : error; }
  if (result.exitCode !== 0) {
    throw new CliError('UI_DELIVERY_FAILED', message, { exitCode: result.exitCode, stderr: redact(result.stderr, secrets).slice(-stderrLimit) });
  }
  return result;
}

export async function buildUiRunner(config: LoadedConfig, dependencies: Dependencies = {}, rebuild = false) {
  const run = dependencies.run ?? runProcess;
  const limit: Limit = dependencies.deadline
    ? { deadline: dependencies.deadline, label: 'UI plan' }
    : { deadline: deadline(dependencies.timeoutMs ?? defaultUiTimeoutMs), label: 'UI runner build' };
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
    ], 'Unable to build the XCTest UI runner', config.redactions ?? [], limit);
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
  const limit = dependencies.deadline ?? deadline(dependencies.timeoutMs ?? defaultUiTimeoutMs);
  const bounded: Dependencies = { ...dependencies, deadline: limit };
  const now = dependencies.now?.() ?? new Date();
  const { directory } = await createRun(config.root, now);
  const udid = await (dependencies.resolveUdid?.(config)
    ?? (config.simulator.udid || listDevices().then(devices => resolveDevice(devices, config.simulator).udid)));
  if (plan.actions.some(action => typeof action === 'object' && action !== null && 'startVideoRecording' in action)) {
    const segments: Array<{ actions: unknown[]; offset: number; recording?: 'start' | 'stop'; name?: string }> = [];
    let actions: unknown[] = [];
    let actionsOffset = 0;
    for (const [planIndex, raw] of plan.actions.entries()) {
      const action = raw as Record<string, Record<string, unknown>>;
      if ('startVideoRecording' in action || 'stopVideoRecording' in action) {
        if (actions.length) segments.push({ actions, offset: actionsOffset });
        actions = [];
        actionsOffset = planIndex + 1;
        segments.push('startVideoRecording' in action
          ? { actions: [], offset: planIndex, recording: 'start', name: action.startVideoRecording.name as string | undefined }
          : { actions: [], offset: planIndex, recording: 'stop' });
      } else actions.push(raw);
    }
    if (actions.length) segments.push({ actions, offset: actionsOffset });
    const actionSegments = segments.filter(segment => !segment.recording);
    const supportsIdb = actionSegments.every(segment => idbCompatible({ version: 1, actions: segment.actions }));
    let useIdb = false;
    if (backend !== 'xctest' && supportsIdb) {
      try {
        const probe = await run('idb', ['ui', 'describe-all', '--api', 'axbridge', '--udid', udid], { timeoutMs: Math.min(8_000, limit.remaining()) });
        useIdb = probe.exitCode === 0 && Array.isArray(JSON.parse(probe.stdout));
      } catch { /* XCTest can run the complete plan. */ }
    }
    if (!useIdb) {
      if (backend === 'idb') throw new CliError('UI_DELIVERY_FAILED', 'idb is unavailable or the UI plan is incompatible with idb');
      const bridge = await createRecordingBridge(udid, directory, config.root, dependencies.startRecording ?? startVideoRecording);
      try {
        const result = await runUiSegment(config, plan, udid, directory, run, 'xctest', bounded, bridge.port);
        return { ...result, durationMs: Date.now() - runStarted, recordings: bridge.recordings };
      } finally { await bridge.close(); }
    }
    const outputs: Array<Record<string, unknown>> = [];
    const recordings: string[] = [];
    let active: Recording | undefined;
    try {
      for (const [index, segment] of segments.entries()) {
        if (segment.recording) {
          const kind = segment.recording === 'start' ? 'startVideoRecording' : 'stopVideoRecording';
          try {
            if (segment.recording === 'start') {
              const name = segment.name?.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'video';
              const file = path.join(directory, `${recordings.length + 1}-${name}.mp4`);
              active = await (dependencies.startRecording ?? startVideoRecording)(udid, file);
              recordings.push(path.relative(config.root, file));
            } else {
              const recording = active!;
              active = undefined;
              await recording.stop();
            }
          } catch (error) {
            const secrets = config.redactions ?? [];
            const failedAction = { index: segment.offset, kind, message: error instanceof Error ? error.message : String(error) };
            throw new CliError('UI_DELIVERY_FAILED', redact(failureMessage(failedAction), secrets),
              redactValue({ failedAction, completed: segment.offset }, secrets));
          }
        } else {
          const location = path.join(directory, `segment-${index}`);
          await mkdir(location, { recursive: true });
          try {
            outputs.push(await runUiSegment(config, { version: 1, actions: segment.actions }, udid, location, run, 'idb', bounded));
          } catch (error) {
            throw offsetFailure(error, segment.offset);
          }
        }
      }
    } finally {
      if (active) await active.stop();
    }
    return redactValue({
      run: path.relative(config.root, directory), udid, actions: plan.actions.length, durationMs: Date.now() - runStarted, recordings, segments: outputs,
    }, config.redactions ?? []);
  }
  return { ...await runUiSegment(config, plan, udid, directory, run, backend, bounded), durationMs: Date.now() - runStarted };
}

export type FailedAction = { index: number; kind: string; message: string };

export function actionKind(action: unknown): string {
  return typeof action === 'object' && action !== null && !Array.isArray(action) ? Object.keys(action)[0] ?? 'unknown' : 'unknown';
}

export function failureMessage(failed: FailedAction): string {
  return `UI action ${failed.index} (${failed.kind}) failed: ${failed.message}`;
}

/** Maps a segment-relative failure to its index in the submitted plan. The message is already redacted. */
function offsetFailure(error: unknown, offset: number): unknown {
  if (!(error instanceof CliError) || !error.details) return error;
  const failed = error.details.failedAction as FailedAction | undefined;
  if (!failed || typeof failed.index !== 'number') return error;
  const failedAction = { ...failed, index: failed.index + offset };
  // A timeout keeps its "UI plan exceeded" message; only the index moves.
  return new CliError(error.code, error.code === 'PROCESS_TIMEOUT' ? error.message : failureMessage(failedAction), {
    ...error.details, failedAction, completed: (typeof error.details.completed === 'number' ? error.details.completed : failed.index) + offset,
  });
}

/** Index from the last `AGEMU_ACTION:<n>` marker the runner printed, if any. */
function lastStarted(stdout: string): number | undefined {
  let index: number | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const started = line.indexOf('AGEMU_ACTION:');
    if (started < 0) continue;
    const match = /^(\d+)/.exec(line.slice(started + 13).trim());
    if (match) index = Number(match[1]);
  }
  return index;
}

function xctestFailedAction(stdout: string, plan: UiPlan): FailedAction | undefined {
  const lines = stdout.split(/\r?\n/);
  const started = lastStarted(stdout);
  let encodedFailure: string | undefined;
  for (const line of lines) {
    const failed = line.indexOf('AGEMU_FAILURE:');
    if (failed >= 0) encodedFailure = line.slice(failed + 14).trim();
  }
  if (encodedFailure) {
    try {
      const value = JSON.parse(Buffer.from(encodedFailure, 'base64').toString('utf8')) as unknown;
      const failure = value as Record<string, unknown>;
      if (failure && Number.isInteger(failure.index) && typeof failure.kind === 'string' && typeof failure.message === 'string') {
        return { index: failure.index as number, kind: failure.kind, message: failure.message };
      }
    } catch { /* Fall back to the last started action. */ }
  }
  if (started === undefined) return undefined;
  const internal = lines.map(line => /error: -\[(?:\w+\.)?AgentRunner testPlan\] : (.+)$/.exec(line)?.[1]).find(Boolean);
  return {
    index: started, kind: actionKind(plan.actions[started]),
    message: internal?.trim() ?? 'XCTest reported a failure; inspect the result bundle',
  };
}

export type ScreenshotExport = { screenshots: string[]; failureScreenshot?: string; screenshotExportError?: string };

/**
 * Exports AgentRunner screenshot attachments from the result bundle to `<directory>/screenshots`, using the idb
 * file naming. Never throws: a failed export yields `screenshotExportError` so it cannot mask the plan outcome.
 */
export async function exportXctestScreenshots(run: NonNullable<Dependencies['run']>, resultBundle: string, directory: string,
  root: string, plan: UiPlan, secrets: string[] = []): Promise<ScreenshotExport> {
  try { await stat(resultBundle); } catch { return { screenshots: [] }; }
  const exported = path.join(directory, 'attachments');
  const target = path.join(directory, 'screenshots');
  try {
    const result = await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', resultBundle, '--output-path', exported], { timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `xcresulttool exited with ${result.exitCode}`);
    let text: string;
    try { text = await readFile(path.join(exported, 'manifest.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { screenshots: [] };
      throw error;
    }
    const manifest = JSON.parse(text) as unknown;
    if (!Array.isArray(manifest)) throw new Error('xcresulttool returned an invalid attachments manifest');
    const shots: Array<{ index: number; file: string }> = [];
    let failureScreenshot: string | undefined;
    for (const test of manifest) {
      const attachments = (test as { attachments?: unknown })?.attachments;
      if (!Array.isArray(attachments)) continue;
      for (const attachment of attachments as Array<Record<string, unknown>>) {
        const name = attachment?.suggestedHumanReadableName;
        const file = attachment?.exportedFileName;
        if (typeof name !== 'string' || typeof file !== 'string' || path.basename(file) !== file) continue;
        let destination: string | undefined;
        const match = /^agemu-(\d+)-([A-Za-z0-9_-]+)/.exec(name);
        if (match) {
          const index = Number(match[1]);
          const action = plan.actions[index] as Record<string, Record<string, unknown>> | undefined;
          if (!action || typeof action !== 'object' || !('screenshot' in action)) continue;
          // Xcode appends suffixes such as `_0_<UUID>.png`; the plan supplies the exact stem.
          const stem = screenshotName(action.screenshot?.name);
          if (!name.startsWith(`agemu-${index}-${stem}`) || shots.some(shot => shot.index === index)) continue;
          destination = path.join(target, `${index}-${stem}.png`);
          shots.push({ index, file: path.relative(root, destination) });
        } else if (/^agemu-failure/.test(name)) {
          destination = path.join(target, 'failure.png');
          failureScreenshot = path.relative(root, destination);
        }
        if (!destination) continue;
        await mkdir(target, { recursive: true });
        await rename(path.join(exported, file), destination);
      }
    }
    shots.sort((left, right) => left.index - right.index);
    return { screenshots: shots.map(shot => shot.file), ...(failureScreenshot ? { failureScreenshot } : {}) };
  } catch (error) {
    return { screenshots: [], screenshotExportError: redact(error instanceof Error ? error.message : String(error), secrets) };
  } finally {
    await rm(exported, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runUiSegment(config: LoadedConfig, plan: UiPlan, udid: string, directory: string,
  run: NonNullable<Dependencies['run']>, backend: 'auto' | 'idb' | 'xctest', dependencies: Dependencies, videoPort?: number) {
  const planDeadline = dependencies.deadline ?? deadline(dependencies.timeoutMs ?? defaultUiTimeoutMs);
  const limit: Limit = { deadline: planDeadline, label: 'UI plan' };
  if (backend !== 'xctest') {
    const fast = await tryRunIdbPlan(config, plan, udid, directory, run, planDeadline);
    if (fast) return fast;
    if (backend === 'idb') throw new CliError('UI_DELIVERY_FAILED', 'idb is unavailable or the UI plan is incompatible with idb');
  }
  const built = await buildUiRunner(config, { ...dependencies, deadline: planDeadline, resolveUdid: async () => udid });
  const json = await checked(run, 'plutil', ['-convert', 'json', '-o', '-', built.manifest], 'Unable to read the XCTest run manifest', config.redactions ?? [], limit);
  const manifestValue = JSON.parse(json.stdout) as unknown;
  const encodedPlan = Buffer.from(JSON.stringify({ ...plan, bundleId: targetBundleId(config) }), 'utf8').toString('base64');
  if (injectEnvironment(manifestValue, { AGEMU_PLAN_BASE64: encodedPlan, ...(videoPort === undefined ? {} : { AGEMU_VIDEO_PORT: String(videoPort) }) }) === 0) {
    throw new CliError('BUILD_FAILED', 'The XCTest run manifest contains no test target');
  }
  const manifest = path.join(path.dirname(built.manifest), `AgentRunner-${process.pid}-${Date.now()}.xctestrun`);
  await writeFile(manifest, JSON.stringify(manifestValue), { mode: 0o600 });
  await checked(run, 'plutil', ['-convert', 'xml1', manifest], 'Unable to write the XCTest run manifest', config.redactions ?? [], limit);
  const resultBundle = path.join(directory, 'AgentRunner.xcresult');
  const transcript = path.join(directory, 'xcodebuild.log');
  let result: ProcessResult;
  try {
    result = await run('xcodebuild', [
      'test-without-building', '-xctestrun', manifest, '-destination', `platform=iOS Simulator,id=${built.udid}`,
      '-resultBundlePath', resultBundle,
    ], { timeoutMs: planDeadline.remaining() }).finally(() => unlink(manifest).catch(() => undefined));
  } catch (error) {
    if (!isTimeout(error)) throw error;
    const secrets = config.redactions ?? [];
    const partial = (error.details?.result ?? {}) as Partial<ProcessResult>;
    const stdout = typeof partial.stdout === 'string' ? partial.stdout : '';
    const stderr = typeof partial.stderr === 'string' ? partial.stderr : '';
    await writeFile(transcript, redact(`${stdout}${stderr}`, secrets), { mode: 0o600 });
    // SIGTERM leaves the runner host and the app running and the result bundle incomplete; no screenshot export.
    for (const bundle of [runnerBundleId, targetBundleId(config)]) {
      await run('xcrun', ['simctl', 'terminate', built.udid, bundle], { timeoutMs: 10_000 }).catch(() => undefined);
    }
    const lastStartedAction = lastStarted(stdout);
    throw limitExceeded(limit, redactValue({
      transcript: path.relative(config.root, transcript), resultBundle: path.relative(config.root, resultBundle),
      ...(lastStartedAction === undefined ? {} : { lastStartedAction }),
    }, secrets));
  }
  await writeFile(transcript, redact(`${result.stdout}${result.stderr}`, config.redactions ?? []), { mode: 0o600 });
  const exported = await exportXctestScreenshots(run, resultBundle, directory, config.root, plan, config.redactions ?? []);
  if (result.exitCode !== 0) {
    const secrets = config.redactions ?? [];
    const failedAction = xctestFailedAction(result.stdout, plan);
    const details = {
      exitCode: result.exitCode, resultBundle: path.relative(config.root, resultBundle), transcript: path.relative(config.root, transcript),
      ...(failedAction ? { failedAction } : {}), completed: failedAction ? failedAction.index : 0, ...exported,
    };
    throw new CliError('UI_DELIVERY_FAILED', redact(failedAction ? failureMessage(failedAction) : 'The XCTest UI plan failed', secrets),
      redactValue(details, secrets));
  }
  const marker = result.stdout.split(/\r?\n/).find(line => line.includes('AGEMU_RESULT:'));
  const runnerResult = marker ? JSON.parse(Buffer.from(marker.slice(marker.indexOf('AGEMU_RESULT:') + 13), 'base64').toString('utf8')) : undefined;
  return redactValue({
    run: path.relative(config.root, directory), udid: built.udid, bundleId: targetBundleId(config),
    backend: 'xctest', runnerCached: built.cached,
    actions: plan.actions.length, runnerResult, resultBundle: path.relative(config.root, resultBundle), transcript: path.relative(config.root, transcript),
    screenshots: exported.screenshots, ...(exported.screenshotExportError ? { screenshotExportError: exported.screenshotExportError } : {}),
  }, config.redactions ?? []);
}
