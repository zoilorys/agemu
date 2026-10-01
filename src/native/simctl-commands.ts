import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import type { ProcessResult, RunOptions } from '../process/run-process.js';
import { listDevices as defaultListDevices, resolveDevice, simctl, type Device, type SimctlRunner } from './simctl.js';

export type SimctlDeps = { runner?: SimctlRunner; listDevices?: () => Promise<Device[]> };
export type SimctlRunOptions = { allowStopped?: boolean; run?: RunOptions };

const stopped = (value: string) => /not running|no such process|found nothing to terminate/i.test(value);

export async function selectedDevice(config: LoadedConfig, deps: SimctlDeps = {}): Promise<Device> {
  const devices = await (deps.listDevices ?? (() => defaultListDevices(deps.runner ?? simctl)))();
  return resolveDevice(devices, config.simulator);
}

export function requireBooted(device: Device): void {
  if (device.state !== 'Booted') {
    throw new CliError('SIMULATOR_NOT_BOOTED', `Simulator ${device.name} (${device.udid}) is not booted; run agemu simulator boot`, {
      udid: device.udid, state: device.state,
    });
  }
}

export async function runSimctl(args: string[], secrets: string[], deps: SimctlDeps = {}, options: SimctlRunOptions = {}): Promise<ProcessResult> {
  const result = await (deps.runner ?? simctl)(args, options.run);
  if (result.exitCode !== 0 && !(options.allowStopped && stopped(result.stderr))) throw simctlFailure(args, result, secrets);
  return result;
}

export function simctlFailure(args: string[], result: ProcessResult, secrets: string[]): CliError {
  return new CliError('PROCESS_FAILED', redact(result.stderr.trim() || `simctl ${args[0]} failed`, secrets), {
    command: ['xcrun', 'simctl', ...args].map((value) => redact(value, secrets)), exitCode: result.exitCode, signal: result.signal,
  });
}

export function requireYes(confirmed: boolean, description: string): void {
  if (!confirmed) throw new CliError('COMMAND_INVALID', `${description}. Re-run with --yes to confirm.`);
}
