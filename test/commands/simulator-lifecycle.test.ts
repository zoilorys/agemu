import { describe, expect, test } from 'vitest';
import { createSimulator, deleteSimulator, eraseSimulator } from '../../src/commands/simulator-lifecycle.js';
import type { Device } from '../../src/native/simctl.js';

const result = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode, signal: null, startedAt: '', durationMs: 0 });
const deviceTypes = JSON.stringify({ devicetypes: [
  { name: 'iPhone 16', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
  { name: 'iPhone 16 Pro', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro' },
  { name: 'iPhone SE (3rd generation)', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation' },
  { name: 'iPad Air', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air' },
] });
const runtimes = JSON.stringify({ runtimes: [
  { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', name: 'iOS 18.2', version: '18.2', isAvailable: true },
  { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0', name: 'iOS 17.0', version: '17.0', isAvailable: false },
  { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-2', name: 'watchOS 11.2', version: '11.2', isAvailable: true },
] });
const created: Device = { udid: 'NEW-UDID', name: 'tmp', runtime: 'iOS-18-2', state: 'Shutdown', isAvailable: true };

function fake(devices: Device[] = [created]) {
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'devicetypes') return result(deviceTypes);
    if (args[1] === 'runtimes') return result(runtimes);
    if (args[0] === 'create') return result('NEW-UDID\n');
    return result();
  };
  return { calls, deps: { runner, listDevices: async () => devices } };
}

describe('createSimulator', () => {
  test('friendly type name and runtime version become identifiers in create args', async () => {
    const { calls, deps } = fake();
    expect(await createSimulator({ name: 'tmp', deviceType: 'iPhone SE (3rd generation)', runtime: '18.2' }, [], deps)).toEqual({ created });
    expect(calls.at(-1)).toEqual(['create', 'tmp', 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation', 'com.apple.CoreSimulator.SimRuntime.iOS-18-2']);
  });

  test('without --runtime create omits it and does not list runtimes', async () => {
    const { calls, deps } = fake();
    await createSimulator({ name: 'tmp', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' }, [], deps);
    expect(calls).toEqual([['list', 'devicetypes', '--json'], ['create', 'tmp', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16']]);
  });

  test('unknown device type lists case-insensitive close matches and never creates', async () => {
    const { calls, deps } = fake();
    const error = await createSimulator({ name: 'tmp', deviceType: 'iphone 16 max' }, [], deps).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'COMMAND_INVALID', details: { closeMatches: [] } });
    const partial = await createSimulator({ name: 'tmp', deviceType: 'iphone 16' }, [], deps).catch((caught) => caught);
    expect(partial).toMatchObject({ code: 'COMMAND_INVALID', details: { closeMatches: ['iPhone 16', 'iPhone 16 Pro'] } });
    expect(calls.some((args) => args[0] === 'create')).toBe(false);
  });

  test('close matches are capped at 10', async () => {
    const many = JSON.stringify({ devicetypes: Array.from({ length: 12 }, (_, index) => ({ name: `iPhone Model ${index}`, identifier: `id.${index}` })) });
    const runner = async () => result(many);
    const error = await createSimulator({ name: 'tmp', deviceType: 'iphone model' }, [], { runner, listDevices: async () => [] }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'COMMAND_INVALID' });
    expect(error.details.closeMatches).toEqual(Array.from({ length: 10 }, (_, index) => `iPhone Model ${index}`));
  });

  test.each(['17.0', 'watchOS 11.2', 'iOS 99'])('unavailable or non-iOS runtime %s is rejected before create', async (runtime) => {
    const { calls, deps } = fake();
    await expect(createSimulator({ name: 'tmp', deviceType: 'iPhone 16', runtime }, [], deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(calls.some((args) => args[0] === 'create')).toBe(false);
  });

  test('simctl create failure surfaces as PROCESS_FAILED with its message', async () => {
    const { deps } = fake();
    const runner = async (args: string[]) => args[0] === 'create' ? result('', 1, 'Incompatible device') : deps.runner(args);
    await expect(createSimulator({ name: 'tmp', deviceType: 'iPad Air', runtime: '18.2' }, [], { ...deps, runner }))
      .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'Incompatible device' });
  });
});

describe('deleteSimulator', () => {
  test('requires an explicit udid', async () => {
    const { calls, deps } = fake();
    await expect(deleteSimulator(undefined, true, [], deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(calls).toEqual([]);
  });

  test('without --yes the runner is never called', async () => {
    const { calls, deps } = fake([{ ...created, state: 'Booted' }]);
    await expect(deleteSimulator('NEW-UDID', false, [], deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(calls).toEqual([]);
  });

  test('unknown udid is SIMULATOR_NOT_FOUND', async () => {
    const { deps } = fake();
    await expect(deleteSimulator('OTHER', true, [], deps)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_FOUND' });
  });

  test('booted device is shut down before delete; configured device carries a warning', async () => {
    const { calls, deps } = fake([{ ...created, state: 'Booted' }]);
    expect(await deleteSimulator('NEW-UDID', true, [], deps, 'NEW-UDID')).toEqual({ deleted: 'NEW-UDID', warning: 'This was the configured Simulator' });
    expect(calls).toEqual([['shutdown', 'NEW-UDID'], ['delete', 'NEW-UDID']]);
  });

  test('other device has no warning', async () => {
    const { deps } = fake();
    expect(await deleteSimulator('NEW-UDID', true, [], deps, 'CONFIGURED')).toEqual({ deleted: 'NEW-UDID' });
  });
});

describe('eraseSimulator', () => {
  test('without --yes the runner is never called', async () => {
    const { calls, deps } = fake();
    await expect(eraseSimulator({ ...created, state: 'Booted' }, false, [], deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(calls).toEqual([]);
  });

  test('booted device is shut down before erase', async () => {
    const { calls, deps } = fake();
    expect(await eraseSimulator({ ...created, state: 'Booted' }, true, [], deps)).toEqual({ erased: 'NEW-UDID', udid: 'NEW-UDID', shutDown: true });
    expect(calls).toEqual([['shutdown', 'NEW-UDID'], ['erase', 'NEW-UDID']]);
  });

  test('shut-down device is erased directly', async () => {
    const { calls, deps } = fake();
    expect(await eraseSimulator(created, true, [], deps)).toMatchObject({ shutDown: false });
    expect(calls).toEqual([['erase', 'NEW-UDID']]);
  });
});
