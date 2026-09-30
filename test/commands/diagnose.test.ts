import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../../src/commands/diagnostics.js';
import type { AppState } from '../../src/commands/build.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { Device } from '../../src/native/simctl.js';

const device: Device = { udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true };
const state: AppState = { appPath: '/products/App.app', bundleId: 'com.example.app', executableName: 'AppExecutable', udid: 'PHONE', configuration: 'Debug', updatedAt: 'then' };

describe('diagnose command', () => {
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
        readEvents: async () => '',
        runner: async () => ({ stdout: 'native log', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result.evidence.server).toMatchObject({ outputRelation: 'saved log; current server association unverified', bundlingErrors: ['Bundling failed: [REDACTED]'] });
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
        readEvents: async () => '',
        runner: async () => ({ stdout: 'native log', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result).toMatchObject({ partial: true, evidence: { observation: { bundleId: 'com.example.app' }, logs: { source: 'Simulator unified log', logs: ['native log'] }, server: { status: { running: false }, bundlingErrors: ['Bundling failed: [REDACTED] in index.js', 'error: Unable to resolve module [REDACTED]'] } }, failures: { server: { code: 'PROCESS_FAILED' } } });
      expect(JSON.stringify(result)).not.toContain('secret-value');
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
