import { describe, expect, it } from 'vitest';
import { location } from '../../src/commands/location.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const config: LoadedConfig = {
  version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
  simulator: { udid: 'PHONE' }, redactions: [], root: '/repo',
};
const result = (stdout = '', exitCode = 0): ProcessResult => ({ stdout, stderr: '', exitCode, signal: null, startedAt: '', durationMs: 0 });
const device = (state: string) => async () => [{ udid: 'PHONE', name: 'Phone', runtime: 'iOS-18-0', state, isAvailable: true }];

function fake(responses: ProcessResult[] = [], state = 'Booted') {
  const calls: string[][] = [];
  return { calls, deps: { listDevices: device(state), runner: async (args: string[]) => { calls.push(args); return responses.shift() ?? result(); } } };
}

const row = (name: string) => `${name.padEnd(21)}${name}`;
const realList = [`${'Name'.padEnd(21)}Description`, '='.repeat(56), ...['City Run', 'City Bicycle Ride', 'Freeway Drive', 'Apple'].map(row), ''].join('\n');

describe('location set', () => {
  it.each(['37.3349,-122.0090', '0,0', '-90,180', '90,-180', '-33.8,151'])('passes %s through exactly', async (coordinate) => {
    const fixture = fake();
    await location(config, 'set', { coordinate }, fixture.deps);
    expect(fixture.calls).toEqual([['location', 'PHONE', 'set', coordinate]]);
  });

  it.each(['37.3, -122.0', '37.3', '91,0', '-90.1,0', '0,180.5', '0,-181', 'a,b', '1,2,3', ' 1,2', '+1,2', '.5,1', ''])(
    'rejects %j before any simctl call', async (coordinate) => {
      const fixture = fake();
      await expect(location(config, 'set', { coordinate }, fixture.deps)).rejects.toMatchObject({
        code: 'COMMAND_INVALID', message: expect.stringContaining('LAT,LON'),
      });
      expect(fixture.calls).toEqual([]);
    },
  );

  it('requires --coordinate', async () => {
    const fixture = fake();
    await expect(location(config, 'set', {}, fixture.deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(fixture.calls).toEqual([]);
  });
});

describe('location clear and list', () => {
  it('clear runs simctl location clear', async () => {
    const fixture = fake();
    await location(config, 'clear', {}, fixture.deps);
    expect(fixture.calls).toEqual([['location', 'PHONE', 'clear']]);
  });

  it('list parses the real Name/Description table, skipping header and separator', async () => {
    const fixture = fake([result(realList)]);
    const listed = await location(config, 'list', {}, fixture.deps);
    expect(listed).toMatchObject({ scenarios: ['City Run', 'City Bicycle Ride', 'Freeway Drive', 'Apple'] });
    expect(fixture.calls).toEqual([['location', 'PHONE', 'list']]);
  });

  it('list falls back to one name per line when there is no Description header', async () => {
    const fixture = fake([result('Freeway Drive\n  City Run  \n\n')]);
    expect(await location(config, 'list', {}, fixture.deps)).toMatchObject({ scenarios: ['Freeway Drive', 'City Run'] });
  });
});

describe('location run', () => {
  it('runs a known scenario with spaces as one argument after listing', async () => {
    const fixture = fake([result(realList)]);
    await location(config, 'run', { scenario: 'City Run' }, fixture.deps);
    expect(fixture.calls).toEqual([['location', 'PHONE', 'list'], ['location', 'PHONE', 'run', 'City Run']]);
  });

  it('rejects an unknown scenario listing the available names and never runs it', async () => {
    const fixture = fake([result(realList)]);
    await expect(location(config, 'run', { scenario: 'Nope' }, fixture.deps)).rejects.toMatchObject({
      code: 'COMMAND_INVALID', message: expect.stringContaining('City Run, City Bicycle Ride, Freeway Drive, Apple'),
    });
    expect(fixture.calls).toEqual([['location', 'PHONE', 'list']]);
  });

  it('requires --scenario before any simctl call', async () => {
    const fixture = fake();
    await expect(location(config, 'run', {}, fixture.deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(fixture.calls).toEqual([]);
  });
});

describe('location on a stopped Simulator', () => {
  it.each(['set', 'clear', 'list', 'run'] as const)('%s refuses a Shutdown Simulator without invoking simctl', async (action) => {
    const fixture = fake([], 'Shutdown');
    await expect(location(config, action, { coordinate: '1,2', scenario: 'City Run' }, fixture.deps)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
    expect(fixture.calls).toEqual([]);
  });
});
