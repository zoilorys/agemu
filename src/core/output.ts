import { CliError } from './errors.js';

export type Result<T> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown>; stack?: string };
};

export function writeResult<T>(result: Result<T>, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
}

export function errorResult(error: unknown, debug: boolean): Result<never> {
  const normalized = error instanceof CliError
    ? error
    : new CliError('PROCESS_FAILED', error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
      ...(debug && normalized.stack ? { stack: normalized.stack } : {}),
    },
  };
}
