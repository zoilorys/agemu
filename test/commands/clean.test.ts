import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clean } from '../../src/commands/clean.js';

const day = 86_400_000;
const now = new Date('2026-09-29T12:00:00Z');
const temporary: string[] = [];
const exists = (target: string) => access(target).then(() => true, () => false);

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'agemu-clean-'));
  temporary.push(directory);
  return directory;
}

async function runsFixture() {
  const root = await tempDir();
  const oldRun = path.join(root, '.agemu', 'runs', 'old');
  const newRun = path.join(root, '.agemu', 'runs', 'new');
  await mkdir(path.join(oldRun, 'nested'), { recursive: true });
  await mkdir(newRun, { recursive: true });
  await writeFile(path.join(oldRun, 'a.txt'), 'x'.repeat(10));
  await writeFile(path.join(oldRun, 'nested', 'b.txt'), 'y'.repeat(25));
  await writeFile(path.join(newRun, 'c.txt'), 'z'.repeat(7));
  const twoDaysAgo = new Date(now.getTime() - 2 * day);
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  await utimes(oldRun, twoDaysAgo, twoDaysAgo);
  await utimes(newRun, oneHourAgo, oneHourAgo);
  return { root, oldRun, newRun };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('clean', () => {
  it('removes only runs older than the age filter and reports their file bytes', async () => {
    const { root, oldRun, newRun } = await runsFixture();
    const result = await clean({ root }, { runs: true, derivedData: false, olderThanMs: day, dryRun: false }, { now: () => now });
    expect(result).toEqual({ dryRun: false, removed: [path.join('.agemu', 'runs', 'old')], freedBytes: 35 });
    expect(await exists(oldRun)).toBe(false);
    expect(await exists(newRun)).toBe(true);
  });

  it('lists the same runs in a dry run without deleting anything', async () => {
    const { root, oldRun, newRun } = await runsFixture();
    const result = await clean({ root }, { runs: true, derivedData: false, olderThanMs: day, dryRun: true }, { now: () => now });
    expect(result).toEqual({ dryRun: true, removed: [path.join('.agemu', 'runs', 'old')], freedBytes: 35 });
    expect(await exists(oldRun)).toBe(true);
    expect(await exists(newRun)).toBe(true);
  });

  it('returns nothing when .agemu is missing', async () => {
    const root = await tempDir();
    expect(await clean({ root }, { runs: true, derivedData: true, dryRun: false })).toEqual({ dryRun: false, removed: [], freedBytes: 0 });
  });

  it('removes derived data and a state.json pointing into DerivedData, keeping events and server state', async () => {
    const root = await tempDir();
    const base = path.join(root, '.agemu');
    await mkdir(path.join(base, 'DerivedData', 'Build', 'App.app'), { recursive: true });
    await mkdir(path.join(base, 'RunnerDerivedData'), { recursive: true });
    await writeFile(path.join(base, 'RunnerDerivedData', 'r.bin'), 'r');
    await writeFile(path.join(base, 'state.json'), JSON.stringify({ appPath: path.join(base, 'DerivedData', 'Build', 'App.app') }));
    await writeFile(path.join(base, 'events.jsonl'), '{}\n');
    await writeFile(path.join(base, 'server.json'), '{}');
    const result = await clean({ root }, { runs: false, derivedData: true, dryRun: false });
    expect(result.removed).toEqual([
      path.join('.agemu', 'DerivedData'), path.join('.agemu', 'RunnerDerivedData'), path.join('.agemu', 'state.json'),
    ]);
    expect(await exists(path.join(base, 'DerivedData'))).toBe(false);
    expect(await exists(path.join(base, 'RunnerDerivedData'))).toBe(false);
    expect(await exists(path.join(base, 'state.json'))).toBe(false);
    expect(await readFile(path.join(base, 'events.jsonl'), 'utf8')).toBe('{}\n');
    expect(await exists(path.join(base, 'server.json'))).toBe(true);
  });

  it('keeps a state.json whose appPath is outside DerivedData (Expo)', async () => {
    const root = await tempDir();
    const base = path.join(root, '.agemu');
    await mkdir(path.join(base, 'DerivedData'), { recursive: true });
    await writeFile(path.join(base, 'state.json'), JSON.stringify({ appPath: path.join(root, 'ios', 'build', 'App.app') }));
    const result = await clean({ root }, { runs: false, derivedData: true, dryRun: false });
    expect(result.removed).toEqual([path.join('.agemu', 'DerivedData')]);
    expect(await exists(path.join(base, 'state.json'))).toBe(true);
  });

  it('never follows or removes a symlinked run', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, 'sentinel'), 'keep');
    await mkdir(path.join(root, '.agemu', 'runs'), { recursive: true });
    await symlink(outside, path.join(root, '.agemu', 'runs', 'link'));
    const result = await clean({ root }, { runs: true, derivedData: false, dryRun: false });
    expect(result.removed).toEqual([]);
    expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
    expect(await exists(path.join(root, '.agemu', 'runs', 'link'))).toBe(true);
  });
});
