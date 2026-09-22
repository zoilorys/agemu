import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { listDevices, resolveDevice, simctl, type SimctlRunner } from '../native/simctl.js';
import type { RunOptions } from '../process/run-process.js';
import type { AppState } from './build.js';

export type AppAction = 'install' | 'launch' | 'terminate' | 'restart' | 'open-url';
export type AppOptions = { arguments?: string[]; environment?: string[]; url?: string };
type Dependencies = {
  runner?: SimctlRunner;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  readState?: (file: string) => Promise<AppState>;
  appExists?: (file: string) => Promise<void>;
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
  const bundleId = config.bundleId;
  const terminate = () => checked(runner, ['terminate', udid, bundleId], secrets, true);
  const launch = () => checked(runner, [
    'launch', udid, bundleId, ...(options.arguments ?? []),
  ], secrets, false, { env: launchEnvironment(options.environment ?? []) });

  if (action === 'install') {
    const state = dependencies.readState
      ? await dependencies.readState(stateFile)
      : await defaultState(stateFile, secrets);
    if (state.bundleId !== bundleId || state.udid !== udid || state.configuration !== config.configuration) {
      throw new CliError('APP_NOT_BUILT', 'Cached app state does not match the configured app, simulator, and configuration');
    }
    try { await (dependencies.appExists ?? access)(state.appPath); }
    catch { throw new CliError('APP_NOT_BUILT', redact(`Cached app product does not exist: ${state.appPath}`, secrets)); }
    await checked(runner, ['install', udid, state.appPath], secrets);
  } else if (action === 'launch') {
    await launch();
  } else if (action === 'terminate') {
    await terminate();
  } else if (action === 'restart') {
    await terminate();
    await launch();
  } else {
    if (!options.url) throw new CliError('COMMAND_INVALID', 'app open-url requires --url=<url>');
    await checked(runner, ['openurl', udid, options.url], secrets);
  }
  return { action, udid, bundleId };
}
