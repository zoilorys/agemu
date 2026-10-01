import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, createRun, redactValue, type Run } from '../artifacts/runs.js';
import type { AppState } from './build.js';
import { nativeApp, targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { installedExpoGoHost } from '../native/expo-go.js';
import { server } from './server.js';
import { listCrashes } from './crashes.js';
import { localTimestamp, loggedBefore, resolveSince, type SinceWindow } from './since.js';
import { streamLines } from '../process/stream-lines.js';
import { listDevices, resolveDevice, simctl, type Device, type SimctlRunner } from '../native/simctl.js';

type Dependencies = {
  runner?: SimctlRunner;
  resolveDevice?: (config: LoadedConfig) => Promise<Device>;
  now?: () => Date;
  readState?: (file: string) => Promise<AppState>;
  readEvents?: (file: string) => Promise<string>;
  serverStatus?: typeof server;
  readServerOutput?: (file: string) => Promise<string>;
  crashDirectory?: string;
};
export type LogOptions = { last?: string; since?: string; level?: string; limit?: number };

const allowedLevels = new Set(['default', 'info', 'debug', 'error', 'fault']);

async function configuredDevice(config: LoadedConfig): Promise<Device> {
  return resolveDevice(await listDevices(), config.simulator);
}

async function state(config: LoadedConfig, dependencies: Dependencies): Promise<AppState> {
  const file = path.join(config.root, '.agemu', 'state.json');
  try {
    return dependencies.readState ? await dependencies.readState(file) : JSON.parse(await readFile(file, 'utf8')) as AppState;
  } catch (error) {
    throw new CliError('APP_NOT_BUILT', `Cannot read app state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeRelative(root: string, file: string, secrets: string[]): string {
  return redact(path.relative(root, file), secrets);
}

async function runContext(config: LoadedConfig, dependencies: Dependencies): Promise<{ run: Run; now: Date; device: Device }> {
  const now = dependencies.now?.() ?? new Date();
  const [run, device] = await Promise.all([
    createRun(config.root, now),
    dependencies.resolveDevice ? dependencies.resolveDevice(config) : configuredDevice(config),
  ]);
  return { run, now, device };
}

function failure(error: unknown, secrets: string[]): { code: string; message: string } {
  const normalized = error instanceof CliError ? error : new CliError('PROCESS_FAILED', error instanceof Error ? error.message : String(error));
  return { code: normalized.code, message: redact(normalized.message, secrets) };
}

async function tail(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    await handle.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

function bundlingErrors(output: string): string[] {
  return output.split(/\r?\n/).filter(line => /(?:error:|error \[|bundling failed|unable to resolve module|syntaxerror|transformerror)/i.test(line)).slice(-20);
}

export async function observe(config: LoadedConfig, dependencies: Dependencies = {}) {
  const secrets = config.redactions ?? [];
  const bundleId = config.app.type === 'expo' ? (config.app.launchTarget === 'development-build' ? config.app.bundleId : config.app.hostBundleId) : config.app.bundleId;
  const { run, now, device } = await runContext(config, dependencies);
  const directory = path.join(run.directory, 'screenshots');
  const screenshot = path.join(directory, 'screen.png');
  await mkdir(directory, { recursive: true });
  const args = ['io', device.udid, 'screenshot', screenshot];
  try {
    const result = await (dependencies.runner ?? simctl)(args);
    if (result.exitCode !== 0) throw new CliError('PROCESS_FAILED', result.stderr.trim() || 'Screenshot capture failed');
    const data = {
      run: run.relativeDirectory, screenshot: safeRelative(config.root, screenshot, secrets), capturedAt: now.toISOString(),
      simulator: redactValue(device, secrets), bundleId: redact(bundleId, secrets),
    };
    await appendEvent(config.root, { at: now.toISOString(), command: 'observe', status: 'ok', data }, secrets);
    return data;
  } catch (error) {
    const details = { run: run.relativeDirectory, simulator: redactValue(device, secrets), bundleId: redact(bundleId, secrets) };
    await appendEvent(config.root, { at: now.toISOString(), command: 'observe', status: 'error', error: failure(error, secrets), details }, secrets);
    throw new CliError('PROCESS_FAILED', redact(error instanceof Error ? error.message : String(error), secrets), details);
  }
}

function predicate(app: Pick<AppState, 'executableName'>): string {
  if (!app.executableName) throw new CliError('APP_NOT_BUILT', 'Cached app state does not contain an executable name; rebuild the app');
  const processName = app.executableName.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `process == "${processName}"`;
}

function logArguments(level: string, app: Pick<AppState, 'executableName'>): string[] {
  const processPredicate = predicate(app);
  if (level === 'info') return ['--info', '--predicate', processPredicate];
  if (level === 'debug') return ['--debug', '--predicate', processPredicate];
  if (level === 'error') return ['--predicate', `${processPredicate} AND (messageType == error OR messageType == fault)`];
  if (level === 'fault') return ['--predicate', `${processPredicate} AND messageType == fault`];
  return ['--predicate', processPredicate];
}

export async function showLogs(config: LoadedConfig, options: LogOptions = {}, dependencies: Dependencies = {}) {
  const secrets = config.redactions ?? [];
  if (options.since !== undefined && options.last !== undefined) throw new CliError('COMMAND_INVALID', 'Use either --since or --last');
  const last = options.since === undefined ? options.last ?? '30s' : undefined;
  const level = options.level ?? 'default';
  const limit = options.limit ?? 100;
  if (last !== undefined && !/^\d+[smhd]$/.test(last)) throw new CliError('COMMAND_INVALID', '--last must be a number followed by s, m, h, or d');
  if (!allowedLevels.has(level)) throw new CliError('COMMAND_INVALID', '--level must be default, info, debug, error, or fault');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) throw new CliError('COMMAND_INVALID', '--limit must be an integer from 0 to 10000');
  const { run, now, device } = await runContext(config, dependencies);
  const window = options.since === undefined ? undefined
    : await resolveSince(options.since, config.root, now, 0, { bundleId: targetBundleId(config), udid: device.udid });
  const app = config.app.type === 'expo' && config.app.launchTarget === 'expo-go'
    ? await installedExpoGoHost(device.udid, config.app.hostBundleId, dependencies.runner ?? simctl)
    : await state(config, dependencies);
  if (app.bundleId !== targetBundleId(config) || ('udid' in app && app.udid !== device.udid)) throw new CliError('APP_NOT_BUILT', 'Cached app state does not match the configured app and simulator');
  const artifact = path.join(run.directory, 'logs.txt');
  const range = window ? ['--start', localTimestamp(window.start)] : ['--last', last!];
  const args = ['spawn', device.udid, 'log', 'show', ...range, ...logArguments(level, app), '--style', 'compact'];
  let result;
  try { result = await (dependencies.runner ?? simctl)(args); }
  catch (error) {
    const captured = error instanceof CliError && typeof error.details?.result === 'object' && error.details.result !== null
      ? error.details.result as { stdout?: unknown; stderr?: unknown }
      : {};
    const full = redact(`${typeof captured.stdout === 'string' ? captured.stdout : ''}${typeof captured.stderr === 'string' ? captured.stderr : ''}`, secrets);
    await writeFile(artifact, full, { mode: 0o600 });
    const details = { artifact: safeRelative(config.root, artifact, secrets), run: run.relativeDirectory };
    await appendEvent(config.root, { at: now.toISOString(), command: 'logs show', status: 'error', args, error: failure(error, secrets), details }, secrets);
    throw new CliError(error instanceof CliError ? error.code : 'PROCESS_FAILED', redact(error instanceof Error ? error.message : String(error), secrets), details);
  }
  const full = redact(`${result.stdout}${result.stderr}`, secrets);
  await writeFile(artifact, full, { mode: 0o600 });
  if (result.exitCode !== 0) {
    const details = { artifact: safeRelative(config.root, artifact, secrets), run: run.relativeDirectory };
    const error = new CliError('PROCESS_FAILED', redact(result.stderr.trim() || 'Log collection failed', secrets), details);
    await appendEvent(config.root, { at: now.toISOString(), command: 'logs show', status: 'error', args, error: failure(error, secrets), details }, secrets);
    throw error;
  }
  // `log show --start` has second precision; drop entries from earlier in the start second.
  const lines = full.split(/\r?\n/).filter((line, index, all) => (line || index < all.length - 1) && !(window && loggedBefore(line, window.start)));
  const data = {
    run: run.relativeDirectory, udid: redact(device.udid, secrets), bundleId: redact(targetBundleId(config), secrets),
    ...(window ? { since: { start: window.start.toISOString(), source: window.source } } : { last }), level,
    logs: limit === 0 ? [] : lines.slice(-limit), truncated: lines.length > limit,
    artifact: safeRelative(config.root, artifact, secrets), capturedAt: now.toISOString(),
  };
  await appendEvent(config.root, { at: now.toISOString(), command: 'logs show', status: 'ok', args, data }, secrets);
  return data;
}

export type StreamLogOptions = { duration?: string; until?: string; level?: string; limit?: number };
type StreamDependencies = Dependencies & { stream?: typeof streamLines };

// log stream takes --level info|debug; error and fault narrow the predicate as in log show.
function streamArguments(level: string, app: Pick<AppState, 'executableName'>): string[] {
  if (level === 'info' || level === 'debug') return ['--level', level, '--predicate', predicate(app)];
  return logArguments(level, app);
}

export async function streamLogs(config: LoadedConfig, options: StreamLogOptions = {}, dependencies: StreamDependencies = {}) {
  const secrets = config.redactions ?? [];
  const level = options.level ?? 'default';
  const limit = options.limit ?? 100;
  const match = options.duration === undefined ? null : /^(\d+)([sm])$/.exec(options.duration);
  const durationMs = match ? Number(match[1]) * (match[2] === 'm' ? 60_000 : 1_000) : NaN;
  if (!(durationMs >= 1_000 && durationMs <= 600_000)) throw new CliError('COMMAND_INVALID', '--duration is required: a number followed by s or m, from 1s to 10m');
  if (!allowedLevels.has(level)) throw new CliError('COMMAND_INVALID', '--level must be default, info, debug, error, or fault');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) throw new CliError('COMMAND_INVALID', '--limit must be an integer from 0 to 10000');
  let until: RegExp | undefined;
  if (options.until !== undefined) {
    if (options.until.length === 0) throw new CliError('COMMAND_INVALID', '--until requires a non-empty regular expression');
    try { until = new RegExp(options.until); }
    catch (error) { throw new CliError('COMMAND_INVALID', `--until is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const { run, now, device } = await runContext(config, dependencies);
  if (device.state !== 'Booted') throw new CliError('PROCESS_FAILED', `Simulator ${redact(device.udid, secrets)} is not booted; run agemu simulator boot`);
  const app = config.app.type === 'expo' && config.app.launchTarget === 'expo-go'
    ? await installedExpoGoHost(device.udid, config.app.hostBundleId, dependencies.runner ?? simctl)
    : await state(config, dependencies);
  if (app.bundleId !== targetBundleId(config) || ('udid' in app && app.udid !== device.udid)) throw new CliError('APP_NOT_BUILT', 'Cached app state does not match the configured app and simulator');
  const artifact = path.join(run.directory, 'logs-stream.txt');
  const args = ['spawn', device.udid, 'log', 'stream', '--style', 'compact', ...streamArguments(level, app)];
  // Only the returned tail stays in memory; every line is appended to the artifact as it arrives.
  const lines: string[] = [];
  let total = 0;
  let matchedLine: string | undefined;
  const fd = openSync(artifact, 'w', 0o600);
  const base = { run: run.relativeDirectory, udid: redact(device.udid, secrets), bundleId: redact(targetBundleId(config), secrets), duration: options.duration!, level };
  const recordError = async (error: CliError) => {
    await appendEvent(config.root, { at: now.toISOString(), command: 'logs stream', status: 'error', args, error: failure(error, secrets), details: error.details }, secrets);
    return error;
  };
  let outcome;
  try {
    outcome = await (dependencies.stream ?? streamLines)('xcrun', ['simctl', ...args], {
      durationMs,
      onLine: (raw) => {
        if (total === 0 && raw.startsWith('Filtering the log data using')) return false;
        const line = redact(raw, secrets);
        total += 1;
        writeSync(fd, `${line}\n`);
        if (limit > 0) { lines.push(line); if (lines.length > limit) lines.shift(); }
        if (until?.test(line)) { matchedLine = line; return true; }
        return false;
      },
    });
  } catch (error) {
    closeSync(fd);
    const details = { artifact: safeRelative(config.root, artifact, secrets), run: run.relativeDirectory };
    throw await recordError(new CliError('PROCESS_FAILED', redact(error instanceof Error ? error.message : String(error), secrets), details));
  }
  closeSync(fd);
  const artifactPath = safeRelative(config.root, artifact, secrets);
  if (outcome.stoppedBy === 'exit' && outcome.exitCode !== 0) {
    const details = { artifact: artifactPath, run: run.relativeDirectory, exitCode: outcome.exitCode, signal: outcome.signal };
    throw await recordError(new CliError('PROCESS_FAILED', redact(outcome.stderr.trim() || 'Log streaming exited before the duration elapsed', secrets), details));
  }
  const data = {
    ...base, stoppedBy: outcome.stoppedBy, matched: matchedLine !== undefined, ...(matchedLine !== undefined ? { matchedLine } : {}),
    logs: lines, truncated: total > limit, artifact: artifactPath, capturedAt: now.toISOString(),
  };
  await appendEvent(config.root, { at: now.toISOString(), command: 'logs stream', status: 'ok', args, data: { ...data, logs: undefined } }, secrets);
  return data;
}

export async function diagnose(config: LoadedConfig, options: LogOptions = {}, dependencies: Dependencies = {}) {
  const now = dependencies.now?.() ?? new Date();
  const secrets = config.redactions ?? [];
  const evidence: Record<string, unknown> = {};
  const failures: Record<string, unknown> = {};
  if (options.since !== undefined && options.last !== undefined) throw new CliError('COMMAND_INVALID', 'Use either --since or --last');
  let device: Device | undefined;
  try { device = await (dependencies.resolveDevice ? dependencies.resolveDevice(config) : configuredDevice(config)); evidence.simulator = redactValue(device, secrets); }
  catch (error) { failures.simulator = failure(error, secrets); }
  // An explicit --since must resolve; by default the latest matching agemu launch scopes the evidence when there is one.
  const expected = { bundleId: targetBundleId(config), udid: device?.udid };
  let since = options.since;
  let window: SinceWindow;
  if (since !== undefined) window = await resolveSince(since, config.root, now, 0, expected);
  else if (options.last === undefined) {
    try { window = await resolveSince('launch', config.root, now, 0, expected); since = 'launch'; }
    catch { window = await resolveSince(undefined, config.root, now, 3_600_000); }
  } else window = await resolveSince(undefined, config.root, now, 3_600_000);
  if (config.app.type === 'expo' && config.app.launchTarget === 'expo-go') evidence.host = { bundleId: redact(config.app.hostBundleId, secrets) };
  else try { evidence.build = redactValue(await state(config, dependencies), secrets); }
  catch (error) { failures.build = failure(error, secrets); }
  try { evidence.observation = await observe(config, { ...dependencies, now: () => now }); }
  catch (error) { failures.observation = failure(error, secrets); }
  try { evidence.logs = { source: 'Simulator unified log', ...(await showLogs(config, { ...options, since }, { ...dependencies, now: () => now })) }; }
  catch (error) { failures.logs = failure(error, secrets); }
  try {
    evidence.crashes = { source: 'Simulator crash reports', ...(await listCrashes(config, since === undefined ? { sinceMs: 3_600_000 } : { since }, {
      directory: dependencies.crashDirectory, now: () => now, readState: dependencies.readState,
      resolveDevice: dependencies.resolveDevice, runner: dependencies.runner,
    })) };
  } catch (error) { failures.crashes = failure(error, secrets); }
  if (config.app.type !== 'native') {
    const serverEvidence: Record<string, unknown> = { source: 'Metro/Expo server', consoleCoverage: 'Server output and bundling errors only; capture in-app JavaScript console output with agemu logs js --duration=30s' };
    evidence.server = serverEvidence;
    try {
      const status = await (dependencies.serverStatus ?? server)(config, 'status');
      serverEvidence.status = redactValue(status, secrets);
      if (!status.running) failures.server = { code: 'PROCESS_FAILED', message: 'Metro/Expo server is not ready' };
    } catch (error) { failures.server = failure(error, secrets); }
    try {
      const file = path.join(config.root, '.agemu', 'metro.log');
      const output = redact(await (dependencies.readServerOutput ?? tail)(file), secrets);
      const lines = output.split(/\r?\n/).filter(Boolean);
      serverEvidence.output = lines.slice(-100);
      serverEvidence.bundlingErrors = bundlingErrors(output);
      serverEvidence.outputSource = redact(path.relative(config.root, file), secrets);
      serverEvidence.outputRelation = 'saved log; current server association unverified';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.serverOutput = failure(error, secrets);
    }
  }
  try {
    const eventsFile = path.join(config.root, '.agemu', 'events.jsonl');
    const contents = dependencies.readEvents ? await dependencies.readEvents(eventsFile) : await readFile(eventsFile, 'utf8');
    evidence.recentErrors = redactValue(String(contents).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.status === 'error').slice(-10), secrets);
  } catch { evidence.recentErrors = []; }
  const crashWindow = { start: window.start.toISOString(), source: window.source };
  let logWindow: Record<string, string> = crashWindow;
  if (since === undefined) {
    const last = options.last ?? '30s';
    const start = await resolveSince(last, config.root, now, 0).then((value) => value.start.toISOString(), () => undefined);
    logWindow = { ...(start ? { start } : {}), source: options.last === undefined ? 'default' : 'duration', last };
  }
  const data = {
    generatedAt: now.toISOString(), bundleId: redact(targetBundleId(config), secrets),
    window: { logs: logWindow, crashes: crashWindow }, partial: Object.keys(failures).length > 0, evidence, failures };
  await appendEvent(config.root, { at: now.toISOString(), command: 'diagnose', status: data.partial ? 'partial' : 'ok', data }, secrets);
  return data;
}
