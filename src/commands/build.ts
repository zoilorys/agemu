import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { buildArguments, selectBuildProduct } from '../native/xcodebuild.js';
import { listDevices, resolveDevice } from '../native/simctl.js';
import { runProcess, type ProcessResult } from '../process/run-process.js';

export type AppState = { appPath: string; bundleId: string; executableName: string; udid: string; configuration: string; updatedAt: string };
type Dependencies = {
  run?: (executable: string, args: string[]) => Promise<ProcessResult>;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  now?: () => Date;
};

type BuildLog = { stdout: string; stderr: string; executionError?: string };

function runId(date: Date): string {
  return date.toISOString().replaceAll(':', '-');
}

async function writeAtomic(file: string, state: AppState): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function logFromError(error: unknown, secrets: string[]): BuildLog {
  const result = error instanceof CliError ? error.details?.result : undefined;
  const output = typeof result === 'object' && result !== null ? result as Partial<ProcessResult> : {};
  return {
    stdout: redact(typeof output.stdout === 'string' ? output.stdout : '', secrets),
    stderr: redact(typeof output.stderr === 'string' ? output.stderr : '', secrets),
    executionError: redact(error instanceof Error ? error.message : String(error), secrets),
  };
}

async function writeLog(file: string, log: BuildLog): Promise<void> {
  await writeFile(file, `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 });
}

export async function buildApp(config: LoadedConfig, dependencies: Dependencies = {}) {
  const run = dependencies.run ?? runProcess;
  const now = dependencies.now?.() ?? new Date();
  const udid = await (dependencies.resolveUdid
    ? dependencies.resolveUdid(config)
    : config.simulator.udid ?? listDevices().then((devices) => resolveDevice(devices, config.simulator).udid));
  const stateDirectory = path.join(config.root, '.agemu');
  const runDirectory = path.join(stateDirectory, 'runs', runId(now));
  await mkdir(runDirectory, { recursive: true });
  const secrets = config.redactions ?? [];

  const buildLog = path.join(runDirectory, 'xcodebuild.log');
  let build: ProcessResult;
  try {
    build = await run('xcodebuild', buildArguments(config, udid, 'build'));
  } catch (error) {
    await writeLog(buildLog, logFromError(error, secrets));
    throw new CliError('BUILD_FAILED', 'Unable to execute xcodebuild', { log: redact(path.relative(config.root, buildLog), secrets) });
  }
  await writeLog(buildLog, { stdout: redact(build.stdout, secrets), stderr: redact(build.stderr, secrets) });
  if (build.exitCode !== 0) {
    throw new CliError('BUILD_FAILED', 'xcodebuild failed', {
      exitCode: build.exitCode,
      signal: build.signal,
      log: redact(path.relative(config.root, buildLog), secrets),
    });
  }

  const settingsLog = path.join(runDirectory, 'build-settings.log');
  let settings: ProcessResult;
  try {
    settings = await run('xcodebuild', buildArguments(config, udid, 'settings'));
  } catch (error) {
    await writeLog(settingsLog, logFromError(error, secrets));
    throw new CliError('BUILD_FAILED', 'Unable to execute xcodebuild for build settings', { log: redact(path.relative(config.root, settingsLog), secrets) });
  }
  await writeLog(settingsLog, { stdout: redact(settings.stdout, secrets), stderr: redact(settings.stderr, secrets) });
  if (settings.exitCode !== 0) {
    throw new CliError('BUILD_FAILED', 'Unable to read build settings', {
      exitCode: settings.exitCode,
      signal: settings.signal,
      log: redact(path.relative(config.root, settingsLog), secrets),
    });
  }

  let product;
  try {
    product = selectBuildProduct(settings.stdout, config.bundleId);
  } catch (error) {
    throw new CliError('BUILD_FAILED', redact(error instanceof Error ? error.message : String(error), secrets), {
      log: redact(path.relative(config.root, settingsLog), secrets),
    });
  }
  const state: AppState = {
    appPath: product.appPath,
    bundleId: product.bundleId,
    executableName: product.executableName,
    udid,
    configuration: config.configuration,
    updatedAt: now.toISOString(),
  };
  await writeAtomic(path.join(stateDirectory, 'state.json'), state);
  return {
    appPath: redact(product.appPath, secrets),
    bundleId: redact(product.bundleId, secrets),
    executableName: redact(product.executableName, secrets),
    target: redact(product.target, secrets),
    udid: redact(udid, secrets),
    configuration: redact(config.configuration, secrets),
    derivedData: redact(path.join(stateDirectory, 'DerivedData'), secrets),
    logs: { build: redact(path.relative(config.root, buildLog), secrets), settings: redact(path.relative(config.root, settingsLog), secrets) },
  };
}
