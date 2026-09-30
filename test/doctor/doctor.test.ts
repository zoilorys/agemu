import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doctor } from '../../src/doctor/doctor.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runProcess, type ProcessResult } from '../../src/process/run-process.js';

const execFileAsync = promisify(execFile);
import { CliError } from '../../src/core/errors.js';

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['react-native', 'expo'] as const)('reports %s prerequisites', async (type) => {
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
      if (type === 'react-native') {
        expect(result.checks).toMatchObject({ config: { ok: true }, reactNative: { ok: false }, ios: { ok: false }, project: { ok: false }, scheme: { ok: true }, simulator: { ok: true } });
        expect(calls.some((args) => args.includes('-showBuildSettings'))).toBe(true);
      } else {
        expect(result.checks).toMatchObject({ config: { ok: true }, expo: { ok: false }, project: { ok: false }, simulator: { ok: true } });
        expect(calls.some((args) => args.includes('-showBuildSettings'))).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  describe('advisory and destination checks', () => {
    const nativeConfig = (root: string) => async () => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'fixture-udid' }, root });
    const withProject = async (body: (root: string) => Promise<void>) => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-doctor-'));
      await mkdir(path.join(root, 'App.xcodeproj'));
      try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
    };
    const device = (state: string) => async () => [{ udid: 'fixture-udid', name: 'Fixture', runtime: 'iOS-26-0', state, isAvailable: true }];

    it('keeps ready true when only advisory checks fail', () => withProject(async (root) => {
      const result = await doctor({
        root,
        run: async (executable) => {
          if (executable === 'idb') throw new CliError('TOOL_NOT_FOUND', 'spawn idb ENOENT');
          if (executable === 'git') return failed('');
          return succeeded();
        },
        loadConfig: nativeConfig(root),
        listDevices: device('Shutdown'),
        canWrite: async () => undefined,
      });

      expect(result.ready).toBe(true);
      expect(result.checks).toMatchObject({
        idb: { ok: false, advisory: true, message: 'not installed; UI plans use XCTest' },
        simulatorBooted: { ok: false, advisory: true, message: 'run agemu simulator boot' },
        gitignore: { ok: false, advisory: true, message: 'add .agemu/ to .gitignore' },
      });
    }));

    it('validates the scheme against the resolved Simulator with a timeout', () => withProject(async (root) => {
      const calls: { executable: string; args: string[]; options?: { timeoutMs?: number } }[] = [];
      await doctor({
        root,
        run: async (executable, args, options) => { calls.push({ executable, args, options }); return succeeded(); },
        loadConfig: nativeConfig(root),
        listDevices: device('Booted'),
        canWrite: async () => undefined,
      });

      const scheme = calls.find((call) => call.args.includes('-showBuildSettings'));
      expect(scheme?.args.join(' ')).toContain('-destination platform=iOS Simulator,id=fixture-udid');
      expect(scheme?.options?.timeoutMs).toBe(60_000);
    }));

    it('reports a scheme timeout and blocks ready', () => withProject(async (root) => {
      const result = await doctor({
        root,
        run: async (_executable, args) => {
          if (args.includes('-showBuildSettings')) throw new CliError('PROCESS_TIMEOUT', 'Process timed out after 60000ms');
          return succeeded();
        },
        loadConfig: nativeConfig(root),
        listDevices: device('Booted'),
        canWrite: async () => undefined,
      });

      expect(result.checks.scheme).toEqual({ ok: false, message: 'xcodebuild -showBuildSettings timed out after 60 s' });
      expect(result.ready).toBe(false);
    }));

    it('treats a directory outside git as not needing an ignore rule', () => withProject(async (root) => {
      const result = await doctor({
        root,
        run: async (executable) => executable === 'git' ? { ...failed('fatal: not a git repository'), exitCode: 128 } : succeeded('fixture-udid'),
        loadConfig: nativeConfig(root),
        listDevices: device('Booted'),
        canWrite: async () => undefined,
      });

      expect(result.checks.gitignore).toMatchObject({ ok: true, message: 'not a git repository' });
      expect(result.checks.idb).toMatchObject({ ok: true, message: 'available' });
      expect(result.ready).toBe(true);
    }));

    it('reports idb stderr when list-targets fails', () => withProject(async (root) => {
      const result = await doctor({
        root,
        run: async (executable) => executable === 'idb' ? failed('companion unreachable') : succeeded(),
        loadConfig: nativeConfig(root),
        listDevices: device('Booted'),
        canWrite: async () => undefined,
      });

      expect(result.checks.idb).toMatchObject({ ok: false, advisory: true, message: 'companion unreachable' });
    }));

    it.each([
      ['.agemu/\n', true],
      ['.agemu\n', true],
      ['', false],
    ] as const)('checks a real git ignore rule %j before .agemu/ exists', (rule, ignored) => withProject(async (root) => {
      await execFileAsync('git', ['init', '-q'], { cwd: root });
      await writeFile(path.join(root, '.gitignore'), rule);
      const result = await doctor({
        root,
        run: async (executable, args, options) => executable === 'git' ? runProcess(executable, args, options) : succeeded('fixture-udid'),
        loadConfig: nativeConfig(root),
        listDevices: device('Booted'),
        canWrite: async () => undefined,
      });

      expect(result.checks.gitignore).toMatchObject(ignored ? { ok: true } : { ok: false, advisory: true, message: 'add .agemu/ to .gitignore' });
      expect(result.ready).toBe(true);
    }));

    it('adds advisory checks for Expo development builds', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-doctor-'));
      try {
        const result = await doctor({
          root,
          run: async (executable) => executable === 'idb' ? succeeded('fixture-udid') : succeeded(),
          loadConfig: async () => ({ version: 2, platform: 'ios', app: { type: 'expo', root, port: 8081, launchTarget: 'development-build' as const }, simulator: { udid: 'fixture-udid' }, root }),
          listDevices: device('Shutdown'),
          canWrite: async () => undefined,
        });

        expect(result.checks).toMatchObject({
          simulatorBooted: { ok: false, advisory: true },
          idb: { ok: true, advisory: true },
          gitignore: { ok: true, advisory: true },
        });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('still checks the ignore rule when configuration is missing', async () => {
      const result = await doctor({
        root: '/missing-root',
        run: async (executable) => executable === 'git' ? failed('') : succeeded(),
        loadConfig: async () => { throw new Error('bad config'); },
        listDevices: async () => { throw new Error('should not be called without config'); },
        canWrite: async () => undefined,
      });

      expect(result.checks.gitignore).toMatchObject({ ok: false, message: 'add .agemu/ to .gitignore' });
      expect(result.checks.idb).toBeUndefined();
      expect(result.checks.simulatorBooted).toBeUndefined();
    });
  });
});
