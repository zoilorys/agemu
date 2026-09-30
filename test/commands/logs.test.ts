import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { showLogs } from '../../src/commands/diagnostics.js';
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
