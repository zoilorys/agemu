import { CliError } from '../core/errors.js';

import { commandDefinitions } from './registry.js';
import type { CommandSpec, ParsedArgs, FlagSpec } from './types.js';
export type { FlagSpec, CommandSpec, ParsedArgs } from './types.js';
export { value, values } from './options.js';

export const commandSpecs: Record<string, CommandSpec> = {};
for (const definition of commandDefinitions) {
  const [command, subcommand] = definition.key.split(' ');
  if (subcommand) {
    const spec = commandSpecs[command] ??= { subcommands: {} };
    spec.subcommands![subcommand] = definition.flags;
  } else commandSpecs[command] = { flags: definition.flags };
}

const globalNames = ['pretty', 'debug', 'help', 'version'] as const;
type GlobalName = typeof globalNames[number];
const isGlobal = (name: string): name is GlobalName => (globalNames as readonly string[]).includes(name);

const valueFlagsAnywhere = new Set(Object.values(commandSpecs).flatMap((spec) => [
  ...Object.values(spec.subcommands ?? {}), spec.flags ?? {},
]).flatMap((flags) => Object.entries(flags).filter(([, spec]) => spec.kind !== 'boolean').map(([name]) => name)));

const split = (token: string): { name: string; inline?: string } => {
  const equals = token.indexOf('=');
  return equals < 0 ? { name: token.slice(2) } : { name: token.slice(2, equals), inline: token.slice(equals + 1) };
};

const invalid = (message: string) => new CliError('COMMAND_INVALID', message);

export function parseArgs(argv: string[]): ParsedArgs {
  const globals = { pretty: false, debug: false, help: false, version: false };
  const positionals: string[] = [];
  // Pass 1: find positionals and globals without knowing the command.
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const { name, inline } = split(token);
    if (isGlobal(name) && inline === undefined) globals[name] = true;
    else if (inline === undefined && valueFlagsAnywhere.has(name) && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) index += 1;
  }
  const lenient = globals.help || globals.version;
  const [command, second] = positionals;
  const flags = new Map<string, string[]>();
  // A missing command is reported by the caller as "A command is required".
  if (command === undefined) return { flags, globals };
  const spec = commandSpecs[command];
  if (!spec) {
    if (lenient) return { command, flags, globals };
    throw invalid(`Unknown command: ${command}`);
  }
  let subcommand: string | undefined;
  let allowed: Record<string, FlagSpec>;
  let maxPositionals = 1;
  if (spec.subcommands) {
    const names = Object.keys(spec.subcommands);
    if (second === undefined || !names.includes(second)) {
      if (lenient) return { command, flags, globals };
      throw invalid(`${command} requires one of: ${names.join(', ')}`);
    }
    subcommand = second;
    allowed = spec.subcommands[second];
    maxPositionals = 2;
  } else allowed = spec.flags ?? {};
  if (lenient) return { command, subcommand, flags, globals };
  if (positionals.length > maxPositionals) throw invalid(`Unexpected argument: ${positionals[maxPositionals]}`);

  // Pass 2: validate every option against the resolved command.
  const context = subcommand ? `${command} ${subcommand}` : command;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const { name, inline } = split(token);
    if (isGlobal(name)) {
      if (inline !== undefined) throw invalid(`--${name} does not take a value`);
      continue;
    }
    const flag = allowed[name];
    if (!flag) throw invalid(`Unknown option --${name} for ${context}`);
    let value: string;
    if (flag.kind === 'boolean') {
      if (inline !== undefined) throw invalid(`--${name} does not take a value`);
      value = '';
    } else if (inline !== undefined) value = inline;
    else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw invalid(`--${name} requires a value`);
      value = next;
      index += 1;
    }
    const existing = flags.get(name);
    if (existing && flag.kind !== 'repeat') throw invalid(`--${name} may be given once`);
    flags.set(name, [...(existing ?? []), value]);
  }
  return { command, subcommand, flags, globals };
}
