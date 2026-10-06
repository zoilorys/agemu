import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { createRun, redactValue } from '../artifacts/runs.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { buildFailureDetails, writeBuildLog } from '../native/build-errors.js';
import { selectedDevice, requireBooted } from '../native/simctl-commands.js';
import { appProcessEvidence } from './app-status.js';
import { resolveExpoProjectUrl, type ExpoProjectDependencies } from './app.js';
import { server } from './server.js';
import { deadline, runProcess, type Deadline, type ProcessResult, type RunOptions } from '../process/run-process.js';
import { tryRunIdbPlan } from './idb-ui.js';
import { runXctestPlan } from './ui-xctest.js';
export { exportXctestScreenshots, injectEnvironment } from './ui-xctest.js';
export type { ScreenshotExport } from './ui-xctest.js';
import { type Inspection } from './ui-elements.js';
import { type RecordingStarter } from './video-recording.js';

import { boundedUiRun, checkUiDeadline, uiOperation, uiTimeout } from './ui-deadline.js';
import { failureMessage, uiFailure, type FailedAction, type UiRunResult } from './ui-result.js';
export { actionKind, failureMessage } from './ui-result.js';
export type { FailedAction, UiRunResult } from './ui-result.js';
import { validatePlan, type UiPlan } from './ui-plan.js';
export { validatePlan, actionDefinitions, swipeDirections, textModes, pressKeys, pressButtons } from './ui-plan.js';
export type { UiPlan, UiAction, UiActionInputs, UiActionKind, Point, Swipe, LongPress } from './ui-plan.js';
export type UiDependencies = ExpoProjectDependencies & {
  run?: (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
  resolveUdid?: (config: LoadedConfig, run: NonNullable<UiDependencies['run']>) => Promise<string>;
  runnerProject?: string;
  now?: () => Date;
  backend?: 'auto' | 'idb' | 'xctest';
  startRecording?: RecordingStarter;
  /** Deadline for the whole command; defaults to 15 minutes. */
  timeoutMs?: number;
  /** Internal: the single `ui run` deadline shared with the runner build. */
  deadline?: Deadline;
  /** Internal: timeout cleanup terminates only the runner, never the app (`ui inspect`). */
  preserveApp?: boolean;
  /** Internal: verified Expo project URL, never accepted as a public action field. */
  launchUrl?: string;
};

export const defaultUiTimeoutMs = 900_000;

const isTimeout = (error: unknown): error is CliError => error instanceof CliError && error.code === 'PROCESS_TIMEOUT';

const bundledRunner = fileURLToPath(new URL('../../runner/AgentRunner.xcodeproj', import.meta.url));

async function uiUdid(config: LoadedConfig, dependencies: UiDependencies, run: NonNullable<UiDependencies['run']>, booted: boolean): Promise<string> {
  if (dependencies.resolveUdid) return dependencies.resolveUdid(config, run);
  // Legacy run injections select a configured fake device without querying the host inventory.
  if (dependencies.run && config.simulator.udid) return config.simulator.udid;
  const device = await selectedDevice(config, { runner: (args, options) => run('xcrun', ['simctl', ...args], options) });
  if (booted) requireBooted(device, config.redactions ?? []);
  return device.udid;
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

type Limit = { deadline: Deadline; label: string };

function limitExceeded(limit: Limit, details: Record<string, unknown> = {}): CliError {
  return new CliError('PROCESS_TIMEOUT', `${limit.label} exceeded ${limit.deadline.ms / 1000} s`, { timeoutSeconds: limit.deadline.ms / 1000, ...details });
}

export async function buildUiRunner(config: LoadedConfig, dependencies: UiDependencies = {}, rebuild = false) {
  const limit: Limit = dependencies.deadline
    ? { deadline: dependencies.deadline, label: 'UI plan' }
    : { deadline: deadline(dependencies.timeoutMs ?? defaultUiTimeoutMs), label: 'UI runner build' };
  const run = boundedUiRun(dependencies.run ?? runProcess, limit.deadline);
  const udid = await uiOperation(limit.deadline, () => uiUdid(config, dependencies, run, false));
  const derivedData = path.join(config.root, '.agemu', 'RunnerDerivedData');
  const project = dependencies.runnerProject ?? bundledRunner;
  let manifest = rebuild ? undefined : await uiOperation(limit.deadline, () => findXctestrun(derivedData)).catch(error => { if (isTimeout(error)) throw limitExceeded(limit); return undefined; });
  if (manifest) {
    const builtAt = (await uiOperation(limit.deadline, () => stat(manifest!))).mtimeMs;
    const sources = [path.join(project, 'project.pbxproj'), path.join(path.dirname(project), 'AgentRunner', 'AgentRunner.swift')];
    const changed = await uiOperation(limit.deadline, () => Promise.all(sources.map(source => stat(source).then(info => info.mtimeMs > builtAt).catch(() => false))));
    if (changed.some(Boolean)) manifest = undefined;
  }
  const cached = Boolean(manifest);
  if (!manifest) {
    const secrets = config.redactions ?? [];
    const { directory } = await uiOperation(limit.deadline, () => createRun(config.root, dependencies.now?.() ?? new Date()));
    const buildLog = path.join(directory, 'runner-build.log');
    const log = redact(path.relative(config.root, buildLog), secrets);
    let result: ProcessResult;
    try {
      result = await run('xcodebuild', [
        '-project', project, '-scheme', 'AgentRunner', '-configuration', 'Debug',
        '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derivedData, 'build-for-testing',
      ], { timeoutMs: limit.deadline.remaining() });
    } catch (error) {
      const partial = (error instanceof CliError ? error.details?.result : undefined) as Partial<ProcessResult> | undefined;
      const stdout = redact(typeof partial?.stdout === 'string' ? partial.stdout : '', secrets);
      const stderr = redact(typeof partial?.stderr === 'string' ? partial.stderr : '', secrets);
      await uiOperation(limit.deadline.expired() ? deadline(1_000) : limit.deadline, () => writeBuildLog(buildLog, { stdout, stderr, executionError: redact(error instanceof Error ? error.message : String(error), secrets) })).catch(() => undefined);
      if (isTimeout(error)) throw limitExceeded(limit, { log });
      throw new CliError('BUILD_FAILED', 'Unable to build the XCTest UI runner', { log, ...buildFailureDetails(stdout, stderr, secrets) });
    }
    await uiOperation(limit.deadline, () => writeBuildLog(buildLog, { stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets) }));
    if (result.exitCode !== 0) {
      throw new CliError('BUILD_FAILED', 'Unable to build the XCTest UI runner', {
        exitCode: result.exitCode, log, ...buildFailureDetails(result.stdout, result.stderr, secrets),
      });
    }
    manifest = await uiOperation(limit.deadline, () => findXctestrun(derivedData));
  }
  if (!manifest) throw new CliError('BUILD_FAILED', 'xcodebuild did not produce an .xctestrun file');
  return { udid, derivedData, manifest, cached };
}

export async function runUiPlan(config: LoadedConfig, source: { file: string } | { json: string }, dependencies: UiDependencies = {}): Promise<UiRunResult> {
  const limit = dependencies.deadline ?? deadline(dependencies.timeoutMs ?? defaultUiTimeoutMs);
  const output = redactValue(await executeUiPlan(config, source, { ...dependencies, deadline: limit }), config.redactions ?? []);
  if (limit.expired()) throw uiFailure('PROCESS_TIMEOUT', uiTimeout(limit).message, { ...output, failedAction: null, timeoutSeconds: limit.ms / 1000 });
  return output;
}

/** Internal results stay semantic until assertions/app identity checks have finished. */
async function executeUiPlan(config: LoadedConfig, source: { file: string } | { json: string }, dependencies: UiDependencies): Promise<UiRunResult> {
  const started = Date.now();
  const limit = dependencies.deadline ?? deadline(dependencies.timeoutMs ?? defaultUiTimeoutMs);
  const run = boundedUiRun(dependencies.run ?? runProcess, limit);
  let value: unknown;
  try { value = JSON.parse('file' in source ? await uiOperation(limit, () => readFile(source.file, 'utf8')) : source.json) as unknown; }
  catch (error) {
    if (isTimeout(error)) throw uiFailure(error.code, error.message, error.details);
    throw new CliError('UI_VALIDATION_FAILED', `Cannot read UI plan: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plan = validatePlan(value);
  const backend = dependencies.backend ?? 'auto';
  if (!['auto', 'idb', 'xctest'].includes(backend)) throw new CliError('UI_VALIDATION_FAILED', 'UI backend must be auto, idb, or xctest');
  let output: UiRunResult | undefined;
  try {
    const { directory } = await uiOperation(limit, () => createRun(config.root, dependencies.now?.() ?? new Date()));
    const udid = await uiOperation(limit, () => uiUdid(config, dependencies, run, true));
    let launchUrl: string | undefined;
    if (config.app.type === 'expo' && plan.actions.some(action => action.launch !== undefined)) {
      // Retain the authoritative cancellation through response-body reads: their abort rejection can
      // beat projectRequest's own timer and be wrapped as PROCESS_FAILED before this boundary sees it.
      const cancellation = AbortSignal.timeout(limit.remaining());
      try {
        launchUrl = await uiOperation(limit, () => resolveExpoProjectUrl(config, {
          ...dependencies, requestTimeoutMs: Math.min(dependencies.requestTimeoutMs ?? 5_000, limit.remaining()),
          serverStatus: (config) => uiOperation(limit, async () => {
            if (dependencies.serverStatus) return dependencies.serverStatus(config);
            const result = await server(config, 'status', { run, deadline: limit });
            return { running: result.running === true, collision: result.collision === true };
          }),
          ...(dependencies.resolveExpoUrl ? { resolveExpoUrl: (port) => uiOperation(limit, () => dependencies.resolveExpoUrl!(port)) } : {}),
          request: (input, options) => {
            checkUiDeadline(limit);
            const signal = AbortSignal.any([...(options?.signal ? [options.signal] : []), cancellation]);
            return (dependencies.request ?? fetch)(input, { ...options, signal });
          },
        }));
      } catch (error) {
        if (cancellation.aborted) throw uiTimeout(limit);
        throw error;
      }
    }
    const bounded = { ...dependencies, deadline: limit, launchUrl };
    if (backend !== 'xctest') {
      output = await tryRunIdbPlan(config, plan, udid, directory, run, limit, bounded);
      if (!output && backend === 'idb') throw uiFailure('UI_DELIVERY_FAILED', 'idb is unavailable or the UI plan is incompatible with idb');
    }
    if (!output) output = await runXctestPlan(config, plan, udid, directory, run, bounded,
      () => buildUiRunner(config, { ...bounded, run, resolveUdid: async () => udid }));
    checkUiDeadline(limit);
    return { ...output, durationMs: Date.now() - started };
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError('UI_DELIVERY_FAILED', error instanceof Error ? error.message : String(error));
    const details = { ...(output ? { completed: output.completed, screenshots: output.screenshots, recordings: output.recordings,
      inspections: output.inspections, transcript: output.transcript } : {}), ...failure.details };
    throw uiFailure(failure.code, redact(failure.message, config.redactions ?? []), redactValue(details, config.redactions ?? []));
  }
}

export const inspectLaunchHint = 'Launch the app first (agemu app launch); ui inspect never launches it.';

/** Reads the running app's current screen without launching, terminating, or interacting with it. */
export async function inspectScreen(config: LoadedConfig, options: { backend?: 'auto' | 'idb' | 'xctest'; all?: boolean; timeoutMs?: number },
  dependencies: UiDependencies = {}) {
  const capturedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const plan = { version: 1, actions: [{ inspect: {} }, { screenshot: { name: 'inspect' } }] };
  const run = dependencies.run ?? runProcess;
  const limit = dependencies.deadline ?? deadline(options.timeoutMs ?? defaultUiTimeoutMs);
  if (options.backend !== 'xctest') {
    const boundedRun = boundedUiRun(run, limit);
    const udid = await uiOperation(limit, () => uiUdid(config, dependencies, boundedRun, true));
    const bundleId = targetBundleId(config);
    let listed: ProcessResult;
    try { listed = await boundedRun('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 10_000 }); }
    catch (error) {
      const timeout = isTimeout(error);
      throw uiFailure(timeout ? 'PROCESS_TIMEOUT' : 'UI_DELIVERY_FAILED', timeout ? uiTimeout(limit).message : `Cannot verify the running app. ${inspectLaunchHint}`,
        redactValue({ ...(timeout ? { timeoutSeconds: limit.ms / 1000 } : {}) }, config.redactions ?? []));
    }
    const evidence = listed.exitCode === 0 ? appProcessEvidence(listed.stdout, bundleId) : { running: null };
    if (evidence.running !== true) {
      const failedAction = { index: 0, kind: 'inspect', message: `${bundleId} ${evidence.running === false ? 'is not running' : 'running state is unavailable'}` };
      throw uiFailure('UI_DELIVERY_FAILED', redact(`${failureMessage(failedAction)}. ${inspectLaunchHint}`, config.redactions ?? []),
        redactValue({ failedAction }, config.redactions ?? []));
    }
  }
  let result: UiRunResult;
  try {
    result = await executeUiPlan(config, { json: JSON.stringify(plan) },
      { ...dependencies, backend: options.backend, deadline: limit, preserveApp: true });
  } catch (error) {
    const failed = error instanceof CliError ? error.details?.failedAction as FailedAction | undefined : undefined;
    if (error instanceof CliError && error.code === 'UI_DELIVERY_FAILED' && failed?.kind === 'inspect') {
      throw new CliError(error.code, `${error.message}. ${inspectLaunchHint}`, error.details);
    }
    throw error;
  }
  const inspections = (result.runnerResult as { inspections?: Inspection[] } | undefined)?.inspections ?? [];
  const tree = inspections.find(inspection => inspection.index === 0)?.elements ?? [];
  const visible = tree.filter(element => element.visible);
  checkUiDeadline(limit);
  return redactValue({
    ...result,
    run: result.run, udid: result.udid, bundleId: result.bundleId, backend: result.backend, capturedAt,
    screenshot: (result.screenshots as string[] | undefined)?.[0],
    elements: options.all ? tree : visible,
    counts: { total: tree.length, visible: visible.length },
    foreground: null, foregroundUnavailable: 'Neither XCTest app-scoped inspection nor the simctl/idb foreground tree can reliably certify foreground application identity',
    ...(typeof result.screenshotExportError === 'string' ? { screenshotExportError: result.screenshotExportError } : {}),
  }, config.redactions ?? []);
}
