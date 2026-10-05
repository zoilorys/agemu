#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { errorResult, writeResult, type Result } from '../core/output.js';
import { redact } from '../core/redact.js';
import { redactValue } from '../artifacts/runs.js';
import { CliError } from '../core/errors.js';
import { parseArgs } from './args.js';
import { CommandContext } from './context.js';
import { commandRegistry, executeCommand } from './registry.js';
import { helpFor } from './help.js';
const args = process.argv.slice(2);
const packageVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
let pretty = args.includes('--pretty'), debug = args.includes('--debug');
let context: CommandContext | undefined;
function emit(result: Result<unknown>) {
  const secrets = context?.secrets ?? [];
  if (!secrets.length) return writeResult(result, pretty);
  if (result.ok) return writeResult({ ok: true, data: redactValue(result.data, secrets) }, pretty);
  const { code, message, details, stack } = result.error;
  writeResult({ ok: false, error: { code, message: redact(message, secrets),
    ...(details ? { details: redactValue(details, secrets) } : {}), ...(stack ? { stack: redact(stack, secrets) } : {}) } }, pretty);
}
try {
  const parsed = parseArgs(args);
  ({ pretty, debug } = parsed.globals);
  if (parsed.globals.help) emit({ ok: true, data: { help: helpFor(parsed.command, parsed.subcommand) } });
  else if (parsed.globals.version) emit({ ok: true, data: { version: packageVersion } });
  else {
    if (!parsed.command) throw new CliError('COMMAND_INVALID', 'A command is required');
    const key = parsed.subcommand ? `${parsed.command} ${parsed.subcommand}` : parsed.command;
    const definition = commandRegistry.get(key);
    if (!definition) throw new CliError('COMMAND_INVALID', `Unknown command: ${key}`);
    context = new CommandContext(parsed);
    emit({ ok: true, data: await executeCommand(definition, context, parsed) });
  }
} catch (error) {
  // Early validation still uses configured redactions when the project has a readable config.
  await context?.optionalConfig().catch(() => undefined);
  emit(errorResult(error, debug)); process.exitCode = 1;
}
