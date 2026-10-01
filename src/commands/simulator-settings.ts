import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../core/errors.js';
import type { Device } from '../native/simctl.js';
import { requireBooted, runSimctl, type SimctlDeps } from '../native/simctl-commands.js';

const invalid = (message: string) => new CliError('COMMAND_INVALID', message);

function oneOf(flag: string, input: string | undefined, allowed: readonly string[]): string | undefined {
  if (input !== undefined && !allowed.includes(input)) throw invalid(`--${flag} must be one of: ${allowed.join(', ')}`);
  return input;
}

function integer(flag: string, input: string | undefined, max: number): string | undefined {
  if (input !== undefined && (!/^\d+$/.test(input) || Number(input) > max)) throw invalid(`--${flag} must be an integer from 0 to ${max}`);
  return input === undefined ? undefined : String(Number(input));
}

export const appearances = ['light', 'dark'] as const;
export const contentSizes = [
  'increment', 'decrement', 'extra-small', 'small', 'medium', 'large', 'extra-large', 'extra-extra-large', 'extra-extra-extra-large',
  'accessibility-medium', 'accessibility-large', 'accessibility-extra-large', 'accessibility-extra-extra-large', 'accessibility-extra-extra-extra-large',
] as const;
export const contrastValues = ['enabled', 'disabled'] as const;

export type UiOptions = { appearance?: string; contentSize?: string; increaseContrast?: string };

export async function simulatorUi(device: Device, options: UiOptions, secrets: string[], deps: SimctlDeps = {}) {
  const changes: Array<[string, string | undefined]> = [
    ['appearance', oneOf('appearance', options.appearance, appearances)],
    ['content_size', oneOf('content-size', options.contentSize, contentSizes)],
    ['increase_contrast', oneOf('increase-contrast', options.increaseContrast, contrastValues)],
  ];
  requireBooted(device);
  for (const [option, setting] of changes) {
    if (setting !== undefined) await runSimctl(['ui', device.udid, option, setting], secrets, deps);
  }
  const read = async (option: string) => (await runSimctl(['ui', device.udid, option], secrets, deps)).stdout.trim();
  return {
    udid: device.udid,
    appearance: await read('appearance'),
    contentSize: await read('content_size'),
    increaseContrast: await read('increase_contrast'),
  };
}

const mediaExtensions = ['.jpg', '.jpeg', '.png', '.heic', '.gif', '.mov', '.mp4', '.m4v', '.vcf'];

export async function addMedia(device: Device, files: string[], secrets: string[], deps: SimctlDeps = {}, cwd = process.cwd()) {
  if (files.length === 0) throw invalid('add-media requires at least one --file');
  const resolved = files.map((file) => path.resolve(cwd, file));
  const shown = (file: string) => path.relative(cwd, file) || file;
  const missing: string[] = [];
  const notFiles: string[] = [];
  for (const file of resolved) {
    const info = await stat(file).catch(() => undefined);
    if (!info) missing.push(shown(file));
    else if (!info.isFile()) notFiles.push(shown(file));
  }
  if (missing.length > 0) throw invalid(`File not found: ${missing.join(', ')}`);
  if (notFiles.length > 0) throw invalid(`Not a regular file: ${notFiles.join(', ')}`);
  const unsupported = resolved.filter((file) => !mediaExtensions.includes(path.extname(file).toLowerCase())).map(shown);
  if (unsupported.length > 0) throw invalid(`Unsupported media type (allowed: ${mediaExtensions.join(' ')}): ${unsupported.join(', ')}`);
  requireBooted(device);
  await runSimctl(['addmedia', device.udid, ...resolved], secrets, deps);
  return { udid: device.udid, added: resolved.map(shown) };
}

export type StatusBarOptions = {
  clear?: boolean; preset?: string; time?: string; dataNetwork?: string; wifiMode?: string; wifiBars?: string;
  cellularMode?: string; cellularBars?: string; operatorName?: string; batteryState?: string; batteryLevel?: string;
};
type OverrideKey = Exclude<keyof StatusBarOptions, 'clear' | 'preset'>;

export const dataNetworks = ['hide', 'wifi', '3g', '4g', 'lte', 'lte-a', 'lte+', '5g', '5g+', '5g-uwb', '5g-uc'] as const;
export const wifiModes = ['searching', 'failed', 'active'] as const;
export const cellularModes = ['notSupported', 'searching', 'failed', 'active'] as const;
export const batteryStates = ['charging', 'charged', 'discharging'] as const;

export const cleanPreset: Record<OverrideKey, string> = {
  time: '9:41', dataNetwork: 'wifi', wifiMode: 'active', wifiBars: '3', cellularMode: 'active', cellularBars: '4',
  operatorName: '', batteryState: 'charged', batteryLevel: '100',
};

const overrideOrder: OverrideKey[] = ['time', 'dataNetwork', 'wifiMode', 'wifiBars', 'cellularMode', 'cellularBars', 'operatorName', 'batteryState', 'batteryLevel'];

// `status_bar list` prints "Current Status Bar Overrides:" and a "====" separator before one line per override.
export function parseOverrides(stdout: string): string[] {
  return stdout.split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !/^=+$/.test(line) && !/^Current Status Bar Overrides:?$/i.test(line));
}

function validatedOverrides(options: StatusBarOptions): Partial<Record<OverrideKey, string>> {
  const explicit: Partial<Record<OverrideKey, string>> = {
    time: options.time,
    dataNetwork: oneOf('data-network', options.dataNetwork, dataNetworks),
    wifiMode: oneOf('wifi-mode', options.wifiMode, wifiModes),
    wifiBars: integer('wifi-bars', options.wifiBars, 3),
    cellularMode: oneOf('cellular-mode', options.cellularMode, cellularModes),
    cellularBars: integer('cellular-bars', options.cellularBars, 4),
    operatorName: options.operatorName,
    batteryState: oneOf('battery-state', options.batteryState, batteryStates),
    batteryLevel: integer('battery-level', options.batteryLevel, 100),
  };
  if (explicit.time === '') throw invalid('--time requires a non-empty value');
  const given = Object.fromEntries(Object.entries(explicit).filter(([, setting]) => setting !== undefined));
  return options.preset === undefined ? given : { ...cleanPreset, ...given };
}

export async function statusBar(device: Device, options: StatusBarOptions, secrets: string[], deps: SimctlDeps = {}) {
  if (options.preset !== undefined && options.preset !== 'clean') throw invalid('--preset must be clean');
  const overrides = validatedOverrides(options);
  const hasOverrides = Object.keys(overrides).length > 0;
  if (options.clear && hasOverrides) throw invalid('--clear cannot be combined with --preset or override options');
  if (!options.clear && !hasOverrides) throw invalid('status-bar requires --clear, --preset=clean, or at least one override option');
  requireBooted(device);
  if (options.clear) await runSimctl(['status_bar', device.udid, 'clear'], secrets, deps);
  else {
    const flags = overrideOrder.filter((key) => overrides[key] !== undefined).flatMap((key) => [`--${key}`, overrides[key]!]);
    await runSimctl(['status_bar', device.udid, 'override', ...flags], secrets, deps);
  }
  const listed = await runSimctl(['status_bar', device.udid, 'list'], secrets, deps);
  return { udid: device.udid, overrides: parseOverrides(listed.stdout) };
}
