import { describe, expect, it } from 'vitest';
import { parseArgs, values } from '../../src/cli/args.js';
import { helpFor } from '../../src/cli/help.js';

describe('helpFor', () => {
  it('includes shortcut targeting and numeric limits in focused command help', () => {
    const tap = helpFor('ui', 'tap');
    expect(tap).toContain('agemu ui tap');
    expect(tap).toContain('--id=VALUE');
    expect(tap).toContain('--label-contains=VALUE');
    expect(tap).toContain('--timeout=VALUE (1 to 86400 seconds; default 900)');
    expect(helpFor('crashes', 'list')).toContain('--limit=VALUE (1 to 100; default 10)');
    expect(helpFor('logs', 'show')).toContain('--limit=VALUE (0 to 10000; default 100)');
  });
});

describe('parseArgs', () => {
  it('resolves space and inline option forms identically', () => {
    const spaced = parseArgs(['simulator', 'boot', '--name', 'iPhone 16 Pro']);
    const inline = parseArgs(['simulator', 'boot', '--name=iPhone 16 Pro']);
    expect(spaced.flags).toEqual(inline.flags);
    expect(spaced.flags.get('name')).toEqual(['iPhone 16 Pro']);
  });

  it('rejects an unknown option naming the option and command', () => {
    expect(() => parseArgs(['logs', 'show', '--levle=info']))
      .toThrow(expect.objectContaining({ code: 'COMMAND_INVALID', message: 'Unknown option --levle for logs show' }));
  });

  it('rejects a value option followed by another option', () => {
    expect(() => parseArgs(['ui', 'run', '--plan', '--pretty']))
      .toThrow(expect.objectContaining({ code: 'COMMAND_INVALID', message: '--plan requires a value' }));
  });

  it('preserves inline values that start with --', () => {
    expect(values(parseArgs(['app', 'launch', '--arg=--verbose', '--env=A=B=C']), 'arg')).toEqual(['--verbose']);
    expect(parseArgs(['app', 'launch', '--env=A=B=C']).flags.get('env')).toEqual(['A=B=C']);
    expect(parseArgs(['ui', 'run', '--plan-json={"a":"--x"}']).flags.get('plan-json')).toEqual(['{"a":"--x"}']);
  });

  it('returns the command without validating when help is requested', () => {
    expect(parseArgs(['app', '--bogus', '--help'])).toMatchObject({ command: 'app', globals: { help: true } });
    expect(parseArgs(['logs', '--help']).command).toBe('logs');
  });

  it('accepts global options before the command', () => {
    expect(parseArgs(['--pretty', 'doctor'])).toMatchObject({ command: 'doctor', globals: { pretty: true } });
  });

  it('rejects unexpected positionals, missing subcommands, repeats, and valued booleans', () => {
    expect(() => parseArgs(['build', 'extra'])).toThrow('Unexpected argument: extra');
    expect(() => parseArgs(['app'])).toThrow('app requires one of: install, launch, terminate, restart, open-url');
    expect(() => parseArgs(['logs', 'show', '--limit=1', '--limit=2'])).toThrow('--limit may be given once');
    expect(() => parseArgs(['doctor', '--pretty=true'])).toThrow(expect.objectContaining({ code: 'COMMAND_INVALID' }));
  });

  it('does not read an option value as the subcommand', () => {
    expect(() => parseArgs(['app', '--url', 'launch'])).toThrow('app requires one of');
  });
});
