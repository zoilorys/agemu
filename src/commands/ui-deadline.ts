import { CliError } from '../core/errors.js';
import type { Deadline, ProcessResult, RunOptions } from '../process/run-process.js';

export function uiTimeout(limit: Deadline, details: Record<string, unknown> = {}): CliError {
  return new CliError('PROCESS_TIMEOUT', `UI plan exceeded ${limit.ms / 1000} s`, { timeoutSeconds: limit.ms / 1000, ...details });
}
export function checkUiDeadline(limit: Deadline): void { if (limit.expired()) throw uiTimeout(limit); }

/** Time-box asynchronous orchestration and evidence IO; process calls additionally own cancellation. */
export async function uiOperation<T>(limit: Deadline, operation: () => Promise<T>): Promise<T> {
  checkUiDeadline(limit);
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(uiTimeout(limit)), limit.remaining());
    })]);
    checkUiDeadline(limit);
    return value;
  } finally { if (timer) clearTimeout(timer); }
}

export type UiRun = (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
export function boundedUiRun(run: UiRun, limit: Deadline): UiRun {
  return async (executable, args, options = {}) => {
    checkUiDeadline(limit);
    const result = await run(executable, args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? Infinity, limit.remaining()) });
    // Injected runners and a process finishing just at the deadline cannot turn an expired command into success.
    if (limit.expired()) throw uiTimeout(limit, { result });
    return result;
  };
}
