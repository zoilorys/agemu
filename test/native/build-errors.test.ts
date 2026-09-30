import { describe, expect, it } from 'vitest';
import { parseBuildErrors } from '../../src/native/build-errors.js';

describe('parseBuildErrors', () => {
  it('parses each xcodebuild and Expo error format once, in first-seen order, ignoring warnings', () => {
    const output = [
      'CompileSwift normal arm64 /abs/App/View.swift',
      '/abs/App/View.swift:12:5: error: cannot find \'foo\' in scope',
      '/abs/App/View.swift:3:1: warning: unused variable',
      '/abs/My App/Legacy.m:40: error: expected \';\' after expression\r',
      '/abs/App/Main.swift:1:1: fatal error: module not found',
      'error: No signing certificate found',
      'ld: error: symbol(s) not found for architecture arm64',
      'clang: error: linker command failed with exit code 1',
      'xcodebuild: error: Unable to find a destination',
      'fatal error: too many errors emitted',
      'CommandError: Failed to build iOS project.',
      '/abs/App/View.swift:12:5: error: cannot find \'foo\' in scope',
      'error: No signing certificate found',
      '** BUILD FAILED **',
    ].join('\n');
    expect(parseBuildErrors(output)).toEqual([
      { file: '/abs/App/View.swift', line: 12, column: 5, message: 'cannot find \'foo\' in scope' },
      { file: '/abs/My App/Legacy.m', line: 40, message: 'expected \';\' after expression' },
      { file: '/abs/App/Main.swift', line: 1, column: 1, message: 'module not found' },
      { message: 'No signing certificate found' },
      { message: 'symbol(s) not found for architecture arm64' },
      { message: 'linker command failed with exit code 1' },
      { message: 'Unable to find a destination' },
      { message: 'too many errors emitted' },
      { message: 'Failed to build iOS project.' },
    ]);
  });

  it('stops at the limit', () => {
    const output = Array.from({ length: 30 }, (_, index) => `error: failure ${index}`).join('\n');
    expect(parseBuildErrors(output, 3)).toEqual([{ message: 'failure 0' }, { message: 'failure 1' }, { message: 'failure 2' }]);
    expect(parseBuildErrors(output)).toHaveLength(20);
  });
});
