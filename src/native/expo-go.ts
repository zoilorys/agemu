import { CliError } from '../core/errors.js';
import { simctl, type SimctlRunner } from './simctl.js';

const knownHosts = new Set(['host.exp.Exponent']);

async function installedApps(udid: string, runner: SimctlRunner): Promise<Array<{ bundleId: string; executableName: string; expoGo: boolean }>> {
  const result = await runner(['listapps', udid]);
  if (result.exitCode !== 0) throw new CliError('PROCESS_FAILED', result.stderr.trim() || 'Cannot list installed Simulator apps');
  const apps: Array<{ bundleId: string; executableName: string; expoGo: boolean }> = [];
  const entries = result.stdout.split(/(?=^\s{4}\S+\s*=\s*\{)/m);
  for (const entry of entries) {
    const bundleId = entry.match(/\bCFBundleIdentifier\s*=\s*"?([A-Za-z0-9.-]+)"?/)?.[1];
    if (!bundleId) continue;
    const executableName = entry.match(/\bCFBundleExecutable\s*=\s*\"?([A-Za-z0-9._-]+)\"?/)?.[1] ?? '';
    const names = [...entry.matchAll(/\b(?:CFBundleDisplayName|CFBundleName)\s*=\s*"?([^";\n]+)"?\s*;/g)].map(match => match[1].trim());
    apps.push({ bundleId, executableName, expoGo: knownHosts.has(bundleId) || names.some(name => /^Expo Go$/i.test(name)) });
  }
  return apps;
}

export async function installedExpoGoHosts(udid: string, runner: SimctlRunner = simctl): Promise<string[]> {
  return [...new Set((await installedApps(udid, runner)).filter(app => app.expoGo).map(app => app.bundleId))].sort();
}

export async function requireExpoGoHost(udid: string, hostBundleId: string, runner: SimctlRunner = simctl): Promise<void> {
  if (!(await installedApps(udid, runner)).some(app => app.bundleId === hostBundleId && app.expoGo)) {
    throw new CliError('PROCESS_FAILED', `Expo Go host ${hostBundleId} is not installed on Simulator ${udid}; install Expo Go, then retry`);
  }
}

export async function installedExpoGoHost(udid: string, hostBundleId: string, runner: SimctlRunner = simctl): Promise<{ bundleId: string; executableName: string }> {
  const host = (await installedApps(udid, runner)).find(app => app.bundleId === hostBundleId && app.expoGo);
  if (!host) throw new CliError('PROCESS_FAILED', `Expo Go host ${hostBundleId} is not installed on Simulator ${udid}; install Expo Go, then retry`);
  if (!host.executableName) throw new CliError('PROCESS_FAILED', `Cannot identify the executable for Expo Go host ${hostBundleId}`);
  return host;
}
