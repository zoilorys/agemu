import { spawn } from 'node:child_process';
import { CliError } from '../core/errors.js';

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  durationMs: number;
};

export type RunOptions = { timeoutMs?: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv };

export function runProcess(executable: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let termination: CliError | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      fn();
    };
    const result = (exitCode: number | null, signal: NodeJS.Signals | null): ProcessResult => ({
      stdout,
      stderr,
      exitCode,
      signal,
      startedAt,
      durationMs: Date.now() - started,
    });
    const terminate = (error: CliError) => {
      if (termination || settled) return;
      termination = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    const abort = () => terminate(new CliError('PROCESS_TIMEOUT', 'Process cancelled'));
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error: NodeJS.ErrnoException) => finish(() => reject(new CliError(error.code === 'ENOENT' ? 'TOOL_NOT_FOUND' : 'PROCESS_FAILED', error.message))));
    child.once('close', (exitCode, signal) => finish(() => {
      if (termination) {
        reject(new CliError(termination.code, termination.message, { ...termination.details, result: result(exitCode, signal) }));
      } else {
        resolve(result(exitCode, signal));
      }
    }));
    if (options.signal) {
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => terminate(new CliError('PROCESS_TIMEOUT', `Process timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    }
  });
}
