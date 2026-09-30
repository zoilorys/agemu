import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { observe } from '../../src/commands/diagnostics.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { Device } from '../../src/native/simctl.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const device: Device = { udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true };
const processResult = (exitCode: number, stderr = ''): ProcessResult => ({ stdout: '', stderr, exitCode, signal: null, startedAt: '', durationMs: 1 });
const config = (root: string): LoadedConfig => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root });

describe('observe command', () => {
  it('captures a screenshot using the configured simulator and records app identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-observe-'));
    const calls: string[][] = [];
    try {
      const result = await observe(config(root), {
        now: () => new Date('2026-09-21T12:00:00.000Z'), resolveDevice: async () => device,
        runner: async (args) => { calls.push(args); return processResult(0); },
      });
      expect(calls[0].slice(0, 3)).toEqual(['io', 'PHONE', 'screenshot']);
      expect(result).toMatchObject({ bundleId: 'com.example.app', simulator: { udid: 'PHONE' }, capturedAt: '2026-09-21T12:00:00.000Z' });
      expect(result.screenshot).toMatch(/\.agemu\/runs\/.+\/screenshots\/screen\.png$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns a stable failure with run metadata and records a redacted event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-observe-'));
    try {
      await expect(observe(config(root), {
        resolveDevice: async () => ({ ...device, name: 'secret-value phone' }),
        runner: async () => processResult(1, 'secret-value screenshot failed'),
      })).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: '[REDACTED] screenshot failed', details: { run: expect.stringContaining('.agemu/runs/'), simulator: { name: '[REDACTED] phone' } } });
      const events = await readFile(path.join(root, '.agemu/events.jsonl'), 'utf8');
      expect(events).not.toContain('secret-value');
      expect(JSON.parse(events)).toMatchObject({ command: 'observe', status: 'error' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
