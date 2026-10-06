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

export type RunOptions = { timeoutMs?: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string | Uint8Array };

export type Deadline = { ms: number; remaining: () => number; expired: () => boolean };

/** A fixed end time shared by every step of one command; `remaining` never drops below 1 ms so it is a valid timeout. */
export function deadline(ms: number): Deadline {
  const end = Date.now() + ms;
  return { ms, remaining: () => Math.max(1, end - Date.now()), expired: () => Date.now() >= end };
}

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
    let inputError: Error | undefined;
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
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error: NodeJS.ErrnoException) => finish(() => reject(new CliError(error.code === 'ENOENT' ? 'TOOL_NOT_FOUND' : 'PROCESS_FAILED', error.message))));
    child.once('close', (exitCode, signal) => finish(() => {
      if (termination) {
        reject(new CliError(termination.code, termination.message, { ...termination.details, result: result(exitCode, signal) }));
      } else if (inputError && exitCode === 0) {
        reject(new CliError('PROCESS_FAILED', `Unable to write process stdin: ${inputError.message}`));
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
    // Content is input data, never part of argv or error details. Always send EOF, including empty input.
    child.stdin.on('error', error => { inputError = error; });
    child.stdin.end(options.stdin);
  });
}
