import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeLaunchMarker } from '../../src/artifacts/launch-marker.js';
import { diagnose } from '../../src/commands/diagnostics.js';
import { localTimestamp } from '../../src/commands/since.js';
import type { AppState } from '../../src/commands/build.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { Device } from '../../src/native/simctl.js';

const device: Device = { udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true };
const state: AppState = { appPath: '/products/App.app', bundleId: 'com.example.app', executableName: 'AppExecutable', udid: 'PHONE', configuration: 'Debug', updatedAt: 'then' };

describe('diagnose command', () => {
  it.each([true, false])('reports installed Expo Go host availability (%s) without inventing a native build', async installed => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-go-'));
    const config: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'expo', root, port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' }, simulator: { udid: 'PHONE' }, root };
    let stateReads = 0;
    try {
      const result = await diagnose(config, {}, {
        resolveDevice: async () => device, readState: async () => { stateReads++; throw new Error('no local build'); },
        serverStatus: async () => ({ running: true, owned: false, port: 8081 }), readServerOutput: async () => '', readEvents: async () => '',
        crashDirectory: path.join(root, 'missing'),
        runner: async args => ({ stdout: args[0] === 'listapps' && installed ? '{ "host.exp.Exponent" = { CFBundleIdentifier = "host.exp.Exponent"; CFBundleExecutable = Exponent; }; }' : '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result.evidence.availability).toEqual({ build: { applicable: false, available: false }, host: { applicable: true, available: installed } });
      expect(result.evidence.build).toBeNull();
      if (installed) {
        expect(result.evidence.host).toMatchObject({ bundleId: 'host.exp.Exponent', executableName: 'Exponent' });
        expect(result.failures).not.toHaveProperty('host');
      } else {
        expect(result.evidence.host).toBeNull();
        expect(result.failures.host).toMatchObject({ message: expect.stringContaining('not installed') });
      }
      expect(stateReads).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports a stale build as unavailable and keeps other evidence when event recording fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-stale-'));
    const config: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'native', project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      await mkdir(path.join(root, '.agemu/events.jsonl'), { recursive: true });
      const dependencies = { resolveDevice: async () => device, readState: async () => ({ ...state, bundleId: 'com.other.app' }), readEvents: async () => '', crashDirectory: path.join(root, 'missing'), runner: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }) };
      const result = await diagnose(config, {}, dependencies);
      expect(result).toMatchObject({ partial: true, evidence: { build: null, host: null, availability: { build: { applicable: true, available: false }, host: { applicable: false, available: false } }, observation: { screenshot: expect.stringContaining('screen.png') }, crashes: { crashes: [] } }, failures: { build: { code: 'APP_NOT_BUILT' } } });
      const complete = await diagnose(config, {}, { ...dependencies, readState: async () => state });
      expect(complete).toMatchObject({ partial: false, evidence: { build: state, availability: { build: { available: true } } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { name: 'status inspection fails', status: async () => { throw new Error('ps denied secret-value'); }, failure: 'ps denied [REDACTED]' },
    { name: 'an external server is running', status: async () => ({ running: true, owned: false, port: 8081 }), failure: undefined },
    { name: 'an owned server reuses an older log', status: async () => ({ running: true, owned: true, port: 8081, log: '.agemu/metro.log' }), failure: undefined },
  ])('labels saved output when $name', async ({ status, failure }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-server-'));
    const config: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'react-native', root, port: 8081, project: `${root}/ios/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root };
    try {
      const result = await diagnose(config, {}, {
        resolveDevice: async () => device, readState: async () => state,
        serverStatus: status,
        readServerOutput: async () => 'Bundling failed: secret-value\n',
        readEvents: async () => '', crashDirectory: path.join(root, 'no-crash-reports'),
        runner: async () => ({ stdout: 'native log', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result.evidence.server).toMatchObject({ consoleCoverage: expect.stringContaining('agemu logs js'), outputRelation: 'saved log; current server association unverified', bundlingErrors: ['Bundling failed: [REDACTED]'] });
      expect(result.evidence.logs).toMatchObject({ logs: ['native log'] });
      if (failure) expect(result.failures.server).toMatchObject({ message: failure });
      else expect(result.failures).not.toHaveProperty('server');
      expect(JSON.stringify(result)).not.toContain('secret-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains native evidence and redacted bundling errors when Metro exits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-rn-'));
    const config: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'react-native', root, port: 8081, project: `${root}/ios/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root };
    try {
      const result = await diagnose(config, {}, {
        resolveDevice: async () => device, readState: async () => state,
        serverStatus: async () => ({ running: false, owned: false, port: 8081 }),
        readServerOutput: async () => 'Bundling failed: secret-value in index.js\nerror: Unable to resolve module secret-value\n',
        readEvents: async () => '', crashDirectory: path.join(root, 'no-crash-reports'),
        runner: async () => ({ stdout: 'native log', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result).toMatchObject({ partial: true, evidence: { observation: { bundleId: 'com.example.app' }, logs: { source: 'Simulator unified log', logs: ['native log'] }, server: { status: { running: false }, bundlingErrors: ['Bundling failed: [REDACTED] in index.js', 'error: Unable to resolve module [REDACTED]'] } }, failures: { server: { code: 'PROCESS_FAILED' } } });
      expect(JSON.stringify(result)).not.toContain('secret-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports no crashes, not a failure, when the crash reports directory is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-crashes-'));
    const config: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'native', project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      const result = await diagnose(config, {}, {
        resolveDevice: async () => device, readState: async () => state, readEvents: async () => '',
        crashDirectory: path.join(root, 'missing'),
        runner: async () => ({ stdout: 'app log', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result.evidence.crashes).toMatchObject({ bundleId: 'com.example.app', crashes: [], skipped: 0 });
      expect(result.failures).not.toHaveProperty('crashes');
      expect(result.partial).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    {
      name: 'starts at a matching agemu launch', launched: { udid: 'PHONE', bundleId: 'com.example.app' }, start: '2026-09-30T11:50:00.000Z',
      window: { logs: { start: '2026-09-30T11:50:00.000Z', source: 'launch' }, crashes: { start: '2026-09-30T11:50:00.000Z', source: 'launch' } },
      range: ['--start', localTimestamp(new Date('2026-09-30T11:50:00.000Z'))],
    },
    {
      name: 'ignores a launch on another Simulator', launched: { udid: 'TABLET', bundleId: 'com.example.app' }, start: '2026-09-30T11:00:00.000Z',
      window: { logs: { start: '2026-09-30T11:59:30.000Z', source: 'default', last: '30s' }, crashes: { start: '2026-09-30T11:00:00.000Z', source: 'default' } },
      range: ['--last', '30s'],
    },
    {
      name: 'uses an explicit --last for logs only', options: { last: '5m' }, launched: { udid: 'PHONE', bundleId: 'com.example.app' }, start: '2026-09-30T11:00:00.000Z',
      window: { logs: { start: '2026-09-30T11:55:00.000Z', source: 'duration', last: '5m' }, crashes: { start: '2026-09-30T11:00:00.000Z', source: 'default' } },
      range: ['--last', '5m'],
    },
  ])('by default $name', async ({ launched, window, start, range, options }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-window-'));
    const config: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'native', project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    const calls: string[][] = [];
    try {
      await writeLaunchMarker(root, { at: new Date('2026-09-30T11:50:00.000Z'), source: 'app launch', ...launched });
      const result = await diagnose(config, options ?? {}, {
        now: () => new Date('2026-09-30T12:00:00.000Z'),
        resolveDevice: async () => device, readState: async () => state, readEvents: async () => '',
        crashDirectory: path.join(root, 'missing'),
        runner: async (args) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
      });
      expect(result.window).toEqual(window);
      expect(result.evidence.crashes).toMatchObject({ since: start });
      expect(calls.find((args) => args.includes('log'))?.slice(4, 6)).toEqual(range);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails an explicit --since=launch without a recorded launch, and --since with --last', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-since-'));
    const config: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'native', project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    const dependencies = {
      resolveDevice: async () => device, readState: async () => state, readEvents: async () => '', crashDirectory: path.join(root, 'missing'),
      runner: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
    };
    try {
      await expect(diagnose(config, { since: 'launch' }, dependencies)).rejects.toMatchObject({ code: 'COMMAND_INVALID', message: expect.stringContaining('No agemu launch recorded') });
      await expect(diagnose(config, { since: '5m', last: '1m' }, dependencies)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps successful evidence when screenshot capture fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-'));
    const config: LoadedConfig = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root };
    let invocation = 0;
    try {
      const result = await diagnose(config, { limit: 5 }, {
        resolveDevice: async () => device, readState: async () => state,
        readEvents: async () => '{"status":"error","message":"historical secret-value"}\n',
        crashDirectory: path.join(root, 'no-crash-reports'),
        runner: async () => {
          invocation += 1;
          return invocation === 1
            ? { stdout: '', stderr: 'screen unavailable', exitCode: 1, signal: null, startedAt: '', durationMs: 1 }
            : { stdout: 'app log', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 };
        },
      });
      expect(result).toMatchObject({
        partial: true,
        evidence: { simulator: { udid: 'PHONE' }, build: { bundleId: 'com.example.app' }, logs: { logs: ['app log'] } },
        failures: { observation: { code: 'PROCESS_FAILED', message: 'screen unavailable' } },
      });
      expect(result.evidence.recentErrors).toEqual([{ status: 'error', message: 'historical [REDACTED]' }]);
      expect(JSON.stringify(result)).not.toContain('secret-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
