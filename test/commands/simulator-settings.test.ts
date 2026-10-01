import { describe, expect, it } from 'vitest';
import { simulatorUi, statusBar } from '../../src/commands/simulator-settings.js';
import { parseArgs, value } from '../../src/cli/args.js';
import type { Device } from '../../src/native/simctl.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const result = (stdout = '', exitCode = 0): ProcessResult => ({ stdout, stderr: '', exitCode, signal: null, startedAt: '', durationMs: 0 });
const phone = (state = 'Booted') => ({ udid: 'PHONE', name: 'Phone', runtime: 'iOS-18-0', state, isAvailable: true }) as Device;

function fake(respond: (args: string[]) => ProcessResult = () => result()) {
  const calls: string[][] = [];
  return { calls, deps: { runner: async (args: string[]) => { calls.push(args); return respond(args); } } };
}

// Real output probed on the assigned Simulator (task log E003).
const header = 'Current Status Bar Overrides:\n======================================\n';
const cleanList = `${header}Time: 09:41\nDataNetworkType: 11\nWiFi Mode: 3, WiFi Bars: 3\nCell Mode: 3, Cell Bars: 4\nOperator Name: \nBattery State: 2, Battery Level: 100, Not Charging: 0\n`;

describe('simulator ui', () => {
  it('sets only given options, then returns values read back from simctl', async () => {
    const readings: Record<string, string> = { appearance: 'dark\n', content_size: 'large\n', increase_contrast: 'disabled\n' };
    const fixture = fake((args) => result(args.length === 3 ? readings[args[2]] : ''));
    expect(await simulatorUi(phone(), { appearance: 'dark' }, [], fixture.deps)).toEqual({
      udid: 'PHONE', appearance: 'dark', contentSize: 'large', increaseContrast: 'disabled',
    });
    expect(fixture.calls).toEqual([
      ['ui', 'PHONE', 'appearance', 'dark'],
      ['ui', 'PHONE', 'appearance'], ['ui', 'PHONE', 'content_size'], ['ui', 'PHONE', 'increase_contrast'],
    ]);
  });

  it('returns unsupported appearance instead of failing', async () => {
    const fixture = fake((args) => result(args[2] === 'appearance' ? 'unsupported\n' : 'unknown\n'));
    expect(await simulatorUi(phone(), {}, [], fixture.deps)).toMatchObject({ appearance: 'unsupported' });
  });

  it.each([
    [{ appearance: 'Dark' }, 'appearance'], [{ contentSize: 'huge' }, 'content-size'], [{ increaseContrast: 'on' }, 'increase-contrast'],
  ])('rejects %j before simctl', async (options, flag) => {
    const fixture = fake();
    await expect(simulatorUi(phone(), options, [], fixture.deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID', message: expect.stringContaining(`--${flag}`) });
    expect(fixture.calls).toEqual([]);
  });

  it('refuses a Shutdown Simulator without invoking simctl', async () => {
    const fixture = fake();
    await expect(simulatorUi(phone('Shutdown'), {}, [], fixture.deps)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
    expect(fixture.calls).toEqual([]);
  });
});

describe('simulator status-bar', () => {
  it('expands the clean preset into the exact override argv, including an empty operator name', async () => {
    const fixture = fake((args) => result(args[2] === 'list' ? cleanList : ''));
    const output = await statusBar(phone(), { preset: 'clean' }, [], fixture.deps);
    expect(fixture.calls[0]).toEqual(['status_bar', 'PHONE', 'override',
      '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4',
      '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100']);
    expect(fixture.calls[1]).toEqual(['status_bar', 'PHONE', 'list']);
    expect(output).toEqual({ udid: 'PHONE', overrides: [
      'Time: 09:41', 'DataNetworkType: 11', 'WiFi Mode: 3, WiFi Bars: 3', 'Cell Mode: 3, Cell Bars: 4', 'Operator Name:',
      'Battery State: 2, Battery Level: 100, Not Charging: 0',
    ] });
  });

  it('lets explicit options replace preset values', async () => {
    const fixture = fake();
    await statusBar(phone(), { preset: 'clean', batteryLevel: '50', dataNetwork: '5g-uc' }, [], fixture.deps);
    const argv = fixture.calls[0];
    expect(argv[argv.indexOf('--batteryLevel') + 1]).toBe('50');
    expect(argv[argv.indexOf('--dataNetwork') + 1]).toBe('5g-uc');
    expect(argv.filter((arg) => arg === '--batteryLevel')).toHaveLength(1);
  });

  it('passes only the given overrides without a preset', async () => {
    const fixture = fake();
    await statusBar(phone(), { cellularMode: 'notSupported', operatorName: '' }, [], fixture.deps);
    expect(fixture.calls[0]).toEqual(['status_bar', 'PHONE', 'override', '--cellularMode', 'notSupported', '--operatorName', '']);
  });

  it('clears and returns an empty override list from the header-only output', async () => {
    const fixture = fake((args) => result(args[2] === 'list' ? header : ''));
    expect(await statusBar(phone(), { clear: true }, [], fixture.deps)).toEqual({ udid: 'PHONE', overrides: [] });
    expect(fixture.calls).toEqual([['status_bar', 'PHONE', 'clear'], ['status_bar', 'PHONE', 'list']]);
  });

  it.each([
    [{ clear: true, preset: 'clean' }, '--clear'],
    [{ clear: true, time: '9:41' }, '--clear'],
    [{}, 'requires'],
    [{ preset: 'pretty' }, '--preset'],
    [{ dataNetwork: '6g' }, '--data-network'],
    [{ wifiMode: 'on' }, '--wifi-mode'],
    [{ cellularMode: 'notsupported' }, '--cellular-mode'],
    [{ batteryState: 'full' }, '--battery-state'],
    [{ wifiBars: '4' }, '--wifi-bars'],
    [{ cellularBars: '5' }, '--cellular-bars'],
    [{ batteryLevel: '101' }, '--battery-level'],
    [{ batteryLevel: '-1' }, '--battery-level'],
    [{ batteryLevel: '1.5' }, '--battery-level'],
    [{ time: '' }, '--time'],
  ])('rejects %j before simctl', async (options, text) => {
    const fixture = fake();
    await expect(statusBar(phone(), options, [], fixture.deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID', message: expect.stringContaining(text) });
    expect(fixture.calls).toEqual([]);
  });

  it('refuses a Shutdown Simulator without invoking simctl', async () => {
    const fixture = fake();
    await expect(statusBar(phone('Shutdown'), { clear: true }, [], fixture.deps)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
    expect(fixture.calls).toEqual([]);
  });
});

describe('status-bar argument parsing', () => {
  it.each([
    [['simulator', 'status-bar', '--operator-name=']],
    [['simulator', 'status-bar', '--operator-name', '']],
  ])('delivers an empty --operator-name from %j', (argv) => {
    expect(value(parseArgs(argv), 'operator-name')).toBe('');
  });
});
