import { describe, expect, it } from 'vitest';
import { logLimit, parseCaptureDuration, parseDuration, parseUntil } from '../../src/core/log-options.js';

describe('capture option boundaries', () => {
  it.each(['9999999999999999999999s', '601s', '11m', '0s', '1h', undefined])('rejects unsafe or unbounded capture duration %s', value => {
    expect(() => parseCaptureDuration(value)).toThrow(expect.objectContaining({ code: 'COMMAND_INVALID' }));
  });

  it('rejects general duration overflow instead of passing Infinity to Dates', () => {
    expect(() => parseDuration(`${'9'.repeat(400)}d`, { message: 'invalid duration' })).toThrow(expect.objectContaining({ code: 'COMMAND_INVALID' }));
  });

  it.each(['', '('])('rejects an unusable stop expression %s before a capture starts', value => {
    expect(() => parseUntil(value)).toThrow(expect.objectContaining({ code: 'COMMAND_INVALID' }));
  });

  it.each([NaN, Infinity, -1, 0.5, 10_001])('rejects an unsafe retained-tail limit %s', value => {
    expect(() => logLimit(value)).toThrow(expect.objectContaining({ code: 'COMMAND_INVALID' }));
  });
});
