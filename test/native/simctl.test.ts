import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bootDevice,
  listDevices,
  parseDevices,
  resolveDevice,
  shutdownDevice,
  type Device,
  type SimctlRunner,
} from '../../src/native/simctl.js';
import type { ProcessResult } from '../../src/process/run-process.js';

let fixture: unknown;

beforeAll(async () => {
  const path = fileURLToPath(new URL('../fixtures/simctl-list.json', import.meta.url));
  fixture = JSON.parse(await readFile(path, 'utf8'));
});

const device: Device = {
  udid: 'PHONE-15-IOS-17',
  name: 'iPhone 15',
  runtime: 'iOS-17-5',
  state: 'Shutdown',
  isAvailable: true,
};

function result(stdout = '', stderr = '', exitCode = 0): ProcessResult {
  return { stdout, stderr, exitCode, signal: null, startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1 };
}

function fakeRunner(responses: ProcessResult[]): { runner: SimctlRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args) => {
      calls.push(args);
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected simctl call: ${args.join(' ')}`);
      return response;
    },
  };
}

describe('simctl devices', () => {
  it('preserves runtime, availability, and state from recorded simctl JSON', () => {
    expect(parseDevices(fixture)).toEqual([
      device,
      { udid: 'UNAVAILABLE', name: 'Unavailable Phone', runtime: 'iOS-17-5', state: 'Shutdown', isAvailable: false },
      { udid: 'PHONE-15-IOS-18', name: 'iPhone 15', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true },
      { udid: 'IPAD-IOS-18', name: 'iPad Pro', runtime: 'iOS-18-0', state: 'Shutdown', isAvailable: true },
      { udid: 'WATCH-11', name: 'Apple Watch', runtime: 'watchOS-11-0', state: 'Shutdown', isAvailable: true },
    ]);
  });

  it('resolves exact UDIDs and name-runtime pairs but rejects ambiguous names', () => {
    const devices = parseDevices(fixture);
    expect(resolveDevice(devices, { udid: 'PHONE-15-IOS-18' }).runtime).toBe('iOS-18-0');
    expect(resolveDevice(devices, { name: 'iPhone 15', runtime: 'iOS-17-5' }).udid).toBe('PHONE-15-IOS-17');
    expect(resolveDevice(devices, { name: 'iPhone 15', runtime: 'iOS 17.5' }).udid).toBe('PHONE-15-IOS-17');
    expect(() => resolveDevice(devices, { name: 'iPhone 15' })).toThrow(expect.objectContaining({
      code: 'SIMULATOR_AMBIGUOUS',
      details: { selector: { name: 'iPhone 15' }, candidates: expect.arrayContaining([
        expect.objectContaining({ udid: 'PHONE-15-IOS-17' }),
        expect.objectContaining({ udid: 'PHONE-15-IOS-18' }),
      ]) },
    }));
    expect(() => resolveDevice(devices, { udid: 'UNAVAILABLE' })).toThrow(expect.objectContaining({
      code: 'SIMULATOR_NOT_FOUND',
    }));
  });

  it('lists only available devices from simctl', async () => {
    const fake = fakeRunner([result(JSON.stringify(fixture))]);
    await expect(listDevices(fake.runner)).resolves.toEqual([
      device,
      { udid: 'PHONE-15-IOS-18', name: 'iPhone 15', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true },
      { udid: 'IPAD-IOS-18', name: 'iPad Pro', runtime: 'iOS-18-0', state: 'Shutdown', isAvailable: true },
    ]);
    expect(fake.calls).toEqual([['list', '--json']]);
  });
});

describe('simctl state transitions', () => {
  it('boots the resolved UDID and waits for boot status', async () => {
    const fake = fakeRunner([result(), result()]);
    await expect(bootDevice(device, fake.runner)).resolves.toMatchObject({ udid: device.udid, state: 'Booted' });
    expect(fake.calls).toEqual([['boot', device.udid], ['bootstatus', device.udid, '-b']]);
  });

  it('accepts a concurrent boot and still waits for readiness', async () => {
    const bootedJson = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [{ ...device, state: 'Booted' }] } });
    const fake = fakeRunner([result('', 'Unable to boot device in current state: Booted', 149), result(bootedJson), result()]);
    await expect(bootDevice(device, fake.runner)).resolves.toMatchObject({ state: 'Booted' });
    expect(fake.calls).toEqual([
      ['boot', device.udid],
      ['list', '--json'],
      ['bootstatus', device.udid, '-b'],
    ]);
  });

  it('does not issue repeated mutations for devices already in the requested state', async () => {
    const booted = { ...device, state: 'Booted' };
    const bootFake = fakeRunner([result()]);
    await bootDevice(booted, bootFake.runner);
    expect(bootFake.calls).toEqual([['bootstatus', device.udid, '-b']]);

    const shutdownFake = fakeRunner([]);
    await shutdownDevice(device, shutdownFake.runner);
    expect(shutdownFake.calls).toEqual([]);
  });

  it('accepts a concurrent shutdown after confirming the exact UDID state', async () => {
    const booted = { ...device, state: 'Booted' };
    const shutdownJson = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [device] } });
    const fake = fakeRunner([result('', 'Unable to shutdown device in current state: Shutdown', 149), result(shutdownJson)]);
    await expect(shutdownDevice(booted, fake.runner)).resolves.toMatchObject({ state: 'Shutdown' });
    expect(fake.calls).toEqual([['shutdown', device.udid], ['list', '--json']]);
  });
});
