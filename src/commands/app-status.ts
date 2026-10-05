import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { requireBooted, runSimctl, selectedDevice, type SimctlDeps } from '../native/simctl-commands.js';
import { runProcess } from '../process/run-process.js';

export type InstalledApp = {
  bundleId: string;
  name: string | null;
  executableName: string | null;
  type: string | null;
};
export type AppInventoryDependencies = SimctlDeps & { decodeApps?: (plist: string) => Promise<unknown> };
export type AppStatus = {
  action: 'status'; udid: string; bundleId: string;
  running: boolean | null; foreground: boolean | null; pid: number | null;
  unavailable: { running: string | null; foreground: string; pid: string | null };
};

async function decodeApps(plist: string): Promise<unknown> {
  // simctl emits an OpenStep plist; let Apple's parser handle quoted names and nested values.
  const directory = await mkdtemp(path.join(tmpdir(), 'agemu-apps-'));
  const file = path.join(directory, 'apps.plist');
  try {
    await writeFile(file, plist, { mode: 0o600 });
    const result = await runProcess('plutil', ['-convert', 'json', '-o', '-', file], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new CliError('PROCESS_FAILED', 'simctl returned invalid installed application data');
    return JSON.parse(result.stdout) as unknown;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function listInstalledApps(config: LoadedConfig, dependencies: AppInventoryDependencies = {}) {
  const device = await selectedDevice(config, dependencies);
  requireBooted(device, config.redactions ?? []);
  const secrets = config.redactions ?? [];
  const listed = await runSimctl(['listapps', device.udid], secrets, dependencies, { run: { timeoutMs: 10_000 } });
  let value: unknown;
  try { value = await (dependencies.decodeApps ?? decodeApps)(listed.stdout); }
  catch (error) {
    if (error instanceof CliError && error.code === 'PROCESS_TIMEOUT') throw error;
    throw new CliError('PROCESS_FAILED', 'simctl returned invalid installed application data');
  }
  if (!record(value)) throw new CliError('PROCESS_FAILED', 'simctl returned invalid installed application data');
  const apps: InstalledApp[] = [];
  for (const [key, app] of Object.entries(value)) {
    if (!record(app) || typeof app.CFBundleIdentifier !== 'string' || app.CFBundleIdentifier !== key) {
      throw new CliError('PROCESS_FAILED', 'simctl returned invalid installed application data');
    }
    apps.push({ bundleId: key,
      name: typeof app.CFBundleDisplayName === 'string' ? app.CFBundleDisplayName : typeof app.CFBundleName === 'string' ? app.CFBundleName : null,
      executableName: typeof app.CFBundleExecutable === 'string' ? app.CFBundleExecutable : null,
      type: typeof app.ApplicationType === 'string' ? app.ApplicationType : null });
  }
  apps.sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  return { action: 'list' as const, udid: device.udid, apps };
}

/** The exact UIKit service label is evidence; executable names and substring matches are not. */
export function appProcessEvidence(listing: string, bundleId: string): { running: boolean | null; pid: number | null } {
  const lines = listing.trim().split(/\r?\n/).filter(Boolean);
  let valid = false;
  const matches: Array<number | null> = [];
  for (const line of lines) {
    if (/^PID\s+Status\s+Label\s*$/.test(line.trim())) { valid = true; continue; }
    const row = line.trim().match(/^(\d+|-)\s+(-?\d+)\s+(\S+)$/);
    if (!row) return { running: null, pid: null };
    valid = true;
    const label = row[3].match(/^UIKitApplication:([^\[]+)\[[^\]]+\](?:\[[^\]]+\])*$/);
    if (label?.[1] === bundleId) {
      const pid = row[1] === '-' ? null : Number(row[1]);
      if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) return { running: null, pid: null };
      matches.push(pid);
    }
  }
  if (!valid || matches.length > 1) return { running: null, pid: null };
  return { running: matches.length === 1 && matches[0] !== null, pid: matches[0] ?? null };
}

export async function appStatus(config: LoadedConfig, dependencies: SimctlDeps = {}): Promise<AppStatus> {
  const device = await selectedDevice(config, dependencies);
  requireBooted(device, config.redactions ?? []);
  const bundleId = targetBundleId(config);
  const secrets = config.redactions ?? [];
  let evidence: ReturnType<typeof appProcessEvidence> = { running: null, pid: null };
  let unavailable: string | null = 'Simulator process evidence is unavailable or ambiguous';
  try {
    const result = await runSimctl(['spawn', device.udid, 'launchctl', 'list'], secrets, dependencies, { run: { timeoutMs: 10_000 } });
    evidence = appProcessEvidence(result.stdout, bundleId);
    if (evidence.running !== null) unavailable = null;
  } catch (error) {
    unavailable = redact(error instanceof Error ? error.message : String(error), secrets);
  }
  return { action: 'status', udid: device.udid, bundleId, ...evidence, foreground: null,
    unavailable: { running: unavailable, foreground: 'simctl does not expose reliable foreground application state',
      pid: unavailable ?? (evidence.pid === null ? 'App has no running UIKit process' : null) } };
}
