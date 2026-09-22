import { CliError } from '../core/errors.js';
import { runProcess, type ProcessResult, type RunOptions } from '../process/run-process.js';

export type Device = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
};

export type SimulatorSelector = { udid?: string; name?: string; runtime?: string };
export type SimctlRunner = (args: string[], options?: RunOptions) => Promise<ProcessResult>;

type SimctlDevice = {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
  availability?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimeName(identifier: string): string {
  return identifier.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
}

function isAvailable(device: SimctlDevice): boolean {
  return device.isAvailable !== false && !String(device.availability ?? '').toLowerCase().includes('unavailable');
}

function normalizedRuntime(value: string): string {
  return runtimeName(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function parseDevices(json: unknown): Device[] {
  if (!isRecord(json) || !isRecord(json.devices)) {
    throw new CliError('PROCESS_FAILED', 'simctl returned invalid device JSON');
  }

  const devices: Device[] = [];
  for (const [runtime, entries] of Object.entries(json.devices)) {
    if (!Array.isArray(entries)) continue;
    for (const value of entries) {
      if (!isRecord(value)) continue;
      const device = value as SimctlDevice;
      if (typeof device.udid !== 'string' || typeof device.name !== 'string' || typeof device.state !== 'string') continue;
      devices.push({
        udid: device.udid,
        name: device.name,
        runtime: runtimeName(runtime),
        state: device.state,
        isAvailable: isAvailable(device),
      });
    }
  }
  return devices;
}

export async function simctl(args: string[], options?: RunOptions): Promise<ProcessResult> {
  return runProcess('xcrun', ['simctl', ...args], options);
}

function processFailure(args: string[], result: ProcessResult): CliError {
  return new CliError('PROCESS_FAILED', result.stderr.trim() || `simctl ${args[0] ?? 'command'} failed`, {
    command: ['xcrun', 'simctl', ...args],
    exitCode: result.exitCode,
    signal: result.signal,
  });
}

async function runChecked(runner: SimctlRunner, args: string[], options?: RunOptions): Promise<ProcessResult> {
  const result = await runner(args, options);
  if (result.exitCode !== 0) throw processFailure(args, result);
  return result;
}

export async function listDevices(runner: SimctlRunner = simctl): Promise<Device[]> {
  const result = await runChecked(runner, ['list', '--json']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CliError('PROCESS_FAILED', 'simctl returned invalid JSON');
  }
  return parseDevices(parsed).filter((device) => device.isAvailable && device.runtime.startsWith('iOS-'));
}

export function resolveDevice(devices: Device[], selector: SimulatorSelector): Device {
  const available = devices.filter((device) => device.isAvailable);
  const matches = selector.udid
    ? available.filter((device) => device.udid === selector.udid)
    : available.filter((device) =>
      device.name === selector.name && (!selector.runtime || normalizedRuntime(device.runtime) === normalizedRuntime(selector.runtime)));

  if (matches.length === 0) {
    throw new CliError('SIMULATOR_NOT_FOUND', 'Simulator selector matched no available device', { selector });
  }
  if (matches.length > 1) {
    throw new CliError('SIMULATOR_AMBIGUOUS', 'Simulator selector matched multiple devices', {
      selector,
      candidates: matches,
    });
  }
  return matches[0];
}

async function currentDevice(udid: string, runner: SimctlRunner): Promise<Device | undefined> {
  return (await listDevices(runner)).find((device) => device.udid === udid);
}

export async function bootDevice(device: Device, runner: SimctlRunner = simctl): Promise<Device> {
  if (device.state !== 'Booted') {
    const result = await runner(['boot', device.udid]);
    if (result.exitCode !== 0 && (await currentDevice(device.udid, runner))?.state !== 'Booted') {
      throw processFailure(['boot', device.udid], result);
    }
  }
  await runChecked(runner, ['bootstatus', device.udid, '-b'], { timeoutMs: 120_000 });
  return { ...device, state: 'Booted' };
}

export async function shutdownDevice(device: Device, runner: SimctlRunner = simctl): Promise<Device> {
  if (device.state === 'Shutdown') return device;
  const result = await runner(['shutdown', device.udid]);
  if (result.exitCode !== 0 && (await currentDevice(device.udid, runner))?.state !== 'Shutdown') {
    throw processFailure(['shutdown', device.udid], result);
  }
  return { ...device, state: 'Shutdown' };
}
