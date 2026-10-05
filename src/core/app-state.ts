import { readFile } from 'node:fs/promises';
import { CliError } from './errors.js';
import { redact } from './redact.js';

export type AppState = { appPath: string; bundleId: string; executableName: string; udid: string; configuration: string; updatedAt: string };

/** Operational state retains original paths; redact only error/output boundaries. */
export async function readAppState(file: string, secrets: string[] = [], reader?: (file: string) => Promise<AppState>): Promise<AppState> {
  try {
    const value: unknown = reader ? await reader(file) : JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['appPath', 'bundleId', 'executableName', 'udid', 'configuration', 'updatedAt']
        .every(key => typeof (value as Record<string, unknown>)[key] === 'string')) {
      throw new Error('Cached app state is invalid; rebuild the app');
    }
    return value as AppState;
  } catch (error) {
    throw new CliError('APP_NOT_BUILT', redact(`Cannot read app state: ${error instanceof Error ? error.message : String(error)}`, secrets));
  }
}
