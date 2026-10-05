import { CliError } from '../core/errors.js';
import { parseDuration } from '../core/log-options.js';
import type { FlagSpec, ParsedArgs } from './types.js';
export const value = (parsed: ParsedArgs, name: string): string | undefined => parsed.flags.get(name)?.[0];
export const values = (parsed: ParsedArgs, name: string): string[] => parsed.flags.get(name) ?? [];
export const numberOption = (parsed: ParsedArgs, name: string): number | undefined => value(parsed, name) === undefined ? undefined : Number(value(parsed, name));
export const timeoutOption = (parsed: ParsedArgs): number | undefined => numberOption(parsed, 'timeout') === undefined ? undefined : numberOption(parsed, 'timeout')! * 1000;
export function validateFlags(parsed: ParsedArgs, flags: Record<string, FlagSpec>): void {
  for (const [name, spec] of Object.entries(flags)) {
    const given = value(parsed, name);
    const fail = (message: string): never => { throw new CliError(spec.errorCode ?? 'COMMAND_INVALID', spec.message ?? message); };
    if (given === undefined) { if (spec.required) fail(`--${name} is required`); continue; }
    if (spec.nonEmpty && !given.length) fail(`--${name} requires a non-empty value`);
    if (spec.integer && (!/^\d+$/.test(given) || !Number.isSafeInteger(Number(given)) || Number(given) < spec.integer.min || Number(given) > spec.integer.max)) {
      fail(`--${name} must be an integer from ${spec.integer.min} to ${spec.integer.max}`);
    }
    if (spec.choices && !spec.choices.includes(given)) fail(`--${name} must be one of ${spec.choices.join(', ')}`);
  }
}
export function cleanOptions(parsed: ParsedArgs) {
  const runs = parsed.flags.has('runs');
  const derivedData = parsed.flags.has('derived-data');
  if (!runs && !derivedData) throw new CliError('COMMAND_INVALID', 'clean requires --runs, --derived-data, or both');
  const olderThan = value(parsed, 'older-than');
  if (olderThan !== undefined && !runs) throw new CliError('COMMAND_INVALID', '--older-than requires --runs');
  const olderThanMs = olderThan === undefined ? undefined : parseDuration(olderThan, {
    message: '--older-than must be a number followed by s, m, h, or d (for example, 7d)',
  });
  return { runs, derivedData, olderThanMs, dryRun: parsed.flags.has('dry-run') };
}
export function launchEnvironment(parsed: ParsedArgs): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const input of values(parsed, 'env')) {
    const separator = input.indexOf('=');
    const name = input.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CliError('COMMAND_INVALID', '--env must use KEY=VALUE with a valid environment variable name');
    environment[name] = input.slice(separator + 1);
  }
  return environment;
}
