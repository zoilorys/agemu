import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeLaunchMarker } from '../../src/artifacts/launch-marker.js';
import { showLogs, streamLogs } from '../../src/commands/diagnostics.js';
import type { AppState } from '../../src/commands/build.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { Device } from '../../src/native/simctl.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const device: Device = { udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true };
const config = (root: string): LoadedConfig => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root });
const state: AppState = { appPath: '/products/MyApp.app', bundleId: 'com.example.app', executableName: 'RealExecutable', udid: 'PHONE', configuration: 'Debug', updatedAt: '' };

describe('logs show command', () => {
  it('queries the installed Expo Go executable without native build state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-go-logs-'));
    const calls: string[][] = [];
    const go: LoadedConfig = { ...config(root), app: { type: 'expo', root, port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' } };
    try {
      const result = await showLogs(go, {}, {
        resolveDevice: async () => device,
        readState: async () => { throw new Error('no native build'); },
        runner: async (args) => {
          calls.push(args);
          return { stdout: args[0] === 'listapps' ? '{ "host.exp.Exponent" = { CFBundleIdentifier = "host.exp.Exponent"; CFBundleExecutable = Exponent; }; }' : 'Expo host log\n', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 };
        },
      });
      expect(result).toMatchObject({ bundleId: 'host.exp.Exponent', logs: ['Expo host log'] });
      expect(calls).toContainEqual(['spawn', 'PHONE', 'log', 'show', '--last', '30s', '--predicate', 'process == "Exponent"', '--style', 'compact']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns a bounded tail and retains the complete redacted log artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    const output = 'first secret-value\nsecond\nknown app message\nfourth\n';
    try {
      const result = await showLogs(config(root), { last: '45s', level: 'info', limit: 2 }, {
        now: () => new Date('2026-09-21T12:00:00.000Z'), resolveDevice: async () => device, readState: async () => state,
        runner: async (args) => { calls.push(args); return { stdout: output, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
      });
      expect(result).toMatchObject({ logs: ['known app message', 'fourth'], truncated: true, last: '45s', level: 'info' });
      expect(calls[0]).toEqual(['spawn', 'PHONE', 'log', 'show', '--last', '45s', '--info', '--predicate', 'process == "RealExecutable"', '--style', 'compact']);
      const artifact = await readFile(path.join(root, result.artifact), 'utf8');
      expect(artifact).toBe('first [REDACTED]\nsecond\nknown app message\nfourth\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('redacts the configured simulator identity from the result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const secretDevice = { ...device, udid: 'secret-value-PHONE' };
    try {
      const result = await showLogs(config(root), {}, {
        resolveDevice: async () => secretDevice,
        readState: async () => ({ ...state, udid: secretDevice.udid }),
        runner: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result.udid).toBe('[REDACTED]-PHONE');
      expect(JSON.stringify(result)).not.toContain('secret-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('starts at the latest agemu launch in local time with --since=launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    const launchedAt = new Date(2026, 8, 30, 7, 5, 9, 500);
    try {
      await writeLaunchMarker(root, { at: launchedAt, udid: 'PHONE', bundleId: 'com.example.app', source: 'app launch' });
      const result = await showLogs(config(root), { since: 'launch' }, {
        resolveDevice: async () => device, readState: async () => state,
        runner: async (args) => {
          calls.push(args);
          const stdout = 'Timestamp               Ty Process[PID:TID]\n2026-09-30 07:05:09.200 Df RealExecutable[1:2] before launch\n2026-09-30 07:05:09.600 Df RealExecutable[1:2] after launch\n';
          return { stdout, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 };
        },
      });
      expect(calls[0]).toEqual(['spawn', 'PHONE', 'log', 'show', '--start', expect.stringMatching(/^2026-09-30 07:05:09[+-]\d{4}$/), '--predicate', 'process == "RealExecutable"', '--style', 'compact']);
      expect(result).toMatchObject({ since: { start: launchedAt.toISOString(), source: 'launch' } });
      expect(result.logs).toEqual(['Timestamp               Ty Process[PID:TID]', '2026-09-30 07:05:09.600 Df RealExecutable[1:2] after launch']);
      expect(result).not.toHaveProperty('last');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects --since with --last and --since=launch without a recorded launch, before querying logs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    const dependencies = {
      resolveDevice: async () => device, readState: async () => state,
      runner: async (args: string[]) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
    };
    try {
      await expect(showLogs(config(root), { since: 'launch', last: '1m' }, dependencies)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
      await expect(showLogs(config(root), { since: 'launch' }, dependencies)).rejects.toMatchObject({ code: 'COMMAND_INVALID', message: expect.stringContaining('No agemu launch recorded') });
      expect(calls).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  describe('logs stream', () => {
    type Call = { executable: string; args: string[] };
    const streamOf = (lines: string[], calls: Call[], exit = { exitCode: 0 as number | null, stderr: '' }) =>
      async (executable: string, args: string[], options: { onLine: (line: string) => boolean | void }) => {
        calls.push({ executable, args });
        for (const line of lines) if (options.onLine(line) === true) return { stoppedBy: 'until' as const, exitCode: null, signal: 'SIGINT' as const, stderr: '' };
        return { stoppedBy: exit.exitCode === 0 ? 'duration' as const : 'exit' as const, exitCode: exit.exitCode, signal: null, stderr: exit.stderr };
      };

    it('redacts lines before matching and saves the redacted capture without the filter banner', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      const calls: Call[] = [];
      const lines = ['Filtering the log data using "process == \\"RealExecutable\\""', 'token secret-value issued', 'Login succeeded for [REDACTED]', 'never read'];
      try {
        const result = await streamLogs(config(root), { duration: '30s', until: 'issued|succeeded', level: 'debug' }, {
          resolveDevice: async () => device, readState: async () => state, stream: streamOf(lines, calls),
        });
        expect(calls[0]).toEqual({ executable: 'xcrun', args: ['simctl', 'spawn', 'PHONE', 'log', 'stream', '--style', 'compact', '--level', 'debug', '--predicate', 'process == "RealExecutable"'] });
        expect(result).toMatchObject({ stoppedBy: 'until', matched: true, matchedLine: 'token [REDACTED] issued', logs: ['token [REDACTED] issued'] });
        expect(await readFile(path.join(root, result.artifact), 'utf8')).toBe('token [REDACTED] issued\n');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('does not match a regex that only the unredacted secret would satisfy', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      try {
        const result = await streamLogs(config(root), { duration: '3s', until: 'secret-value', limit: 1 }, {
          resolveDevice: async () => device, readState: async () => state, stream: streamOf(['a secret-value', 'b'], []),
        });
        expect(result).toMatchObject({ stoppedBy: 'duration', matched: false, logs: ['b'], truncated: true });
        expect(result).not.toHaveProperty('matchedLine');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('fails with PROCESS_FAILED when log stream exits early with an error', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      try {
        await expect(streamLogs(config(root), { duration: '10s' }, {
          resolveDevice: async () => device, readState: async () => state, stream: streamOf([], [], { exitCode: 1, stderr: 'bad secret-value' }),
        })).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'bad [REDACTED]' });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it.each([[{}], [{ duration: '11m' }], [{ duration: '0s' }], [{ duration: '5h' }], [{ duration: '5s', until: '(' }]])(
      'rejects invalid options %j before streaming', async (options) => {
        const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
        const calls: Call[] = [];
        try {
          await expect(streamLogs(config(root), options, { resolveDevice: async () => device, readState: async () => state, stream: streamOf([], calls) }))
            .rejects.toMatchObject({ code: 'COMMAND_INVALID' });
          expect(calls).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
      });

    it('requires a booted simulator', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      const calls: Call[] = [];
      try {
        await expect(streamLogs(config(root), { duration: '5s' }, {
          resolveDevice: async () => ({ ...device, state: 'Shutdown' }), readState: async () => state, stream: streamOf([], calls),
        })).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('not booted') });
        expect(calls).toEqual([]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  it.each([
    ['default', ['--predicate', 'process == "RealExecutable"']],
    ['debug', ['--debug', '--predicate', 'process == "RealExecutable"']],
    ['error', ['--predicate', 'process == "RealExecutable" AND (messageType == error OR messageType == fault)']],
    ['fault', ['--predicate', 'process == "RealExecutable" AND messageType == fault']],
  ])('maps the %s level to supported log show arguments', async (level, expected) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    try {
      await showLogs(config(root), { level }, {
        resolveDevice: async () => device, readState: async () => state,
        runner: async (args) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
      });
      expect(calls[0]).toEqual(['spawn', 'PHONE', 'log', 'show', '--last', '30s', ...expected, '--style', 'compact']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
