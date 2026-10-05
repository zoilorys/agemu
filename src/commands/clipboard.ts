import { redactValue } from '../artifacts/runs.js';
import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { requireBooted, runSimctl, selectedDevice, simctlFailure, type SimctlDeps } from '../native/simctl-commands.js';
import { runProcess, type ProcessResult } from '../process/run-process.js';

export type ClipboardDependencies = SimctlDeps & { copy?: (udid: string, text: string) => Promise<ProcessResult> };
export type ClipboardAction = 'read' | 'write';

// Keep text out of argv, shell commands and error details.
async function copy(udid: string, text: string): Promise<ProcessResult> {
  try { return await runProcess('xcrun', ['simctl', 'pbcopy', udid], { stdin: text, timeoutMs: 10_000 }); }
  catch (error) {
    // A child can echo input; clipboard errors never attach its captured stdout/stderr as details.
    if (error instanceof CliError && error.code === 'PROCESS_TIMEOUT') {
      throw new CliError('PROCESS_TIMEOUT', 'Simulator clipboard write timed out after 10000ms', { timeoutMs: 10_000 });
    }
    throw error;
  }
}

export async function clipboard(config: LoadedConfig, action: ClipboardAction, options: { text?: string } = {}, dependencies: ClipboardDependencies = {}) {
  if (action !== 'read' && action !== 'write') throw new CliError('COMMAND_INVALID', 'clipboard action must be read or write');
  if (action === 'write' && typeof options.text !== 'string') throw new CliError('COMMAND_INVALID', 'clipboard write requires text');
  const device = await selectedDevice(config, dependencies);
  requireBooted(device, config.redactions ?? []);
  const secrets = config.redactions ?? [];
  if (action === 'read') {
    const result = await runSimctl(['pbpaste', device.udid], secrets, dependencies, { run: { timeoutMs: 10_000 } });
    return { action, udid: device.udid, text: result.stdout };
  }
  let result: ProcessResult;
  try { result = await (dependencies.copy ?? copy)(device.udid, options.text!); }
  catch (error) {
    if (error instanceof CliError) throw new CliError(error.code, redact(error.message, secrets), error.details ? redactValue(error.details, secrets) : undefined);
    throw new CliError('PROCESS_FAILED', redact(error instanceof Error ? error.message : String(error), secrets));
  }
  if (result.exitCode !== 0) throw simctlFailure(['pbcopy', device.udid], result, secrets);
  return { action, udid: device.udid };
}
