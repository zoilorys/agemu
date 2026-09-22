import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../core/errors.js';

export type SimulatorSelector = { udid?: string; name?: string; runtime?: string };
export type DebugConfig = {
  version: 1;
  project?: string;
  workspace?: string;
  scheme: string;
  configuration: string;
  bundleId: string;
  simulator: SimulatorSelector;
  redactions?: string[];
};
export type LoadedConfig = DebugConfig & { root: string };
type Issue = { path: string; message: string };

const configKeys = new Set(['version', 'project', 'workspace', 'scheme', 'configuration', 'bundleId', 'simulator', 'redactions']);
const simulatorKeys = new Set(['udid', 'name', 'runtime']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validate(value: unknown): Issue[] {
  if (!isRecord(value)) return [{ path: '$', message: 'must be an object' }];
  const issues: Issue[] = [];
  for (const key of Object.keys(value)) if (!configKeys.has(key)) issues.push({ path: key, message: 'is not allowed' });
  if (value.version !== 1) issues.push({ path: 'version', message: 'must be 1' });
  const project = value.project;
  const workspace = value.workspace;
  if (project !== undefined && (typeof project !== 'string' || !project)) issues.push({ path: 'project', message: 'must be a non-empty string' });
  if (workspace !== undefined && (typeof workspace !== 'string' || !workspace)) issues.push({ path: 'workspace', message: 'must be a non-empty string' });
  if (Number(typeof project === 'string' && project.length > 0) + Number(typeof workspace === 'string' && workspace.length > 0) !== 1) {
    issues.push({ path: 'project', message: 'exactly one of project or workspace is required' });
    issues.push({ path: 'workspace', message: 'exactly one of project or workspace is required' });
  }
  for (const key of ['scheme', 'configuration', 'bundleId'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) issues.push({ path: key, message: 'must be a non-empty string' });
  }
  if (!isRecord(value.simulator)) {
    issues.push({ path: 'simulator', message: 'must be an object' });
  } else {
    for (const key of Object.keys(value.simulator)) if (!simulatorKeys.has(key)) issues.push({ path: `simulator.${key}`, message: 'is not allowed' });
    for (const key of ['udid', 'name', 'runtime'] as const) {
      if (value.simulator[key] !== undefined && (typeof value.simulator[key] !== 'string' || !value.simulator[key])) {
        issues.push({ path: `simulator.${key}`, message: 'must be a non-empty string' });
      }
    }
    if (typeof value.simulator.udid !== 'string' && typeof value.simulator.name !== 'string') {
      issues.push({ path: 'simulator', message: 'requires udid or name' });
    }
  }
  if (value.redactions !== undefined && (!Array.isArray(value.redactions) || value.redactions.some((item) => typeof item !== 'string'))) {
    issues.push({ path: 'redactions', message: 'must be an array of strings' });
  }
  return issues;
}

export async function loadConfig(root = process.cwd()): Promise<LoadedConfig> {
  const file = path.join(root, '.agemu.json');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new CliError('CONFIG_INVALID', `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const issues = validate(value);
  if (issues.length > 0) throw new CliError('CONFIG_INVALID', 'Invalid .agemu.json', { issues });
  const config = value as DebugConfig;
  return {
    ...config,
    ...(config.project ? { project: path.resolve(root, config.project) } : { workspace: path.resolve(root, config.workspace!) }),
    root: path.resolve(root),
  };
}
