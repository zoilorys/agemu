import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doctor } from '../../src/doctor/doctor.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const failed = (stderr: string): ProcessResult => ({
  stdout: '', stderr, exitCode: 1, signal: null, startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1,
});
const succeeded = (stdout = ''): ProcessResult => ({
  stdout, stderr: '', exitCode: 0, signal: null, startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1,
});

describe('doctor', () => {
  it('returns independent failures instead of stopping at the first prerequisite', async () => {
    const result = await doctor({
      root: '/missing-root',
      nodeVersion: '22.0.0',
      run: async (executable) => executable === 'xcodebuild' ? failed('xcode unavailable') : executable === 'xcrun' ? failed('simctl unavailable') : failed('missing'),
      loadConfig: async () => { throw new Error('bad config'); },
      listDevices: async () => { throw new Error('should not be called without config'); },
      canWrite: async () => { throw new Error('read-only'); },
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toMatchObject({
      node: { ok: false }, xcode: { ok: false, message: 'xcode unavailable' }, simctl: { ok: false, message: 'simctl unavailable' },
      config: { ok: false, message: 'bad config' }, project: { ok: false }, scheme: { ok: false }, simulator: { ok: false }, stateDirectory: { ok: false, message: 'read-only' },
    });
  });

  it('rejects a regular file where the state directory belongs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-doctor-'));
    await writeFile(path.join(root, '.agemu'), 'not a directory');
    try {
      const result = await doctor({
        root,
        run: async () => succeeded(),
        loadConfig: async () => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'fixture' }, root }),
        listDevices: async () => [{ udid: 'fixture', name: 'Fixture', runtime: 'iOS', state: 'Booted', isAvailable: true }],
      });

      expect(result.checks.stateDirectory).toMatchObject({ ok: false, message: expect.stringContaining('must be a directory') });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports readiness from native prerequisites', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-doctor-'));
    await mkdir(path.join(root, 'App.xcodeproj'));
    try {
      const result = await doctor({
        root,
        run: async () => succeeded(),
        loadConfig: async () => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'fixture' }, root }),
        listDevices: async () => [{ udid: 'fixture', name: 'Fixture', runtime: 'iOS-26-0', state: 'Booted', isAvailable: true }],
        canWrite: async () => undefined,
      });

      expect(result.ready).toBe(true);
      expect(result.ready).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['react-native', 'expo'] as const)('reports pending %s workflow without probing an Xcode scheme', async (type) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-doctor-'));
    const calls: string[][] = [];
    try {
      const app = type === 'react-native'
        ? { type, root, port: 8081, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }
        : { type, root, port: 8081, launchTarget: 'expo-go' as const, hostBundleId: 'host.exp.Exponent' };
      const result = await doctor({
        root,
        run: async (executable, args) => { calls.push([executable, ...args]); return succeeded(); },
        loadConfig: async () => ({ version: 2, platform: 'ios', app, simulator: { udid: 'fixture' }, root }),
        listDevices: async () => [{ udid: 'fixture', name: 'Fixture', runtime: 'iOS-26-0', state: 'Booted', isAvailable: true }],
        canWrite: async () => undefined,
      });

      expect(result.ready).toBe(false);
      expect(result.checks).toMatchObject({
        config: { ok: true },
        workflow: { ok: false, message: expect.stringContaining(`${type} workflow is not implemented`) },
        project: { ok: false, message: expect.stringContaining(`${type} workflow is not implemented`) },
        scheme: { ok: false, message: expect.stringContaining(`${type} workflow is not implemented`) },
        simulator: { ok: true },
      });
      expect(calls.some((args) => args.includes('-showBuildSettings'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
