import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/commands/build.js';
import type { LoadedConfig } from '../../src/config/config.js';
import { CliError } from '../../src/core/errors.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const processResult = (stdout = '', stderr = '', exitCode: number | null = 0): ProcessResult => ({
  stdout, stderr, exitCode, signal: null, startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1,
});
const settings = `Build settings for action build and target secret-token-App:\n    TARGET_BUILD_DIR = /products/secret-token\n    WRAPPER_NAME = App.app\n    EXECUTABLE_NAME = ActualApp\n    PRODUCT_BUNDLE_IDENTIFIER = com.example.app\n`;

function config(root: string): LoadedConfig {
  return { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, redactions: ['secret-token'], root };
}

describe('build command', () => {
  it('publishes an Expo product only after matching the built app bundle ID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-build-'));
    const cli = path.join(root, 'node_modules/expo/bin/cli');
    const appPath = path.join(root, 'DerivedData/Build/Products/Debug-iphonesimulator/Expo.app');
    const expo: LoadedConfig = { version: 2, platform: 'ios', app: { type: 'expo', root, port: 8081, launchTarget: 'development-build', bundleId: 'com.example.expo' }, simulator: { udid: 'PHONE' }, root };
    const calls: string[] = [];
    try {
      await mkdir(path.dirname(cli), { recursive: true });
      await writeFile(cli, '');
      await mkdir(path.join(root, 'node_modules/expo-dev-client'), { recursive: true });
      await writeFile(path.join(root, 'node_modules/expo-dev-client/package.json'), '{}');
      await mkdir(appPath, { recursive: true });
      await writeFile(path.join(appPath, 'Info.plist'), 'fixture');
      const run = async (executable: string, args: string[]) => {
        calls.push(executable);
        if (executable === 'plutil') return processResult(args[1] === 'CFBundleIdentifier' ? 'com.example.expo' : 'Expo');
        return processResult(`CONFIGURATION_BUILD_DIR = ${path.dirname(appPath)}\nUNLOCALIZED_RESOURCES_FOLDER_PATH = Expo.app\n`);
      };
      const result = await buildApp(expo, { run, resolveUdid: async () => 'PHONE' });
      expect(result).toMatchObject({ appType: 'expo', target: null, derivedData: null, logs: { settings: null, build: expect.stringContaining('expo-build.log') } });
      expect(JSON.parse(await readFile(path.join(root, '.agemu/state.json'), 'utf8'))).toMatchObject({ appPath, bundleId: 'com.example.expo' });
      await expect(buildApp(expo, { run: async (executable, args) => executable === 'plutil' ? processResult(args[1] === 'CFBundleIdentifier' ? 'com.wrong.app' : 'Expo') : processResult(`CONFIGURATION_BUILD_DIR = ${path.dirname(appPath)}\nUNLOCALIZED_RESOURCES_FOLDER_PATH = Expo.app\n`), resolveUdid: async () => 'PHONE' })).rejects.toMatchObject({ code: 'BUILD_FAILED' });
      expect(JSON.parse(await readFile(path.join(root, '.agemu/state.json'), 'utf8'))).toMatchObject({ appPath, bundleId: 'com.example.expo' });
      expect(calls[0]).toBe(process.execPath);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains redacted logs and atomically publishes discovered product state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    const calls: string[][] = [];
    const responses = [processResult('compile secret-token\n'), processResult(settings)];
    try {
      const result = await buildApp(config(root), {
        resolveUdid: async () => 'PHONE', now: () => new Date('2026-09-21T12:00:00.000Z'),
        run: async (_executable, args) => { calls.push(args); return responses.shift()!; },
      });
      expect(result).toMatchObject({ appType: 'native', appPath: '/products/[REDACTED]/App.app', bundleId: 'com.example.app', target: '[REDACTED]-App', udid: 'PHONE', derivedData: path.join(root, '.agemu/DerivedData'), logs: { settings: expect.stringContaining('build-settings.log') } });
      expect(calls).toHaveLength(2);
      expect(await readFile(path.join(root, result.logs.build), 'utf8')).toBe('compile [REDACTED]\n--- stderr ---\n');
      expect(JSON.parse(await readFile(path.join(root, '.agemu/state.json'), 'utf8'))).toMatchObject({
        appPath: '/products/secret-token/App.app', bundleId: 'com.example.app', executableName: 'ActualApp', udid: 'PHONE', configuration: 'Debug',
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns BUILD_FAILED metadata while preserving the complete redacted output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    try {
      const error = await buildApp(config(root), {
        resolveUdid: async () => 'PHONE', now: () => new Date('2026-09-21T12:00:00.000Z'),
        run: async () => processResult(
          'CompileSwift App.swift\n/src/secret-token/App.swift:12:5: error: cannot find \'x\' in scope\n',
          '/src/secret-token/App.swift:12:5: error: cannot find \'x\' in scope\n** BUILD FAILED **\n', 65),
      }).catch((caught: unknown) => caught as CliError);
      expect(error).toMatchObject({ code: 'BUILD_FAILED', details: { exitCode: 65, log: expect.stringContaining('xcodebuild.log') } });
      expect(error.details?.errors).toEqual([{ file: '/src/[REDACTED]/App.swift', line: 12, column: 5, message: 'cannot find \'x\' in scope' }]);
      expect(error.details).not.toHaveProperty('tail');
      const logPath = error.details?.log as string;
      expect(logPath.startsWith('.agemu/runs/2026-09-21T12-00-00.000Z-')).toBe(true);
      const log = await readFile(path.join(root, logPath), 'utf8');
      expect(log).toBe([
        'CompileSwift App.swift', '/src/[REDACTED]/App.swift:12:5: error: cannot find \'x\' in scope', '--- stderr ---',
        '/src/[REDACTED]/App.swift:12:5: error: cannot find \'x\' in scope', '** BUILD FAILED **', '',
      ].join('\n'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns the last 20 non-empty output lines as tail when no error line parses', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    const stdout = Array.from({ length: 30 }, (_, index) => `step ${index} secret-token`).join('\n\n');
    try {
      const error = await buildApp(config(root), {
        resolveUdid: async () => 'PHONE', run: async () => processResult(stdout, 'Killed\n', 65),
      }).catch((caught: unknown) => caught as CliError);
      expect(error.details).not.toHaveProperty('errors');
      expect(error.details?.tail).toEqual([...Array.from({ length: 19 }, (_, index) => `step ${index + 11} [REDACTED]`), 'Killed']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { failedCall: 1, log: 'xcodebuild.log' },
    { failedCall: 2, log: 'build-settings.log' },
  ])('normalizes a rejected xcodebuild invocation $failedCall and retains diagnostics', async ({ failedCall, log }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    let call = 0;
    try {
      const error = await buildApp(config(root), {
        resolveUdid: async () => 'PHONE', now: () => new Date('2026-09-21T12:00:00.000Z'),
        run: async () => {
          call += 1;
          if (call === failedCall) throw new CliError('PROCESS_FAILED', 'spawn rejected secret-token', {
            result: processResult('partial secret-token', 'failure secret-token', null),
          });
          return processResult('build completed');
        },
      }).catch((caught: unknown) => caught as CliError);
      expect(error).toMatchObject({ code: 'BUILD_FAILED', details: { log: expect.stringContaining(log) } });
      expect(await readFile(path.join(root, error.details?.log as string), 'utf8')).toBe(
        'partial [REDACTED]\n--- stderr ---\nfailure [REDACTED]\n--- execution error ---\nspawn rejected [REDACTED]\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { failedCall: 1, log: 'xcodebuild.log' },
    { failedCall: 2, log: 'build-settings.log' },
  ])('reports a timed-out xcodebuild invocation $failedCall as PROCESS_TIMEOUT with its log', async ({ failedCall, log }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    let call = 0;
    try {
      const error = await buildApp(config(root), {
        resolveUdid: async () => 'PHONE', timeoutMs: 5_000,
        run: async () => {
          call += 1;
          if (call === failedCall) throw new CliError('PROCESS_TIMEOUT', 'Process timed out', { result: processResult('partial secret-token', '', null) });
          return processResult(settings);
        },
      }).catch((caught: unknown) => caught as CliError);
      expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', message: 'Build exceeded 5 s', details: { timeoutSeconds: 5, log: expect.stringContaining(log) } });
      expect((await readFile(path.join(root, error.details?.log as string), 'utf8')).startsWith('partial [REDACTED]\n--- stderr ---\n')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('gives every process call the remaining part of one build deadline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    const timeouts: Array<number | undefined> = [];
    const responses = [processResult(), processResult(settings)];
    try {
      await buildApp(config(root), {
        resolveUdid: async () => 'PHONE', timeoutMs: 60_000,
        run: async (_executable, _args, options) => {
          timeouts.push(options?.timeoutMs);
          await new Promise(resolve => setTimeout(resolve, 20));
          return responses.shift()!;
        },
      });
      expect(timeouts).toHaveLength(2);
      for (const timeout of timeouts) expect(timeout).toBeGreaterThan(0);
      expect(timeouts[0]).toBeLessThanOrEqual(60_000);
      // The second call starts later on the same deadline, so it receives less time.
      expect(timeouts[1]).toBeLessThan(timeouts[0]!);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps concurrent builds with identical timestamps in separate run directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    const now = () => new Date('2026-09-21T12:00:00.000Z');
    const start = (label: string) => {
      const responses = [processResult(`stdout-${label}`), processResult(settings)];
      return buildApp(config(root), { resolveUdid: async () => 'PHONE', now, run: async () => responses.shift()! });
    };
    try {
      const [first, second] = await Promise.all([start('one'), start('two')]);
      expect(first.run).not.toBe(second.run);
      expect(first.run.startsWith('.agemu/runs/2026-09-21T12-00-00.000Z-')).toBe(true);
      expect(await readFile(path.join(root, first.logs.build), 'utf8')).toBe('stdout-one\n--- stderr ---\n');
      expect(await readFile(path.join(root, second.logs.build), 'utf8')).toBe('stdout-two\n--- stderr ---\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('redacts a declared secret from product-selection errors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    const secretConfig = { ...config(root), app: { ...config(root).app, bundleId: 'com.top-secret.app' }, redactions: ['top-secret'] };
    const responses = [processResult(), processResult(settings)];
    try {
      await expect(buildApp(secretConfig, {
        resolveUdid: async () => 'PHONE', run: async () => responses.shift()!,
      })).rejects.toMatchObject({ code: 'BUILD_FAILED', message: expect.not.stringContaining('top-secret') });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
