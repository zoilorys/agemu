import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendEvent, createRun, redactValue, type Run } from '../artifacts/runs.js';
import type { AppState } from './build.js';
import { nativeApp, targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { installedExpoGoHost } from '../native/expo-go.js';
import { listDevices, resolveDevice, simctl, type Device, type SimctlRunner } from '../native/simctl.js';

type Dependencies = {
  runner?: SimctlRunner;
  resolveDevice?: (config: LoadedConfig) => Promise<Device>;
  now?: () => Date;
  readState?: (file: string) => Promise<AppState>;
  readEvents?: (file: string) => Promise<string>;
};
export type LogOptions = { last?: string; level?: string; limit?: number };

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
  const last = options.last ?? '30s';
  const level = options.level ?? 'default';
  const limit = options.limit ?? 100;
  if (!/^\d+[smhd]$/.test(last)) throw new CliError('COMMAND_INVALID', '--last must be a number followed by s, m, h, or d');
  if (!allowedLevels.has(level)) throw new CliError('COMMAND_INVALID', '--level must be default, info, debug, error, or fault');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) throw new CliError('COMMAND_INVALID', '--limit must be an integer from 0 to 10000');
  const { run, now, device } = await runContext(config, dependencies);
  const app = config.app.type === 'expo' && config.app.launchTarget === 'expo-go'
    ? await installedExpoGoHost(device.udid, config.app.hostBundleId, dependencies.runner ?? simctl)
    : await state(config, dependencies);
  if (app.bundleId !== targetBundleId(config) || ('udid' in app && app.udid !== device.udid)) throw new CliError('APP_NOT_BUILT', 'Cached app state does not match the configured app and simulator');
  const artifact = path.join(run.directory, 'logs.txt');
  const args = ['spawn', device.udid, 'log', 'show', '--last', last, ...logArguments(level, app), '--style', 'compact'];
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
  const lines = full.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1);
  const data = {
    run: run.relativeDirectory, udid: redact(device.udid, secrets), bundleId: redact(targetBundleId(config), secrets), last, level,
    logs: limit === 0 ? [] : lines.slice(-limit), truncated: lines.length > limit,
    artifact: safeRelative(config.root, artifact, secrets), capturedAt: now.toISOString(),
  };
  await appendEvent(config.root, { at: now.toISOString(), command: 'logs show', status: 'ok', args, data }, secrets);
  return data;
}

export async function diagnose(config: LoadedConfig, options: LogOptions = {}, dependencies: Dependencies = {}) {
  const now = dependencies.now?.() ?? new Date();
  const secrets = config.redactions ?? [];
  const evidence: Record<string, unknown> = {};
  const failures: Record<string, unknown> = {};
  try { evidence.simulator = redactValue(await (dependencies.resolveDevice ? dependencies.resolveDevice(config) : configuredDevice(config)), secrets); }
  catch (error) { failures.simulator = failure(error, secrets); }
  if (config.app.type === 'expo' && config.app.launchTarget === 'expo-go') evidence.host = { bundleId: redact(config.app.hostBundleId, secrets) };
  else try { evidence.build = redactValue(await state(config, dependencies), secrets); }
  catch (error) { failures.build = failure(error, secrets); }
  try { evidence.observation = await observe(config, { ...dependencies, now: () => now }); }
  catch (error) { failures.observation = failure(error, secrets); }
  try { evidence.logs = await showLogs(config, options, { ...dependencies, now: () => now }); }
  catch (error) { failures.logs = failure(error, secrets); }
  try {
    const eventsFile = path.join(config.root, '.agemu', 'events.jsonl');
    const contents = dependencies.readEvents ? await dependencies.readEvents(eventsFile) : await readFile(eventsFile, 'utf8');
    evidence.recentErrors = redactValue(String(contents).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.status === 'error').slice(-10), secrets);
  } catch { evidence.recentErrors = []; }
  const data = { generatedAt: now.toISOString(), bundleId: redact(targetBundleId(config), secrets), partial: Object.keys(failures).length > 0, evidence, failures };
  await appendEvent(config.root, { at: now.toISOString(), command: 'diagnose', status: data.partial ? 'partial' : 'ok', data }, secrets);
  return data;
}
