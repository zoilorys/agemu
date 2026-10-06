import { access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { writeLaunchMarker } from '../artifacts/launch-marker.js';
import { requireExpoGoHost } from '../native/expo-go.js';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { simctl, type Device, type SimctlRunner } from '../native/simctl.js';
import { requireBooted, runSimctl, selectedDevice, simctlFailure } from '../native/simctl-commands.js';
import type { WebSocketFactory } from '../native/js-console.js';
import { connectWebSocket } from '../native/websocket.js';
import type { RunOptions } from '../process/run-process.js';
import { readAppState, type AppState } from '../core/app-state.js';
import { server } from './server.js';

export type AppAction = 'install' | 'launch' | 'terminate' | 'restart' | 'open-url' | 'uninstall';
export type AppOptions = { arguments?: string[]; environment?: string[]; url?: string };
export type ExpoProjectDependencies = {
  serverStatus?: (config: LoadedConfig) => Promise<{ running: boolean; collision?: boolean }>;
  resolveExpoUrl?: (port: number) => Promise<string>;
  request?: typeof fetch;
  webSocket?: WebSocketFactory;
  requestTimeoutMs?: number;
};
export type AppDependencies = ExpoProjectDependencies & {
  runner?: SimctlRunner;
  listDevices?: () => Promise<Device[]>;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  readState?: (file: string) => Promise<AppState>;
  appExists?: (file: string) => Promise<void>;
};

async function checked(runner: SimctlRunner, args: string[], secrets: string[], allowStopped = false, options?: RunOptions): Promise<void> {
  await runSimctl(args, secrets, { runner }, { allowStopped, run: options });
}

// Matches simctl's app-missing wording, not generic "No such file or directory".
const notInstalled = (value: string) => /not installed/i.test(value);

export function requireUninstallable(config: LoadedConfig): void {
  if (config.app.type === 'expo' && config.app.launchTarget === 'expo-go') {
    throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo Go projects run inside the shared Expo Go host; agemu will not uninstall the host');
  }
}

async function uninstall(config: LoadedConfig, dependencies: AppDependencies) {
  requireUninstallable(config);
  const runner = dependencies.runner ?? simctl;
  const device = await selectedDevice(config, { runner, listDevices: dependencies.listDevices });
  requireBooted(device, config.redactions ?? []);
  const bundleId = targetBundleId(config);
  const secrets = config.redactions ?? [];
  const result = await runner(['uninstall', device.udid, bundleId]);
  if (result.exitCode !== 0 && notInstalled(result.stderr)) {
    return { action: 'uninstall' as const, udid: device.udid, bundleId, alreadyUninstalled: true };
  }
  if (result.exitCode !== 0) throw simctlFailure(['uninstall', device.udid, bundleId], result, secrets);
  return { action: 'uninstall' as const, udid: device.udid, bundleId };
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

export async function controlApp(config: LoadedConfig, action: AppAction, options: AppOptions = {}, dependencies: AppDependencies = {}) {
  if (action === 'uninstall') return uninstall(config, dependencies);
  const runner = dependencies.runner ?? simctl;
  const device = dependencies.resolveUdid ? undefined : await selectedDevice(config, dependencies);
  if (device) requireBooted(device, config.redactions ?? []);
  const udid = device?.udid ?? await dependencies.resolveUdid!(config);
  const stateFile = path.join(config.root, '.agemu', 'state.json');
  const secrets = config.redactions ?? [];
  const expoGo = config.app.type === 'expo' && config.app.launchTarget === 'expo-go';
  const bundleId = targetBundleId(config);
  if (expoGo) await requireExpoGoHost(udid, bundleId, runner);
  const configuration = config.app.type === 'expo' ? 'Debug' : config.app.configuration;
  const terminate = () => checked(runner, ['terminate', udid, bundleId], secrets, true);
  const launch = async () => {
    const env = launchEnvironment(options.environment ?? []);
    await writeLaunchMarker(config.root, { at: new Date(), udid, bundleId, source: `app ${action}` });
    await checked(runner, ['launch', udid, bundleId, ...(options.arguments ?? [])], secrets, false, { env });
  };

  // Like Expo CLI, approve the project scheme for the target app so SpringBoard's first "Open in …?" prompt never blocks loading.
  const openProject = async (url: string) => {
    const key = `com.apple.CoreSimulator.CoreSimulatorBridge-->${new URL(url).protocol.slice(0, -1)}`;
    await checked(runner, ['spawn', udid, 'defaults', 'write', 'com.apple.launchservices.schemeapproval', key, '-string', bundleId], secrets);
    await checked(runner, ['openurl', udid, url], secrets);
  };

  if (action === 'install') {
    if (expoGo) throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo Go uses an existing installed host; install Expo Go on the selected Simulator');
    const state = await readAppState(stateFile, secrets, dependencies.readState);
    if (state.bundleId !== bundleId || state.udid !== udid || state.configuration !== configuration) {
      throw new CliError('APP_NOT_BUILT', 'Cached app state does not match the configured app, simulator, and configuration');
    }
    try { await (dependencies.appExists ?? access)(state.appPath); }
    catch { throw new CliError('APP_NOT_BUILT', redact(`Cached app product does not exist: ${state.appPath}`, secrets)); }
    await checked(runner, ['install', udid, state.appPath], secrets);
  } else if (action === 'launch') {
    const expoUrl = config.app.type === 'expo' ? await resolveExpoProjectUrl(config, dependencies) : undefined;
    await launch();
    if (expoUrl) await openProject(expoUrl);
  } else if (action === 'terminate') {
    await terminate();
  } else if (action === 'restart') {
    const expoUrl = config.app.type === 'expo' ? await resolveExpoProjectUrl(config, dependencies) : undefined;
    await terminate();
    await launch();
    if (expoUrl) await openProject(expoUrl);
  } else {
    if (!options.url) throw new CliError('COMMAND_INVALID', 'app open-url requires --url=<url>');
    await checked(runner, ['openurl', udid, options.url], secrets);
  }
  return { action, udid, bundleId };
}

async function requireProjectServer(config: LoadedConfig, dependencies: ExpoProjectDependencies): Promise<void> {
  const status = await (dependencies.serverStatus ?? (async (value) => {
    const result = await server(value, 'status');
    return { running: 'running' in result && result.running === true, collision: 'collision' in result && result.collision === true };
  }))(config);
  if (!status.running || status.collision) throw new CliError('PROCESS_FAILED', 'Project server is not running for this project; run agemu server start');
}

async function projectRequest<T>(dependencies: ExpoProjectDependencies, secrets: string[], description: string,
  operation: (request: typeof fetch, signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = dependencies.requestTimeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new CliError('COMMAND_INVALID', 'Project request timeout must be between 1 and 60000 ms');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(dependencies.request ?? fetch, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        reject(new CliError('PROCESS_TIMEOUT', `${description} timed out after ${timeoutMs}ms`, { timeoutMs }));
        controller.abort();
      }, timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof CliError && error.code === 'PROCESS_TIMEOUT') throw error;
    throw new CliError('PROCESS_FAILED', `${description}: ${redact(error instanceof Error ? error.message : String(error), secrets)}`);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

/** Resolve only the configured, verified local Expo project; one deadline includes fallback and body reads. */
export async function resolveExpoProjectUrl(config: LoadedConfig, dependencies: ExpoProjectDependencies = {}): Promise<string> {
  const secrets = config.redactions ?? [];
  if (config.app.type !== 'expo') throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo URL requires an Expo app');
  const expoApp = config.app;
  await requireProjectServer(config, dependencies);
  const url = await projectRequest(dependencies, secrets, 'Unable to resolve Expo development URL', async (request, signal) => {
    if (dependencies.resolveExpoUrl) return dependencies.resolveExpoUrl(expoApp.port);
    const origin = `http://127.0.0.1:${expoApp.port}`;
    const options = { redirect: 'manual' as const, signal };
    let response = await request(`${origin}/_expo/open?platform=ios&runtime=${expoApp.launchTarget === 'expo-go' ? 'expo' : 'custom'}`, options);
    if (response.status === 404) {
      await response.body?.cancel();
      response = await request(`${origin}/_expo/link?platform=ios&choice=${expoApp.launchTarget === 'expo-go' ? 'expo-go' : 'expo-dev-client'}`, options);
    }
    if (response.status === 307) return response.headers.get('location') ?? '';
    if (!response.ok) throw new Error(`Expo URL endpoint returned HTTP ${response.status}`);
    const value = await response.json() as { url?: unknown };
    if (typeof value.url !== 'string') throw new Error('Expo URL endpoint did not return a URL');
    return value.url;
  });
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

// Expo returns each peer's raw upgrade query string; RN CLI may return it parsed. Apps connect with role=ios|android.
function isAppPeer(query: unknown) {
  const role = typeof query === 'string' ? new URLSearchParams(query).get('role') : typeof query === 'object' && query !== null ? (query as { role?: unknown }).role : undefined;
  return role === 'ios' || role === 'android';
}

/**
 * Expo's dev server has no `/reload` route (it answers unknown paths with the manifest), so Expo reloads are
 * broadcast on Metro's `/message` socket after `getpeers` shows at least one connected app.
 */
function broadcastReload(port: number, factory: WebSocketFactory, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = factory(`ws://127.0.0.1:${port}/message`, { headers: {} });
    const id = randomUUID();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.close();
      if (error) reject(error); else resolve();
    };
    signal.addEventListener('abort', () => finish(new Error('aborted')));
    socket.addEventListener('open', () => socket.send(JSON.stringify({ version: 2, id, target: 'server', method: 'getpeers' })));
    socket.addEventListener('message', event => {
      let value: { id?: unknown; result?: unknown };
      try { value = JSON.parse(String(event.data)); } catch { return; }
      if (value.id !== id) return;
      if (typeof value.result !== 'object' || value.result === null || !Object.values(value.result).some(isAppPeer)) {
        finish(new Error('no app is connected to the project server'));
        return;
      }
      socket.send(JSON.stringify({ version: 2, method: 'reload' }));
      finish();
    });
    socket.addEventListener('error', event => finish(new Error(event.message ?? 'message socket error')));
    socket.addEventListener('close', event => finish(new Error(`message socket closed (${event.code ?? 'unknown'})`)));
  });
}

/** Requests a Metro reload; it cannot certify that a connected app finished reloading. */
export async function reloadApp(config: LoadedConfig, dependencies: AppDependencies = {}) {
  if (config.app.type === 'native') throw new CliError('WORKFLOW_UNSUPPORTED', 'app reload requires a React Native or Expo app');
  const device = await selectedDevice(config, dependencies);
  requireBooted(device, config.redactions ?? []);
  await requireProjectServer(config, dependencies);
  const port = config.app.port;
  const expo = config.app.type === 'expo';
  await projectRequest(dependencies, config.redactions ?? [], 'Unable to request Metro reload', async (request, signal) => {
    if (expo) return broadcastReload(port, dependencies.webSocket ?? connectWebSocket, signal);
    const response = await request(`http://127.0.0.1:${port}/reload`, { method: 'GET', redirect: 'error', signal });
    if (!response.ok) throw new Error(`Metro reload returned HTTP ${response.status}`);
    await response.arrayBuffer();
  });
  return { action: 'reload' as const, udid: device.udid, bundleId: targetBundleId(config), port, reloadRequested: true };
}
