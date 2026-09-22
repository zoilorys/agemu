import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  return { version: 1, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app', simulator: { udid: 'PHONE' }, redactions: ['secret-token'], root };
}

describe('build command', () => {
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
    const secretConfig = { ...config(root), bundleId: 'com.top-secret.app', redactions: ['top-secret'] };
    const responses = [processResult(), processResult(settings)];
    try {
      await expect(buildApp(secretConfig, {
        resolveUdid: async () => 'PHONE', run: async () => responses.shift()!,
      })).rejects.toMatchObject({ code: 'BUILD_FAILED', message: expect.not.stringContaining('top-secret') });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
