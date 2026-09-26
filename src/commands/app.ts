import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { requireExpoGoHost } from '../native/expo-go.js';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { listDevices, resolveDevice, simctl, type SimctlRunner } from '../native/simctl.js';
import type { RunOptions } from '../process/run-process.js';
import type { AppState } from './build.js';
import { server } from './server.js';

export type AppAction = 'install' | 'launch' | 'terminate' | 'restart' | 'open-url';
export type AppOptions = { arguments?: string[]; environment?: string[]; url?: string };
type Dependencies = {
  runner?: SimctlRunner;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  readState?: (file: string) => Promise<AppState>;
  appExists?: (file: string) => Promise<void>;
  serverStatus?: (config: LoadedConfig) => Promise<{ running: boolean; collision?: boolean }>;
  resolveExpoUrl?: (port: number) => Promise<string>;
};

const stopped = (value: string) => /not running|no such process|found nothing to terminate/i.test(value);

async function checked(runner: SimctlRunner, args: string[], secrets: string[], allowStopped = false, options?: RunOptions): Promise<void> {
  const result = await runner(args, options);
  if (result.exitCode !== 0 && !(allowStopped && stopped(result.stderr))) {
    throw new CliError('PROCESS_FAILED', redact(result.stderr.trim() || `simctl ${args[0]} failed`, secrets), {
      command: ['xcrun', 'simctl', ...args].map((value) => redact(value, secrets)), exitCode: result.exitCode, signal: result.signal,
    });
  }
}

function launchEnvironment(values: string[]): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const value of values) {
    const separator = value.indexOf('=');
    const name = value.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new CliError('COMMAND_INVALID', '--env must use KEY=VALUE with a valid environment variable name');
    }
    environment[`SIMCTL_CHILD_${name}`] = value.slice(separator + 1);
  }
  return environment;
}

async function defaultState(file: string, secrets: string[]): Promise<AppState> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as AppState;
  } catch (error) {
    throw new CliError('APP_NOT_BUILT', redact(`Cannot read app state: ${error instanceof Error ? error.message : String(error)}`, secrets));
  }
}

export async function controlApp(config: LoadedConfig, action: AppAction, options: AppOptions = {}, dependencies: Dependencies = {}) {
  const runner = dependencies.runner ?? simctl;
  const udid = await (dependencies.resolveUdid
    ? dependencies.resolveUdid(config)
    : config.simulator.udid ?? listDevices().then((devices) => resolveDevice(devices, config.simulator).udid));
  const stateFile = path.join(config.root, '.agemu', 'state.json');
  const secrets = config.redactions ?? [];
  const expoGo = config.app.type === 'expo' && config.app.launchTarget === 'expo-go';
  const bundleId = targetBundleId(config);
  if (expoGo) await requireExpoGoHost(udid, bundleId, runner);
  const configuration = config.app.type === 'expo' ? 'Debug' : config.app.configuration;
  const terminate = () => checked(runner, ['terminate', udid, bundleId], secrets, true);
  const launch = () => checked(runner, [
    'launch', udid, bundleId, ...(options.arguments ?? []),
  ], secrets, false, { env: launchEnvironment(options.environment ?? []) });

  if (action === 'install') {
    if (expoGo) throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo Go uses an existing installed host; install Expo Go on the selected Simulator');
    const state = dependencies.readState
      ? await dependencies.readState(stateFile)
      : await defaultState(stateFile, secrets);
    if (state.bundleId !== bundleId || state.udid !== udid || state.configuration !== configuration) {
      throw new CliError('APP_NOT_BUILT', 'Cached app state does not match the configured app, simulator, and configuration');
    }
    try { await (dependencies.appExists ?? access)(state.appPath); }
    catch { throw new CliError('APP_NOT_BUILT', redact(`Cached app product does not exist: ${state.appPath}`, secrets)); }
    await checked(runner, ['install', udid, state.appPath], secrets);
  } else if (action === 'launch') {
    const expoUrl = config.app.type === 'expo' ? await resolveExpoProjectUrl(config, secrets, dependencies) : undefined;
    await launch();
    if (expoUrl) await checked(runner, ['openurl', udid, expoUrl], secrets);
  } else if (action === 'terminate') {
    await terminate();
  } else if (action === 'restart') {
    const expoUrl = config.app.type === 'expo' ? await resolveExpoProjectUrl(config, secrets, dependencies) : undefined;
    await terminate();
    await launch();
    if (expoUrl) await checked(runner, ['openurl', udid, expoUrl], secrets);
  } else {
    if (!options.url) throw new CliError('COMMAND_INVALID', 'app open-url requires --url=<url>');
    await checked(runner, ['openurl', udid, options.url], secrets);
  }
  return { action, udid, bundleId };
}

async function resolveExpoProjectUrl(config: LoadedConfig, secrets: string[], dependencies: Dependencies): Promise<string> {
  if (config.app.type !== 'expo') throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo URL requires an Expo app');
  const expoApp = config.app;
  const status = await (dependencies.serverStatus ?? (async (value) => { const result = await server(value, 'status'); return { running: 'running' in result && result.running === true, collision: 'collision' in result && result.collision === true }; }))(config);
  if (!status.running || status.collision) throw new CliError('PROCESS_FAILED', 'Expo project server is not running for this project; run agemu server start');
  const url = await (dependencies.resolveExpoUrl ?? (async (port) => {
    let response = await fetch(`http://127.0.0.1:${port}/_expo/open?platform=ios&runtime=${expoApp.launchTarget === 'expo-go' ? 'expo' : 'custom'}`, { redirect: 'manual' });
    if (response.status === 404) response = await fetch(`http://127.0.0.1:${port}/_expo/link?platform=ios&choice=${expoApp.launchTarget === 'expo-go' ? 'expo-go' : 'expo-dev-client'}`, { redirect: 'manual' });
    if (response.status === 307) return response.headers.get('location') ?? '';
    if (!response.ok) throw new Error(`Expo URL endpoint returned HTTP ${response.status}`);
    const value = await response.json() as { url?: unknown };
    if (typeof value.url !== 'string') throw new Error('Expo URL endpoint did not return a URL');
    return value.url;
  }))(config.app.port).catch((error: unknown) => { throw new CliError('PROCESS_FAILED', `Unable to resolve Expo development URL: ${redact(error instanceof Error ? error.message : String(error), secrets)}`); });
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CliError('PROCESS_FAILED', 'Expo returned an invalid development URL'); }
  const project = parsed.searchParams.get('url');
  let projectUrl: URL | undefined;
  try { projectUrl = project ? new URL(project) : undefined; } catch { /* Reject malformed nested URL. */ }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) localHosts.add(address.address);
  if (config.app.launchTarget === 'expo-go') {
    if (parsed.protocol !== 'exp:' || parsed.port !== String(config.app.port) || !localHosts.has(parsed.hostname))
      throw new CliError('PROCESS_FAILED', 'Expo returned a stale or non-Expo Go URL for this project');
  } else if (!parsed.protocol.startsWith('exp+') || parsed.hostname !== 'expo-development-client' ||
      !projectUrl || !['http:', 'https:'].includes(projectUrl.protocol) ||
      projectUrl.port !== String(config.app.port) || !localHosts.has(projectUrl.hostname)) {
    throw new CliError('PROCESS_FAILED', 'Expo returned a stale or non-custom development URL for this project');
  }
  return url;
}
