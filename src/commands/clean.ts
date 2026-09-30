import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';

export type CleanOptions = { runs: boolean; derivedData: boolean; olderThanMs?: number; dryRun: boolean };
export type CleanResult = { dryRun: boolean; removed: string[]; freedBytes: number };
type Dependencies = { now?: () => Date };

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function lstatOrUndefined(target: string) {
  try { return await lstat(target); } catch (error) { if (missing(error)) return undefined; throw error; }
}

/** Sums non-directory sizes with lstat; symlinks count as the link itself and are never followed. */
async function sizeOf(target: string): Promise<number> {
  const stats = await lstat(target);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of await readdir(target)) total += await sizeOf(path.join(target, entry));
  return total;
}

export async function clean(config: Pick<LoadedConfig, 'root'>, options: CleanOptions, dependencies: Dependencies = {}): Promise<CleanResult> {
  const base = path.resolve(config.root, '.agemu');
  const result: CleanResult = { dryRun: options.dryRun, removed: [], freedBytes: 0 };
  const baseStats = await lstatOrUndefined(base);
  if (!baseStats) return result;
  if (!baseStats.isDirectory()) throw new CliError('CONFIG_INVALID', '.agemu must be a directory, not a symlink or file');

  const contained = (target: string) => {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(base + path.sep)) throw new CliError('CONFIG_INVALID', `Refusing to clean outside .agemu: ${resolved}`);
    return resolved;
  };
  const remove = async (target: string) => {
    const resolved = contained(target);
    result.freedBytes += await sizeOf(resolved);
    result.removed.push(path.relative(config.root, resolved));
    if (!options.dryRun) await rm(resolved, { recursive: true, force: true });
  };

  if (options.runs) {
    const runs = path.join(base, 'runs');
    const runsStats = await lstatOrUndefined(runs);
    if (runsStats?.isDirectory()) {
      const now = (dependencies.now?.() ?? new Date()).getTime();
      const entries = (await readdir(runs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const target = path.join(runs, entry.name);
        const stats = await lstatOrUndefined(target);
        if (!stats?.isDirectory()) continue; // Symlinks and files are never followed or removed.
        if (options.olderThanMs === undefined || now - stats.mtimeMs >= options.olderThanMs) await remove(target);
      }
    }
  }

  if (options.derivedData) {
    const derivedData = path.join(base, 'DerivedData');
    let derivedDataRemoved = false;
    for (const name of ['DerivedData', 'RunnerDerivedData']) {
      const target = path.join(base, name);
      if (!(await lstatOrUndefined(target))?.isDirectory()) continue;
      await remove(target);
      if (name === 'DerivedData') derivedDataRemoved = true;
    }
    const state = path.join(base, 'state.json');
    const stateStats = await lstatOrUndefined(state);
    if (derivedDataRemoved && stateStats?.isFile()) {
      let appPath: unknown;
      try { appPath = (JSON.parse(await readFile(state, 'utf8')) as { appPath?: unknown }).appPath; } catch { appPath = undefined; }
      if (typeof appPath === 'string') {
        const relative = path.relative(derivedData, path.resolve(config.root, appPath));
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) await remove(state);
      }
    }
  }
  return result;
}
