import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLaunchMarker, writeLaunchMarker } from '../../src/artifacts/launch-marker.js';
import { localTimestamp, loggedBefore, resolveSince } from '../../src/commands/since.js';

const now = new Date('2026-09-30T12:00:00.000Z');
const expected = { bundleId: 'com.example.app', udid: 'PHONE' };
let root: string;

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'agemu-since-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('resolveSince', () => {
  it('falls back to the default window without a value', async () => {
    expect(await resolveSince(undefined, root, now, 3_600_000, expected)).toEqual({ start: new Date('2026-09-30T11:00:00.000Z'), source: 'default' });
  });

  it('counts a duration back from now', async () => {
    expect(await resolveSince('90s', root, now, 0)).toEqual({ start: new Date('2026-09-30T11:58:30.000Z'), source: 'duration' });
    expect(await resolveSince('2d', root, now, 0)).toEqual({ start: new Date('2026-09-28T12:00:00.000Z'), source: 'duration' });
    await expect(resolveSince('yesterday', root, now, 0)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
  });

  it('rejects durations that overflow or resolve outside the Date range', async () => {
    await expect(resolveSince('999999999999999999999d', root, now, 0)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    await expect(resolveSince('9000000000000s', root, now, 0)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    await expect(resolveSince(undefined, root, now, Infinity)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
  });

  it('starts at the latest recorded launch of the expected app and Simulator', async () => {
    await writeLaunchMarker(root, { at: new Date('2026-09-30T11:40:00.000Z'), udid: 'PHONE', bundleId: 'com.example.app', source: 'app launch' });
    await writeLaunchMarker(root, { at: new Date('2026-09-30T11:55:00.000Z'), udid: 'PHONE', bundleId: 'com.example.app', source: 'app restart' });
    expect(await resolveSince('launch', root, now, 0, expected)).toEqual({ start: new Date('2026-09-30T11:55:00.000Z'), source: 'launch' });
  });

  it('fails clearly without a recorded launch', async () => {
    await expect(resolveSince('launch', root, now, 0, expected)).rejects.toMatchObject({
      code: 'COMMAND_INVALID', message: 'No agemu launch recorded; launch the app with agemu first',
    });
    await mkdir(path.join(root, '.agemu'), { recursive: true });
    await writeFile(path.join(root, '.agemu', 'launch.json'), '{"at":"not a date","udid":"PHONE","bundleId":"com.example.app","source":"app launch"}');
    expect(await readLaunchMarker(root)).toBeUndefined();
    await expect(resolveSince('launch', root, now, 0, expected)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
  });

  it.each([
    ['another app', { udid: 'PHONE', bundleId: 'com.example.other' }],
    ['another Simulator', { udid: 'TABLET', bundleId: 'com.example.app' }],
  ])('rejects a launch of %s', async (_, launched) => {
    await writeLaunchMarker(root, { at: now, source: 'app launch', ...launched });
    await expect(resolveSince('launch', root, now, 0, expected)).rejects.toMatchObject({
      code: 'COMMAND_INVALID', message: 'No agemu launch recorded; launch the app with agemu first',
      details: { recorded: launched, expected },
    });
  });
});

describe('localTimestamp', () => {
  it.each([new Date(2026, 0, 2, 3, 4, 5, 678), new Date(2026, 6, 2, 3, 4, 5, 678)])('formats local wall-clock time with an offset that names the same instant (%s)', (date) => {
    const formatted = localTimestamp(date);
    const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)$/.exec(formatted);
    expect(match).not.toBeNull();
    expect(`${match![1]} ${match![2]}`).toBe(`2026-0${date.getMonth() + 1}-02 03:04:05`);
    expect(Date.parse(`${match![1]}T${match![2]}${match![3]}:${match![4]}`)).toBe(date.getTime() - 678);
  });
});

describe('loggedBefore', () => {
  const start = new Date(2026, 8, 30, 7, 5, 9, 500);
  it.each([
    ['2026-09-30 07:05:09.499 Df NativeFixture[12:34] earlier', true],
    ['2026-09-30 07:05:08.900 Df NativeFixture[12:34] earlier', true],
    ['2026-09-30 07:05:09.500 Df NativeFixture[12:34] at start', false],
    ['2026-09-30 07:05:10.000 Df NativeFixture[12:34] later', false],
    ['Timestamp               Ty Process[PID:TID]', false],
    ['  continuation line', false],
  ])('%s → %s', (line, expected) => {
    expect(loggedBefore(line, start)).toBe(expected);
  });
});
