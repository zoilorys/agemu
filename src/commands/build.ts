import { access, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRun, redactValue } from '../artifacts/runs.js';
import { nativeApp, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import type { AppState } from '../core/app-state.js';
import { redact } from '../core/redact.js';
import { buildFailureDetails, writeBuildLog, type BuildLog } from '../native/build-errors.js';
import { buildArguments, selectBuildProduct } from '../native/xcodebuild.js';
import { listDevices, resolveDevice } from '../native/simctl.js';
import { deadline, runProcess, type ProcessResult, type RunOptions } from '../process/run-process.js';

export type { AppState } from '../core/app-state.js';
export type BuildResult = Omit<AppState, 'updatedAt'> & {
  appType: LoadedConfig['app']['type']; target: string | null; derivedData: string | null;
  run: string; logs: { build: string; settings: string | null };
};
type Dependencies = {
  run?: (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
  resolveUdid?: (config: LoadedConfig) => Promise<string>;
  now?: () => Date;
  /** Deadline for the whole command; defaults to 30 minutes. */
  timeoutMs?: number;
};

export const defaultBuildTimeoutMs = 1_800_000;

const timedOut = (error: unknown) => error instanceof CliError && error.code === 'PROCESS_TIMEOUT';

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

const writeLog = writeBuildLog;

export async function buildApp(config: LoadedConfig, dependencies: Dependencies = {}): Promise<BuildResult> {
  if (config.app.type === 'expo' && config.app.launchTarget === 'expo-go') throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo Go uses an existing installed host; no native build is needed');
  const limit = deadline(dependencies.timeoutMs ?? defaultBuildTimeoutMs);
  const baseRun = dependencies.run ?? runProcess;
  const run = (executable: string, args: string[], options: RunOptions = {}) => baseRun(executable, args, { ...options, timeoutMs: limit.remaining() });
  const timeoutError = (log: string) => new CliError('PROCESS_TIMEOUT', `Build exceeded ${limit.ms / 1000} s`, {
    log: redact(path.relative(config.root, log), config.redactions ?? []), timeoutSeconds: limit.ms / 1000,
  });
  const now = dependencies.now?.() ?? new Date();
  const udid = await (dependencies.resolveUdid
    ? dependencies.resolveUdid(config)
    : config.simulator.udid ?? listDevices().then((devices) => resolveDevice(devices, config.simulator).udid));
  const stateDirectory = path.join(config.root, '.agemu');
  const createdRun = await createRun(config.root, now);
  const runDirectory = createdRun.directory;
  const secrets = config.redactions ?? [];

  if (config.app.type === 'expo') {
    if (config.app.launchTarget !== 'development-build') throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo Go does not have a local app build');
    const app = config.app;
    const cli = path.join(app.root, 'node_modules', 'expo', 'bin', 'cli');
    try { await access(cli); } catch { throw new CliError('TOOL_NOT_FOUND', 'Local Expo CLI is missing; install project dependencies'); }
    try { await access(path.join(app.root, 'node_modules', 'expo-dev-client', 'package.json')); }
    catch { throw new CliError('TOOL_NOT_FOUND', 'expo-dev-client is missing; install it in the Expo project before building'); }
    const buildLog = path.join(runDirectory, 'expo-build.log');
    let build: ProcessResult;
    try {
      build = await run(process.execPath, [cli, 'run:ios', '--device', udid, '--no-bundler'], { cwd: app.root });
    } catch (error) {
      const log = logFromError(error, secrets);
      await writeLog(buildLog, log);
      if (timedOut(error)) throw timeoutError(buildLog);
      throw new CliError('BUILD_FAILED', 'Unable to execute Expo iOS build; it may have generated or changed ios/ files', {
        log: redact(path.relative(config.root, buildLog), secrets), ...buildFailureDetails(log.stdout, log.stderr, secrets),
      });
    }
    await writeLog(buildLog, { stdout: redact(build.stdout, secrets), stderr: redact(build.stderr, secrets) });
    if (build.exitCode !== 0) throw new CliError('BUILD_FAILED', 'Expo iOS build failed; it may have generated or changed ios/ files', {
      exitCode: build.exitCode, log: redact(path.relative(config.root, buildLog), secrets), ...buildFailureDetails(build.stdout, build.stderr, secrets),
    });
    const candidates: string[] = [];
    for (const match of build.stdout.matchAll(/\/(?:[^\s=]|\\ )+?\.app(?=\s|$)/gm)) candidates.push(match[0].replaceAll('\\ ', ' '));
    const directories = [...build.stdout.matchAll(/CONFIGURATION_BUILD_DIR\s*=\s*(\S+)/g)].map(match => match[1].replaceAll('\\ ', ' '));
    const wrappers = [...build.stdout.matchAll(/UNLOCALIZED_RESOURCES_FOLDER_PATH\s*=\s*(\S+\.app)/g)].map(match => match[1].replaceAll('\\ ', ' '));
    for (const directory of directories) for (const wrapper of wrappers) candidates.push(path.join(directory, wrapper));
    const matches: Array<{ appPath: string; executableName: string }> = [];
    for (const appPath of [...new Set(candidates)]) {
      const info = path.join(appPath, 'Info.plist');
      try { await access(info); } catch { continue; }
      const [id, executable] = await Promise.all([
        run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info]),
        run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', info]),
      ]).catch((error: unknown) => { throw timedOut(error) ? timeoutError(buildLog) : error; });
      if (id.exitCode === 0 && id.stdout.trim() === app.bundleId && executable.exitCode === 0 && executable.stdout.trim()) {
        matches.push({ appPath, executableName: executable.stdout.trim() });
      }
    }
    if (matches.length !== 1) throw new CliError('BUILD_FAILED', `Expected one simulator .app with bundle ID ${redact(app.bundleId, secrets)} in Expo build output; found ${matches.length}. Inspect ${path.relative(config.root, buildLog)}`, { log: redact(path.relative(config.root, buildLog), secrets), ...buildFailureDetails(build.stdout, build.stderr, secrets) });
    const product = matches[0];
    const state: AppState = { ...product, bundleId: app.bundleId, udid, configuration: 'Debug', updatedAt: now.toISOString() };
    await writeAtomic(path.join(stateDirectory, 'state.json'), state);
    return redactValue({
      ...product, appType: config.app.type, bundleId: app.bundleId, udid, configuration: 'Debug',
      target: null, derivedData: null, run: createdRun.relativeDirectory,
      logs: { build: path.relative(config.root, buildLog), settings: null },
    }, secrets);
  }

  const buildLog = path.join(runDirectory, 'xcodebuild.log');
  let build: ProcessResult;
  try {
    build = await run('xcodebuild', buildArguments(config, udid, 'build'));
  } catch (error) {
    const log = logFromError(error, secrets);
    await writeLog(buildLog, log);
    if (timedOut(error)) throw timeoutError(buildLog);
    throw new CliError('BUILD_FAILED', 'Unable to execute xcodebuild', {
      log: redact(path.relative(config.root, buildLog), secrets), ...buildFailureDetails(log.stdout, log.stderr, secrets),
    });
  }
  await writeLog(buildLog, { stdout: redact(build.stdout, secrets), stderr: redact(build.stderr, secrets) });
  if (build.exitCode !== 0) {
    throw new CliError('BUILD_FAILED', 'xcodebuild failed', {
      exitCode: build.exitCode,
      signal: build.signal,
      log: redact(path.relative(config.root, buildLog), secrets),
      ...buildFailureDetails(build.stdout, build.stderr, secrets),
    });
  }

  const settingsLog = path.join(runDirectory, 'build-settings.log');
  let settings: ProcessResult;
  try {
    settings = await run('xcodebuild', buildArguments(config, udid, 'settings'));
  } catch (error) {
    const log = logFromError(error, secrets);
    await writeLog(settingsLog, log);
    if (timedOut(error)) throw timeoutError(settingsLog);
    throw new CliError('BUILD_FAILED', 'Unable to execute xcodebuild for build settings', {
      log: redact(path.relative(config.root, settingsLog), secrets), ...buildFailureDetails(log.stdout, log.stderr, secrets),
    });
  }
  await writeLog(settingsLog, { stdout: redact(settings.stdout, secrets), stderr: redact(settings.stderr, secrets) });
  if (settings.exitCode !== 0) {
    throw new CliError('BUILD_FAILED', 'Unable to read build settings', {
      exitCode: settings.exitCode,
      signal: settings.signal,
      log: redact(path.relative(config.root, settingsLog), secrets),
      ...buildFailureDetails(settings.stdout, settings.stderr, secrets),
    });
  }

  let product;
  try {
    product = selectBuildProduct(settings.stdout, nativeApp(config).bundleId);
  } catch (error) {
    throw new CliError('BUILD_FAILED', redact(error instanceof Error ? error.message : String(error), secrets), {
      log: redact(path.relative(config.root, settingsLog), secrets),
      ...buildFailureDetails(settings.stdout, settings.stderr, secrets),
    });
  }
  const state: AppState = {
    appPath: product.appPath,
    bundleId: product.bundleId,
    executableName: product.executableName,
    udid,
    configuration: nativeApp(config).configuration,
    updatedAt: now.toISOString(),
  };
  await writeAtomic(path.join(stateDirectory, 'state.json'), state);
  return redactValue({
    appType: config.app.type, appPath: product.appPath, bundleId: product.bundleId,
    executableName: product.executableName, target: product.target, udid,
    configuration: nativeApp(config).configuration,
    derivedData: path.join(stateDirectory, 'DerivedData'),
    run: createdRun.relativeDirectory,
    logs: { build: path.relative(config.root, buildLog), settings: path.relative(config.root, settingsLog) },
  }, secrets);
}
