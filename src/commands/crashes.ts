import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRun, redactValue } from '../artifacts/runs.js';
import type { AppState } from './build.js';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { findCrashReports, type CrashSummary } from '../native/crash-reports.js';
import { installedExpoGoHost } from '../native/expo-go.js';
import { listDevices, resolveDevice, simctl, type Device, type SimctlRunner } from '../native/simctl.js';
import { resolveSince } from './since.js';

/** `since` is `launch` or a duration such as `2h`; without it, `sinceMs` (default 24 h) counts back from now. */
export type CrashOptions = { since?: string; sinceMs?: number; limit?: number };
export type CrashDependencies = {
  directory?: string;
  now?: () => Date;
  readState?: (file: string) => Promise<AppState>;
  resolveDevice?: (config: LoadedConfig) => Promise<Device>;
  runner?: SimctlRunner;
};

export const defaultCrashDirectory = () => path.join(homedir(), 'Library', 'Logs', 'DiagnosticReports');

// Best effort: the bundle ID is the primary match; the executable name only matches reports without one.
async function executableName(config: LoadedConfig, dependencies: CrashDependencies): Promise<string | undefined> {
  try {
    if (config.app.type === 'expo' && config.app.launchTarget === 'expo-go') {
      const device = dependencies.resolveDevice ? await dependencies.resolveDevice(config) : resolveDevice(await listDevices(), config.simulator);
      return (await installedExpoGoHost(device.udid, config.app.hostBundleId, dependencies.runner ?? simctl)).executableName;
    }
    const file = path.join(config.root, '.agemu', 'state.json');
    const state = dependencies.readState ? await dependencies.readState(file) : JSON.parse(await readFile(file, 'utf8')) as AppState;
    return state.bundleId === targetBundleId(config) && state.executableName ? state.executableName : undefined;
  } catch { return undefined; }
}

export async function listCrashes(config: LoadedConfig, options: CrashOptions = {}, dependencies: CrashDependencies = {}) {
  const secrets = config.redactions ?? [];
  const sinceMs = options.sinceMs ?? 24 * 3_600_000;
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) throw new CliError('COMMAND_INVALID', '--since must be a number followed by s, m, h, or d');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CliError('COMMAND_INVALID', '--limit must be an integer from 1 to 100');
  const now = dependencies.now?.() ?? new Date();
  const bundleId = targetBundleId(config);
  const udid = options.since === 'launch'
    ? (dependencies.resolveDevice ? await dependencies.resolveDevice(config) : resolveDevice(await listDevices(), config.simulator)).udid
    : undefined;
  const window = await resolveSince(options.since, config.root, now, sinceMs, { bundleId, udid });
  const since = window.start;
  const [run, executable] = await Promise.all([createRun(config.root, now), executableName(config, dependencies)]);
  const found = await findCrashReports({ directory: dependencies.directory ?? defaultCrashDirectory(), since, bundleId, executableName: executable, limit });
  const directory = path.join(run.directory, 'crashes');
  const crashes: Array<CrashSummary & { source: string }> = [];
  if (found.crashes.length > 0) await mkdir(directory, { recursive: true });
  for (const crash of found.crashes) {
    const source = path.basename(crash.path);
    const copy = path.join(directory, source);
    await writeFile(copy, redact(crash.text, secrets), { mode: 0o600 });
    crashes.push({ ...crash.summary, file: path.relative(config.root, copy), source });
  }
  return redactValue({ run: run.relativeDirectory, bundleId, since: since.toISOString(), crashes, skipped: found.skipped }, secrets);
}
