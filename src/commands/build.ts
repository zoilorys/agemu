import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeApp, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { buildArguments, selectBuildProduct } from '../native/xcodebuild.js';
import { listDevices, resolveDevice } from '../native/simctl.js';
import { runProcess, type ProcessResult, type RunOptions } from '../process/run-process.js';

export type AppState = { appPath: string; bundleId: string; executableName: string; udid: string; configuration: string; updatedAt: string };
type Dependencies = {
  run?: (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
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
  if (config.app.type === 'expo' && config.app.launchTarget === 'expo-go') throw new CliError('WORKFLOW_UNSUPPORTED', 'Expo Go uses an existing installed host; no native build is needed');
  const run = dependencies.run ?? runProcess;
  const now = dependencies.now?.() ?? new Date();
  const udid = await (dependencies.resolveUdid
    ? dependencies.resolveUdid(config)
    : config.simulator.udid ?? listDevices().then((devices) => resolveDevice(devices, config.simulator).udid));
  const stateDirectory = path.join(config.root, '.agemu');
  const runDirectory = path.join(stateDirectory, 'runs', runId(now));
  await mkdir(runDirectory, { recursive: true });
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
      await writeLog(buildLog, logFromError(error, secrets));
      throw new CliError('BUILD_FAILED', 'Unable to execute Expo iOS build; it may have generated or changed ios/ files', { log: path.relative(config.root, buildLog) });
    }
    await writeLog(buildLog, { stdout: redact(build.stdout, secrets), stderr: redact(build.stderr, secrets) });
    if (build.exitCode !== 0) throw new CliError('BUILD_FAILED', 'Expo iOS build failed; it may have generated or changed ios/ files', { exitCode: build.exitCode, log: path.relative(config.root, buildLog) });
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
      ]);
      if (id.exitCode === 0 && id.stdout.trim() === app.bundleId && executable.exitCode === 0 && executable.stdout.trim()) {
        matches.push({ appPath, executableName: executable.stdout.trim() });
      }
    }
    if (matches.length !== 1) throw new CliError('BUILD_FAILED', `Expected one simulator .app with bundle ID ${redact(app.bundleId, secrets)} in Expo build output; found ${matches.length}. Inspect ${path.relative(config.root, buildLog)}`, { log: path.relative(config.root, buildLog) });
    const product = matches[0];
    const state: AppState = { ...product, bundleId: app.bundleId, udid, configuration: 'Debug', updatedAt: now.toISOString() };
    await writeAtomic(path.join(stateDirectory, 'state.json'), state);
    return { appPath: redact(product.appPath, secrets), bundleId: redact(app.bundleId, secrets), executableName: redact(product.executableName, secrets), udid, configuration: 'Debug', logs: { build: path.relative(config.root, buildLog) } };
  }

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
    product = selectBuildProduct(settings.stdout, nativeApp(config).bundleId);
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
    configuration: nativeApp(config).configuration,
    updatedAt: now.toISOString(),
  };
  await writeAtomic(path.join(stateDirectory, 'state.json'), state);
  return {
    appPath: redact(product.appPath, secrets),
    bundleId: redact(product.bundleId, secrets),
    executableName: redact(product.executableName, secrets),
    target: redact(product.target, secrets),
    udid: redact(udid, secrets),
    configuration: redact(nativeApp(config).configuration, secrets),
    derivedData: redact(path.join(stateDirectory, 'DerivedData'), secrets),
    logs: { build: redact(path.relative(config.root, buildLog), secrets), settings: redact(path.relative(config.root, settingsLog), secrets) },
  };
}
