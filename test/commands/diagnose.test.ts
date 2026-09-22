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
  it('keeps successful evidence when screenshot capture fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-diagnose-'));
    const config: LoadedConfig = { version: 1, project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app', simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root };
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
