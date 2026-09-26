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
      await buildApp(expo, { run, resolveUdid: async () => 'PHONE' });
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
      expect(result).toMatchObject({ appPath: '/products/[REDACTED]/App.app', bundleId: 'com.example.app', target: '[REDACTED]-App', udid: 'PHONE' });
      expect(calls).toHaveLength(2);
      expect(JSON.parse(await readFile(path.join(root, result.logs.build), 'utf8'))).toEqual({
        stdout: 'compile [REDACTED]\n', stderr: '',
      });
      expect(JSON.parse(await readFile(path.join(root, '.agemu/state.json'), 'utf8'))).toMatchObject({
        appPath: '/products/secret-token/App.app', bundleId: 'com.example.app', executableName: 'ActualApp', udid: 'PHONE', configuration: 'Debug',
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns BUILD_FAILED metadata while preserving the complete redacted output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    try {
      await expect(buildApp(config(root), {
        resolveUdid: async () => 'PHONE', now: () => new Date('2026-09-21T12:00:00.000Z'),
        run: async () => processResult('many lines secret-token', 'compiler failed secret-token', 65),
      })).rejects.toMatchObject({ code: 'BUILD_FAILED', details: { exitCode: 65, log: expect.stringContaining('xcodebuild.log') } });
      const log = JSON.parse(await readFile(path.join(root, '.agemu/runs/2026-09-21T12-00-00.000Z/xcodebuild.log'), 'utf8'));
      expect(log).toEqual({ stdout: 'many lines [REDACTED]', stderr: 'compiler failed [REDACTED]' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { failedCall: 1, log: 'xcodebuild.log' },
    { failedCall: 2, log: 'build-settings.log' },
  ])('normalizes a rejected xcodebuild invocation $failedCall and retains diagnostics', async ({ failedCall, log }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-'));
    let call = 0;
    try {
      await expect(buildApp(config(root), {
        resolveUdid: async () => 'PHONE', now: () => new Date('2026-09-21T12:00:00.000Z'),
        run: async () => {
          call += 1;
          if (call === failedCall) throw new CliError('PROCESS_TIMEOUT', 'spawn rejected secret-token', {
            result: processResult('partial secret-token', 'failure secret-token', null),
          });
          return processResult('build completed');
        },
      })).rejects.toMatchObject({ code: 'BUILD_FAILED', details: { log: expect.stringContaining(log) } });
      const artifact = JSON.parse(await readFile(path.join(root, '.agemu/runs/2026-09-21T12-00-00.000Z', log), 'utf8'));
      expect(artifact).toMatchObject({
        stdout: 'partial [REDACTED]', stderr: 'failure [REDACTED]', executionError: 'spawn rejected [REDACTED]',
      });
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
