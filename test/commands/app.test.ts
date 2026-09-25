import { describe, expect, it } from 'vitest';
import { controlApp } from '../../src/commands/app.js';
import type { AppState } from '../../src/commands/build.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { ProcessResult, RunOptions } from '../../src/process/run-process.js';

const config: LoadedConfig = {
  version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
  simulator: { udid: 'PHONE' }, redactions: ['top-secret'], root: '/repo',
};
const state: AppState = { appPath: '/products/App.app', bundleId: 'com.example.app', executableName: 'AppExecutable', udid: 'PHONE', configuration: 'Debug', updatedAt: '' };
const ok = (): ProcessResult => ({ stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 0 });

function fake(responses: ProcessResult[] = []) {
  const calls: Array<{ args: string[]; options?: RunOptions }> = [];
  return { calls, dependencies: {
    resolveUdid: async () => 'PHONE', readState: async () => state, appExists: async () => {},
    runner: async (args: string[], options?: RunOptions) => { calls.push({ args, options }); return responses.shift() ?? ok(); },
  } };
}

describe('app command', () => {
  it('passes launch arguments and environment values unchanged', async () => {
    const fixture = fake();
    await controlApp(config, 'launch', { arguments: ['space value', '--literal=$HOME'], environment: ['TOKEN=top-secret', 'EMPTY='] }, fixture.dependencies);
    expect(fixture.calls[0]?.args).toEqual([
      'launch', 'PHONE', 'com.example.app', 'space value', '--literal=$HOME',
    ]);
    expect(fixture.calls[0]?.options?.env).toMatchObject({ SIMCTL_CHILD_TOKEN: 'top-secret', SIMCTL_CHILD_EMPTY: '' });
  });

  it('restarts with terminate and launch only, accepting an already stopped app', async () => {
    const fixture = fake([{ ...ok(), stderr: 'found nothing to terminate', exitCode: 3 }, ok()]);
    await controlApp(config, 'restart', {}, fixture.dependencies);
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ['terminate', 'PHONE', 'com.example.app'], ['launch', 'PHONE', 'com.example.app'],
    ]);
  });

  it('controls an installed app without cached build state', async () => {
    const fixture = fake();
    fixture.dependencies.readState = async () => { throw new Error('no build state'); };
    await controlApp(config, 'launch', {}, fixture.dependencies);
    await controlApp(config, 'terminate', {}, fixture.dependencies);
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ['launch', 'PHONE', 'com.example.app'], ['terminate', 'PHONE', 'com.example.app'],
    ]);
  });

  it('rejects a stale app product before installation', async () => {
    const fixture = fake();
    fixture.dependencies.readState = async () => ({ ...state, appPath: '/products/top-secret/App.app' });
    fixture.dependencies.appExists = async () => { throw new Error('missing'); };
    await expect(controlApp(config, 'install', {}, fixture.dependencies)).rejects.toMatchObject({
      code: 'APP_NOT_BUILT', message: 'Cached app product does not exist: /products/[REDACTED]/App.app',
    });
    expect(fixture.calls).toEqual([]);
  });

  it('targets the configured simulator for install and URL opening', async () => {
    const fixture = fake();
    await controlApp(config, 'install', {}, fixture.dependencies);
    await controlApp(config, 'open-url', { url: 'myapp://path?a=b c' }, fixture.dependencies);
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ['install', 'PHONE', '/products/App.app'],
      ['openurl', 'PHONE', 'myapp://path?a=b c'],
    ]);
  });

  it('redacts declared secrets from process failures', async () => {
    const fixture = fake([{ ...ok(), stderr: 'rejected top-secret', exitCode: 1 }]);
    await expect(controlApp(config, 'launch', { environment: ['TOKEN=top-secret'] }, fixture.dependencies)).rejects.toMatchObject({
      code: 'PROCESS_FAILED', message: 'rejected [REDACTED]',
      details: { command: ['xcrun', 'simctl', 'launch', 'PHONE', 'com.example.app'] },
    });
  });

  it('passes restart environment values through the simctl child environment', async () => {
    const fixture = fake();
    await controlApp(config, 'restart', { environment: ['VALUE=a=b c'] }, fixture.dependencies);
    expect(fixture.calls[1]?.args).toEqual(['launch', 'PHONE', 'com.example.app']);
    expect(fixture.calls[1]?.options?.env?.SIMCTL_CHILD_VALUE).toBe('a=b c');
  });

  it('rejects malformed launch environment entries before invoking simctl', async () => {
    const fixture = fake();
    await expect(controlApp(config, 'launch', { environment: ['NOT-VALID=value'] }, fixture.dependencies)).rejects.toMatchObject({
      code: 'COMMAND_INVALID',
    });
    expect(fixture.calls).toEqual([]);
  });
});
