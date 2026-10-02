import { readLaunchMarker } from '../artifacts/launch-marker.js';
import { CliError } from '../core/errors.js';

export type SinceWindow = { start: Date; source: 'launch' | 'duration' | 'default' };

const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Resolves `--since`: `launch` is the latest agemu launch of the expected app (and Simulator, when known);
 * a duration counts back from `now`; no value falls back to `fallbackMs`.
 */
export async function resolveSince(value: string | undefined, root: string, now: Date, fallbackMs: number,
  expected?: { bundleId: string; udid?: string }): Promise<SinceWindow> {
  if (value === undefined) return { start: new Date(now.getTime() - fallbackMs), source: 'default' };
  if (value === 'launch') {
    const message = 'No agemu launch recorded; launch the app with agemu first';
    const marker = await readLaunchMarker(root);
    if (!marker) throw new CliError('COMMAND_INVALID', message);
    if (expected && (marker.bundleId !== expected.bundleId || (expected.udid !== undefined && marker.udid !== expected.udid))) {
      throw new CliError('COMMAND_INVALID', message, {
        recorded: { bundleId: marker.bundleId, udid: marker.udid, at: marker.at },
        expected: { bundleId: expected.bundleId, ...(expected.udid === undefined ? {} : { udid: expected.udid }) },
      });
    }
    return { start: new Date(marker.at), source: 'launch' };
  }
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new CliError('COMMAND_INVALID', '--since must be launch or a number followed by s, m, h, or d (for example, 24h)');
  return { start: new Date(now.getTime() - Number(match[1]) * units[match[2]]), source: 'duration' };
}

/** Local wall-clock time with its UTC offset for `log show --start`, built from local `Date` getters. */
export function localTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
}

/**
 * Whether a compact `log show` line is timestamped before `start`. The line's local time is compared with
 * millisecond precision; lines without a leading timestamp (headers, continuations) are never earlier.
 */
export function loggedBefore(line: string, start: Date): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?/.exec(line);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const milliseconds = match[7] ? Number(match[7].padEnd(3, '0').slice(0, 3)) : 0;
  return new Date(year, month - 1, day, hour, minute, second, milliseconds).getTime() < start.getTime();
}
