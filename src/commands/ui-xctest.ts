import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { redactValue } from '../artifacts/runs.js';
import { writeLaunchMarker } from '../artifacts/launch-marker.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { deadline, runProcess, type Deadline, type ProcessResult } from '../process/run-process.js';
import { screenshotName } from './idb-ui.js';
import { uiArtifactStem } from './ui-artifact-name.js';
import type { Inspection } from './ui-elements.js';
import { createRecordingBridge, startVideoRecording } from './video-recording.js';
import { checkUiDeadline, uiOperation, uiTimeout } from './ui-deadline.js';
import { actionKind, failureMessage, uiFailure, uiResult, uiTranscript, type FailedAction, type UiRunResult } from './ui-result.js';
import { readXctestResult, readPartialInspections, readReachedLaunch } from './ui-xctest-protocol.js';
import { portableRegexSource } from './ui-regex.js';
import type { UiPlan } from './ui-plan.js';
import type { UiDependencies } from './ui.js';

const isTimeout = (error: unknown): error is CliError => error instanceof CliError && error.code === 'PROCESS_TIMEOUT';
const runnerBundleId = 'dev.agemu.agemu-agent-runner.xctrunner';
const stderrLimit = 4_000;

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

async function checked(run: NonNullable<UiDependencies['run']>, executable: string, args: string[], message: string, secrets: string[],
  limit: Deadline): Promise<ProcessResult> {
  let result: ProcessResult;
  try { result = await run(executable, args, { timeoutMs: limit.remaining() }); }
  catch (error) { throw isTimeout(error) ? uiTimeout(limit) : error; }
  if (result.exitCode !== 0) {
    throw new CliError('UI_DELIVERY_FAILED', message, { exitCode: result.exitCode, stderr: redact(result.stderr, secrets).slice(-stderrLimit) });
  }
  return result;
}

/** Index from the last `AGEMU_ACTION:<n>` marker the runner printed, if any. */
function lastStarted(stdout: string): number | undefined {
  let index: number | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const started = line.indexOf('AGEMU_ACTION:');
    if (started < 0) continue;
    const match = /^(\d+)$/.exec(line.slice(started + 13).trim());
    if (match && Number.isSafeInteger(Number(match[1]))) index = Number(match[1]);
  }
  return index;
}

function xctestFailedAction(stdout: string, plan: UiPlan): FailedAction | undefined {
  const lines = stdout.split(/\r?\n/);
  const markerIndex = lastStarted(stdout);
  const started = markerIndex !== undefined && markerIndex < plan.actions.length ? markerIndex : undefined;
  let encodedFailure: string | undefined;
  for (const line of lines) {
    const failed = line.indexOf('AGEMU_FAILURE:');
    if (failed >= 0) encodedFailure = line.slice(failed + 14).trim();
  }
  if (encodedFailure) {
    try {
      const value = JSON.parse(Buffer.from(encodedFailure, 'base64').toString('utf8')) as unknown;
      const failure = value as Record<string, unknown>;
      if (failure && Number.isSafeInteger(failure.index) && (failure.index as number) >= 0 && (failure.index as number) < plan.actions.length
        && failure.kind === actionKind(plan.actions[failure.index as number]) && typeof failure.message === 'string') {
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
 * file naming. Artifact errors are warnings; the shared command deadline remains a failure.
 */
export async function exportXctestScreenshots(run: NonNullable<UiDependencies['run']>, resultBundle: string, directory: string,
  root: string, plan: UiPlan, secrets: string[] = [], limit: Deadline = deadline(120_000)): Promise<ScreenshotExport> {
  try { await uiOperation(limit, () => stat(resultBundle)); } catch (error) {
    if (isTimeout(error)) throw error;
    return { screenshots: [] };
  }
  const exported = path.join(directory, 'attachments');
  const target = path.join(directory, 'screenshots');
  const shots: Array<{ index: number; file: string }> = [];
  let failureScreenshot: string | undefined;
  try {
    const result = await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', resultBundle, '--output-path', exported], { timeoutMs: limit.remaining() });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `xcresulttool exited with ${result.exitCode}`);
    let text: string;
    try { text = await uiOperation(limit, () => readFile(path.join(exported, 'manifest.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { screenshots: [] };
      throw error;
    }
    const manifest = JSON.parse(text) as unknown;
    if (!Array.isArray(manifest)) throw new Error('xcresulttool returned an invalid attachments manifest');

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
          const action = plan.actions[index] as unknown as Record<string, Record<string, unknown>> | undefined;
          if (!action || typeof action !== 'object' || !('screenshot' in action)) continue;
          // Xcode appends suffixes such as `_0_<UUID>.png`; the plan supplies the exact stem.
          const stem = screenshotName(action.screenshot?.name);
          if (!name.startsWith(`agemu-${index}-${stem}`) || shots.some(shot => shot.index === index)) continue;
          destination = path.join(target, `${index}-${uiArtifactStem(action.screenshot?.name, 'screen', secrets)}.png`);
        } else if (/^agemu-failure/.test(name)) {
          destination = path.join(target, `${uiArtifactStem('failure', 'screen', secrets)}.png`);
        }
        if (!destination) continue;
        await uiOperation(limit, () => mkdir(target, { recursive: true }));
        await uiOperation(limit, () => rename(path.join(exported, file), destination!));
        if (match) shots.push({ index: Number(match[1]), file: path.relative(root, destination) });
        else failureScreenshot = path.relative(root, destination);
      }
    }
    shots.sort((left, right) => left.index - right.index);
    return { screenshots: shots.map(shot => shot.file), ...(failureScreenshot ? { failureScreenshot } : {}) };
  } catch (error) {
    if (isTimeout(error) || limit.expired()) throw uiTimeout(limit, { screenshots: shots.map(shot => shot.file), ...(failureScreenshot ? { failureScreenshot } : {}) });
    return { screenshots: shots.map(shot => shot.file), ...(failureScreenshot ? { failureScreenshot } : {}), screenshotExportError: redact(error instanceof Error ? error.message : String(error), secrets) };
  } finally {
    await uiOperation(limit.expired() ? deadline(1_000) : limit, () => rm(exported, { recursive: true, force: true })).catch(() => undefined);
  }
}

export async function runXctestPlan(config: LoadedConfig, plan: UiPlan, udid: string, directory: string,
  run: NonNullable<UiDependencies['run']>, dependencies: UiDependencies & { deadline: Deadline }, build: () => Promise<{ manifest: string; cached: boolean }>): Promise<UiRunResult> {
  const planDeadline = dependencies.deadline;
  const secrets = config.redactions ?? [];
  const bundleId = targetBundleId(config);
  const resultBundle = path.join(directory, 'AgentRunner.xcresult');
  const transcript = path.join(directory, 'xcodebuild.log');
  const artifacts = { resultBundle: path.relative(config.root, resultBundle) };
  const evidence = { run: path.relative(config.root, directory), udid, bundleId, backend: 'xctest' as const, actions: plan.actions.length,
    completed: 0, screenshots: [] as string[], recordings: [] as string[], inspections: [] as Inspection[],
    transcript: path.relative(config.root, transcript) };
  let bridge: Awaited<ReturnType<typeof createRecordingBridge>> | undefined;
  let manifest: string | undefined;
  let stdout = '';
  let stderr = '';
  let failedAction: FailedAction | undefined;
  let executionCompleted = false;
  let metadata: Record<string, unknown> = {};
  try {
    const built = await build();
    metadata.runnerCached = built.cached;
    if (plan.actions.some(action => action.startVideoRecording)) {
      bridge = await createRecordingBridge(udid, directory, config.root, dependencies.startRecording ?? startVideoRecording, planDeadline, secrets);
      evidence.recordings = bridge.recordings;
    }
    const json = await checked(run, 'plutil', ['-convert', 'json', '-o', '-', built.manifest], 'Unable to read the XCTest run manifest', secrets, planDeadline);
    const manifestValue = JSON.parse(json.stdout) as unknown;
    const actions = plan.actions.map(action => {
      if (action.assertText?.matches !== undefined) return { assertText: { ...action.assertText, compiledMatches: portableRegexSource(action.assertText.matches) } };
      if (action.launch && dependencies.launchUrl) return { launch: { ...action.launch, projectUrl: dependencies.launchUrl } };
      return action;
    });
    const encodedPlan = Buffer.from(JSON.stringify({ ...plan, actions, bundleId }), 'utf8').toString('base64');
    if (injectEnvironment(manifestValue, { AGEMU_PLAN_BASE64: encodedPlan, ...(bridge ? { AGEMU_VIDEO_PORT: String(bridge.port) } : {}) }) === 0) {
      throw new CliError('BUILD_FAILED', 'The XCTest run manifest contains no test target');
    }
    manifest = path.join(path.dirname(built.manifest), `AgentRunner-${process.pid}-${Date.now()}.xctestrun`);
    await uiOperation(planDeadline, () => writeFile(manifest!, JSON.stringify(manifestValue), { mode: 0o600 }));
    await checked(run, 'plutil', ['-convert', 'xml1', manifest], 'Unable to write the XCTest run manifest', secrets, planDeadline);
    let result: ProcessResult;
    try {
      result = await run('xcodebuild', [
        'test-without-building', '-xctestrun', manifest, '-destination', `platform=iOS Simulator,id=${udid}`,
        '-resultBundlePath', resultBundle,
      ], { timeoutMs: planDeadline.remaining() });
    } catch (error) {
      const partial = (error instanceof CliError ? error.details?.result : undefined) as Partial<ProcessResult> | undefined;
      stdout = typeof partial?.stdout === 'string' ? partial.stdout : '';
      stderr = typeof partial?.stderr === 'string' ? partial.stderr : '';
      if (isTimeout(error)) {
        try {
          const decoded = readXctestResult(stdout, plan, bundleId);
          evidence.completed = decoded.completed; evidence.inspections = decoded.inspections; executionCompleted = true;
        } catch { /* Partial output only certifies actions through the last started marker. */ }
        // Process termination and video cleanup have a separate bounded grace after the command deadline.
        await Promise.all((dependencies.preserveApp ? [runnerBundleId] : [runnerBundleId, bundleId]).map(bundle =>
          uiOperation(deadline(1_000), () => (dependencies.run ?? runProcess)('xcrun', ['simctl', 'terminate', udid, bundle], { timeoutMs: 1_000 })).catch(() => undefined)));
      }
      throw error;
    }
    stdout = result.stdout;
    stderr = result.stderr;
    evidence.inspections = readPartialInspections(stdout, plan);
    failedAction = xctestFailedAction(stdout, plan);
    evidence.completed = failedAction?.index ?? 0;
    let outcomeError: unknown;
    if (result.exitCode !== 0) outcomeError = new CliError('UI_DELIVERY_FAILED', failedAction ? failureMessage(failedAction) : 'The XCTest UI plan failed');
    else {
      try {
        const decoded = readXctestResult(stdout, plan, bundleId);
        evidence.completed = decoded.completed;
        evidence.inspections = decoded.inspections;
        executionCompleted = true;
        failedAction = undefined;
      } catch (error) { outcomeError = error; }
    }
    metadata.exitCode = result.exitCode;
    await uiOperation(planDeadline, () => writeFile(transcript, uiTranscript(`${stdout}${stderr}`, secrets), { mode: 0o600 }));
    const exported = await exportXctestScreenshots(run, resultBundle, directory, config.root, plan, secrets, planDeadline);
    evidence.screenshots = exported.screenshots;
    if (exported.failureScreenshot) metadata.failureScreenshot = exported.failureScreenshot;
    if (exported.screenshotExportError) metadata.screenshotExportError = exported.screenshotExportError;
    if (outcomeError) throw outcomeError;
    checkUiDeadline(planDeadline);
    return uiResult({ run: path.relative(config.root, directory), udid, backend: 'xctest', bundleId,
      actions: plan.actions.length, transcript: evidence.transcript }, evidence, { ...artifacts, runnerCached: metadata.runnerCached,
      ...(metadata.screenshotExportError ? { screenshotExportError: metadata.screenshotExportError } : {}) });
  } catch (error) {
    evidence.inspections = evidence.inspections.length ? evidence.inspections : readPartialInspections(stdout, plan);
    if (!executionCompleted) failedAction ??= xctestFailedAction(stdout, plan);
    if (!evidence.completed) evidence.completed = failedAction?.index ?? 0;
    const timeout = isTimeout(error) || planDeadline.expired();
    const failure = error instanceof CliError ? error : new CliError('UI_DELIVERY_FAILED', error instanceof Error ? error.message : String(error));
    const markerIndex = lastStarted(stdout);
    const started = markerIndex !== undefined && markerIndex < plan.actions.length ? markerIndex : undefined;
    if (timeout && failedAction && !stdout.includes('AGEMU_FAILURE:')) failedAction = { ...failedAction, message: 'the UI plan deadline was reached' };
    const { result: _processResult, ...failureDetails } = failure.details ?? {};
    throw uiFailure(timeout ? 'PROCESS_TIMEOUT' : failure.code, redact(timeout ? uiTimeout(planDeadline).message : failure.message, secrets),
      redactValue({ ...evidence, failedAction: failedAction ?? null, ...artifacts, backendArtifacts: artifacts, ...metadata,
        ...failureDetails, ...(timeout ? { timeoutSeconds: planDeadline.ms / 1000, ...(started === undefined ? {} : { lastStartedAction: started }) } : {}) }, secrets));
  } finally {
    const reachedLaunch = readReachedLaunch(stdout, plan);
    if (reachedLaunch) await uiOperation(planDeadline.expired() ? deadline(1_000) : planDeadline,
      () => writeLaunchMarker(config.root, { at: reachedLaunch.at, udid, bundleId, source: 'ui run' })).catch(() => undefined);
    if (bridge) await bridge.close();
    if (manifest) await uiOperation(deadline(1_000), () => unlink(manifest!)).catch(() => undefined);
    if (stdout || stderr) await uiOperation(planDeadline.expired() ? deadline(1_000) : planDeadline,
      () => writeFile(transcript, uiTranscript(`${stdout}${stderr}`, secrets), { mode: 0o600 })).catch(() => undefined);
  }
}
