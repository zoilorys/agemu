import { describe, expect, it } from 'vitest';
import { privacy } from '../../src/commands/privacy.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { ProcessResult } from '../../src/process/run-process.js';
import { parseArgs } from '../../src/cli/args.js';

const config: LoadedConfig = {
  version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
  simulator: { udid: 'PHONE' }, redactions: ['top-secret'], root: '/repo',
};
const ok = (): ProcessResult => ({ stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 0 });
const device = (state: string) => async () => [{ udid: 'PHONE', name: 'Phone', runtime: 'iOS-18-0', state, isAvailable: true }];

function fake(responses: ProcessResult[] = [], state = 'Booted') {
  const calls: string[][] = [];
  return { calls, deps: { listDevices: device(state), runner: async (args: string[]) => { calls.push(args); return responses.shift() ?? ok(); } } };
}

describe('privacy command', () => {
  it.each([
    ['grant', { service: 'photos' }, ['privacy', 'PHONE', 'grant', 'photos', 'com.example.app'], 'com.example.app'],
    ['revoke', { service: 'location-always' }, ['privacy', 'PHONE', 'revoke', 'location-always', 'com.example.app'], 'com.example.app'],
    ['reset', { service: 'microphone' }, ['privacy', 'PHONE', 'reset', 'microphone', 'com.example.app'], 'com.example.app'],
    ['reset', { service: 'all', allApps: true }, ['privacy', 'PHONE', 'reset', 'all'], null],
  ] as const)('%s runs the exact simctl arguments', async (action, options, args, bundleId) => {
    const fixture = fake();
    const result = await privacy(config, action, options, fixture.deps);
    expect(fixture.calls).toEqual([args]);
    expect(result).toMatchObject({ action, service: options.service, udid: 'PHONE', bundleId });
    expect(result.note).toMatch(/terminated/);
  });

  it('rejects an unknown service listing the valid names before any simctl call', async () => {
    const fixture = fake();
    await expect(privacy(config, 'grant', { service: 'camera' }, fixture.deps)).rejects.toMatchObject({
      code: 'COMMAND_INVALID', message: expect.stringContaining('photos-add'),
    });
    expect(fixture.calls).toEqual([]);
  });

  it('rejects a missing service before any simctl call', async () => {
    const fixture = fake();
    await expect(privacy(config, 'reset', {}, fixture.deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(fixture.calls).toEqual([]);
  });

  it('refuses a Shutdown Simulator without invoking simctl', async () => {
    const fixture = fake([], 'Shutdown');
    await expect(privacy(config, 'grant', { service: 'photos' }, fixture.deps)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
    expect(fixture.calls).toEqual([]);
  });

  it('reports simctl failures redacted', async () => {
    const fixture = fake([{ ...ok(), stderr: 'denied top-secret', exitCode: 2 }]);
    await expect(privacy(config, 'grant', { service: 'photos' }, fixture.deps)).rejects.toMatchObject({
      code: 'PROCESS_FAILED', message: 'denied [REDACTED]',
    });
  });
});

describe('privacy argument parsing', () => {
  it('rejects --all-apps on grant and revoke', () => {
    expect(() => parseArgs(['privacy', 'grant', '--service=photos', '--all-apps'])).toThrow(/Unknown option --all-apps/);
    expect(() => parseArgs(['privacy', 'revoke', '--service=photos', '--all-apps'])).toThrow(/Unknown option --all-apps/);
  });

  it('accepts --all-apps on reset', () => {
    expect(parseArgs(['privacy', 'reset', '--service', 'all', '--all-apps']).flags.has('all-apps')).toBe(true);
  });
});
