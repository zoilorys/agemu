import { CliError } from './errors.js';

export const durationUnits = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type DurationUnit = keyof typeof durationUnits;

/** Reject overflow before a duration reaches a process timer or Date. */
export function parseDuration(value: string | undefined, options: {
  units?: readonly DurationUnit[]; minMs?: number; maxMs?: number; message: string;
}): number {
  const match = value === undefined ? null : /^(\d+)([smhd])$/.exec(value);
  const unit = match?.[2] as DurationUnit | undefined;
  const milliseconds = match && unit ? Number(match[1]) * durationUnits[unit] : NaN;
  if (!unit || !(options.units ?? Object.keys(durationUnits)).includes(unit)
    || !Number.isSafeInteger(milliseconds) || milliseconds < (options.minMs ?? 0)
    || milliseconds > (options.maxMs ?? Number.MAX_SAFE_INTEGER)) {
    throw new CliError('COMMAND_INVALID', options.message);
  }
  return milliseconds;
}

export function parseCaptureDuration(value: string | undefined): number {
  return parseDuration(value, {
    units: ['s', 'm'], minMs: 1_000, maxMs: 600_000,
    message: '--duration is required: a number followed by s or m, from 1s to 10m',
  });
}

export function parseUntil(value: string | undefined): RegExp | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) throw new CliError('COMMAND_INVALID', '--until requires a non-empty regular expression');
  try { return new RegExp(value); }
  catch (error) { throw new CliError('COMMAND_INVALID', `--until is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
}

export function logLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) throw new CliError('COMMAND_INVALID', '--limit must be an integer from 0 to 10000');
  return limit;
}
