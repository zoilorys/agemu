import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { loadConfig, nativeApp, type LoadedConfig } from '../config/config.js';
import { listDevices, resolveDevice, type Device } from '../native/simctl.js';
import { runProcess, type ProcessResult } from '../process/run-process.js';

export type Check = { ok: boolean; message: string };
export type DoctorResult = { ready: boolean; checks: Record<string, Check> };
type Dependencies = {
  root?: string;
  nodeVersion?: string;
  loadConfig?: (root: string) => Promise<LoadedConfig>;
  run?: (executable: string, args: string[]) => Promise<ProcessResult>;
  listDevices?: () => Promise<Device[]>;
  resolveDevice?: typeof resolveDevice;
  canWrite?: (directory: string) => Promise<void>;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const passed = (result: ProcessResult, fallback: string): Check => result.exitCode === 0
  ? { ok: true, message: 'available' }
  : { ok: false, message: result.stderr || fallback };

export async function doctor(dependencies: Dependencies = {}): Promise<DoctorResult> {
  const root = dependencies.root ?? process.cwd();
  const run = dependencies.run ?? runProcess;
  const readConfig = dependencies.loadConfig ?? loadConfig;
  const devices = dependencies.listDevices ?? listDevices;
  const selectDevice = dependencies.resolveDevice ?? resolveDevice;
  const canWrite = dependencies.canWrite ?? (async (directory: string) => {
    const stateDirectory = path.join(directory, '.agemu');
    try {
      const metadata = await stat(stateDirectory);
      if (!metadata.isDirectory()) throw new Error(`${stateDirectory} must be a directory`);
      await access(stateDirectory, constants.W_OK | constants.X_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await access(directory, constants.W_OK | constants.X_OK);
    }
  });
  const checks: Record<string, Check> = {};

  checks.node = Number((dependencies.nodeVersion ?? process.versions.node).split('.')[0]) >= 24
    ? { ok: true, message: dependencies.nodeVersion ?? process.version }
    : { ok: false, message: `Node.js ${dependencies.nodeVersion ?? process.version} is below 24` };
  for (const [name, executable, args] of [
    ['xcode', 'xcodebuild', ['-version']],
    ['simctl', 'xcrun', ['simctl', 'help']],
  ] as const) {
    try { checks[name] = passed(await run(executable, [...args]), `${executable} failed`); }
    catch (error) { checks[name] = { ok: false, message: message(error) }; }
  }

  let config: LoadedConfig | undefined;
  try {
    config = await readConfig(root);
    checks.config = { ok: true, message: 'valid' };
  } catch (error) {
    config = undefined;
    checks.config = { ok: false, message: message(error) };
  }

  if (!config) {
    for (const name of ['project', 'scheme', 'simulator'] as const) checks[name] = { ok: false, message: 'configuration is unavailable' };
  } else if (config.app.type === 'expo') {
    const unsupported = `${config.app.type} workflow is not implemented yet`;
    checks.workflow = { ok: false, message: unsupported };
    checks.project = { ok: false, message: unsupported };
    checks.scheme = { ok: false, message: unsupported };
    try {
      selectDevice(await devices(), config.simulator);
      checks.simulator = { ok: true, message: 'resolved' };
    } catch (error) { checks.simulator = { ok: false, message: message(error) }; }
  } else {
    const app = nativeApp(config);
    if (app.type === 'react-native') {
      try { await access(path.join(app.root, 'node_modules', 'react-native', 'package.json')); checks.reactNative = { ok: true, message: 'local React Native installed' }; }
      catch { checks.reactNative = { ok: false, message: 'Install project dependencies: node_modules/react-native is missing' }; }
      try { await access(path.join(app.root, 'ios')); checks.ios = { ok: true, message: 'ios/ exists' }; }
      catch { checks.ios = { ok: false, message: 'React Native ios/ directory is missing' }; }
    }
    const source = app.project ?? app.workspace!;
    try {
      await access(source, constants.F_OK);
      checks.project = { ok: true, message: path.relative(root, source) || '.' };
    } catch (error) { checks.project = { ok: false, message: message(error) }; }
    try {
      const arguments_ = [app.project ? '-project' : '-workspace', source, '-scheme', app.scheme, '-configuration', app.configuration, '-showBuildSettings'];
      checks.scheme = passed(await run('xcodebuild', arguments_), `Scheme ${app.scheme} failed validation`);
    } catch (error) { checks.scheme = { ok: false, message: message(error) }; }
    try {
      selectDevice(await devices(), config.simulator);
      checks.simulator = { ok: true, message: 'resolved' };
    } catch (error) { checks.simulator = { ok: false, message: message(error) }; }
  }
  try {
    await canWrite(root);
    checks.stateDirectory = { ok: true, message: '.agemu/ can be created' };
  } catch (error) { checks.stateDirectory = { ok: false, message: message(error) }; }
  const ready = Object.values(checks).every((check) => check.ok);
  return { ready, checks };
}
