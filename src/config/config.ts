import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../core/errors.js';

export type SimulatorSelector = { udid?: string; name?: string; runtime?: string };
type Xcode = { project: string; workspace?: never } | { workspace: string; project?: never };
export type NativeApp = { type: 'native'; scheme: string; configuration: string; bundleId: string } & Xcode;
export type ReactNativeApp = { type: 'react-native'; root: string; port: number; scheme: string; configuration: string; bundleId: string } & Xcode;
export type ExpoApp = { type: 'expo'; root: string; port: number } & ({ launchTarget: 'development-build'; bundleId: string } | { launchTarget: 'expo-go'; hostBundleId: string });
export type DebugConfig = { version: 2; platform: 'ios'; app: NativeApp | ReactNativeApp | ExpoApp; simulator: SimulatorSelector; redactions?: string[] };
export type LoadedConfig = DebugConfig & { root: string };
type Issue = { path: string; message: string };

const topKeys = new Set(['version', 'platform', 'app', 'simulator', 'redactions']);
const simulatorKeys = new Set(['udid', 'name', 'runtime']);
const appKeys: Record<string, Set<string>> = {
  native: new Set(['type', 'project', 'workspace', 'scheme', 'configuration', 'bundleId']),
  'react-native': new Set(['type', 'root', 'port', 'project', 'workspace', 'scheme', 'configuration', 'bundleId']),
  expo: new Set(['type', 'root', 'port', 'launchTarget', 'bundleId', 'hostBundleId']),
};
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function required(app: Record<string, unknown>, key: string, issues: Issue[]) {
  if (!nonempty(app[key])) issues.push({ path: `app.${key}`, message: 'must be a non-empty string' });
}
function validate(value: unknown): Issue[] {
  if (!record(value)) return [{ path: '$', message: 'must be an object' }];
  const issues: Issue[] = [];
  for (const key of Object.keys(value)) if (!topKeys.has(key)) issues.push({ path: key, message: 'is not allowed' });
  if (value.version !== 2) issues.push({ path: 'version', message: 'must be 2' });
  if (value.platform !== 'ios') issues.push({ path: 'platform', message: 'must be ios' });
  if (!record(value.app)) issues.push({ path: 'app', message: 'must be an object' });
  else {
    const app = value.app;
    const allowed = typeof app.type === 'string' ? appKeys[app.type] : undefined;
    if (!allowed) issues.push({ path: 'app.type', message: 'must be native, react-native, or expo' });
    else {
      for (const key of Object.keys(app)) if (!allowed.has(key)) issues.push({ path: `app.${key}`, message: 'is not allowed' });
      if (app.type === 'native' || app.type === 'react-native') {
        for (const key of ['scheme', 'configuration', 'bundleId']) required(app, key, issues);
        for (const key of ['project', 'workspace']) if (app[key] !== undefined && !nonempty(app[key])) required(app, key, issues);
        if (Number(nonempty(app.project)) + Number(nonempty(app.workspace)) !== 1) {
          for (const key of ['project', 'workspace']) issues.push({ path: `app.${key}`, message: 'exactly one of project or workspace is required' });
        }
      }
      if (app.type === 'react-native' || app.type === 'expo') {
        required(app, 'root', issues);
        if (!Number.isInteger(app.port) || (app.port as number) < 1 || (app.port as number) > 65535) issues.push({ path: 'app.port', message: 'must be an integer from 1 to 65535' });
      }
      if (app.type === 'expo') {
        if (app.launchTarget !== 'development-build' && app.launchTarget !== 'expo-go') issues.push({ path: 'app.launchTarget', message: 'must be development-build or expo-go' });
        if (app.launchTarget === 'development-build') { required(app, 'bundleId', issues); if (app.hostBundleId !== undefined) issues.push({ path: 'app.hostBundleId', message: 'is not allowed' }); }
        if (app.launchTarget === 'expo-go') { required(app, 'hostBundleId', issues); if (app.bundleId !== undefined) issues.push({ path: 'app.bundleId', message: 'is not allowed' }); }
      }
    }
  }
  if (!record(value.simulator)) issues.push({ path: 'simulator', message: 'must be an object' });
  else {
    for (const key of Object.keys(value.simulator)) if (!simulatorKeys.has(key)) issues.push({ path: `simulator.${key}`, message: 'is not allowed' });
    for (const key of simulatorKeys) if (value.simulator[key] !== undefined && !nonempty(value.simulator[key])) issues.push({ path: `simulator.${key}`, message: 'must be a non-empty string' });
    if (!nonempty(value.simulator.udid) && !nonempty(value.simulator.name)) issues.push({ path: 'simulator', message: 'requires udid or name' });
  }
  if (value.redactions !== undefined && (!Array.isArray(value.redactions) || value.redactions.some(item => typeof item !== 'string'))) issues.push({ path: 'redactions', message: 'must be an array of strings' });
  return issues;
}
export function nativeApp(config: LoadedConfig): NativeApp | ReactNativeApp {
  if (config.app.type !== 'native' && config.app.type !== 'react-native') throw new CliError('WORKFLOW_UNSUPPORTED', `${config.app.type} workflow is not implemented yet`);
  return config.app;
}
export async function loadConfig(root = process.cwd()): Promise<LoadedConfig> {
  const file = path.join(root, '.agemu.json');
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new CliError('CONFIG_INVALID', `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const issues = validate(value);
  if (issues.length) throw new CliError('CONFIG_INVALID', 'Invalid .agemu.json', { issues });
  const config = value as DebugConfig;
  const app = { ...config.app };
  if ('project' in app && app.project) app.project = path.resolve(root, app.project);
  if ('workspace' in app && app.workspace) app.workspace = path.resolve(root, app.workspace);
  if ('root' in app && app.root) app.root = path.resolve(root, app.root);
  return { ...config, app, root: path.resolve(root) } as LoadedConfig;
}
