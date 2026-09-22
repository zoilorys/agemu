import { describe, expect, it } from 'vitest';
import { CliError } from '../../src/core/errors.js';
import { errorResult } from '../../src/core/output.js';

describe('error result contract', () => {
  it('does not disclose a stack trace unless debugging is requested', () => {
    const error = new CliError('COMMAND_INVALID', 'Unknown command: nope');

    expect(errorResult(error, false)).toEqual({
      ok: false,
      error: { code: 'COMMAND_INVALID', message: 'Unknown command: nope' },
    });
    expect(errorResult(error, true)).toMatchObject({
      ok: false,
      error: { stack: expect.any(String) },
    });
  });
});
