import { describe, expect, it } from 'vitest';
import { commandResult } from '../../src/core/command-result.js';
import type { LoadedConfig } from '../../src/config/config.js';
const config: LoadedConfig = { version: 2, platform: 'ios', root: '/repo', simulator: { udid: 'CONFIGURED' }, app: { type: 'native', project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' } };
const capturedAt = '2026-10-05T12:00:00.000Z';

describe('command result metadata', () => {
  it('uses the actual lifecycle device and keeps create/delete/boot aliases', () => {
    const device = { udid: 'ACTUAL', name: 'Phone', state: 'Booted' };
    const boot = commandResult({ action: 'boot', device }, { key: 'simulator boot', target: 'device', config, capturedAt });
    expect(boot).toMatchObject({ action: 'boot', device, udid: 'ACTUAL', bundleId: null, run: null, capturedAt });
    expect(commandResult({ created: device }, { key: 'simulator create', target: 'device', capturedAt })).toMatchObject({ created: device, udid: 'ACTUAL', action: 'create' });
    expect(commandResult({ deleted: 'ACTUAL', warning: 'Configured Simulator' }, { key: 'simulator delete', target: 'device', capturedAt })).toMatchObject({ deleted: 'ACTUAL', udid: 'ACTUAL', warning: 'Configured Simulator' });
    // A configured selector is not proof of an observed device.
    expect(commandResult({}, { key: 'clean', target: 'none', config, capturedAt })).toMatchObject({ udid: null, bundleId: null, run: null });
  });

  it('preserves all-apps permission scope instead of filling in the configured app', () => {
    expect(commandResult({ action: 'reset', bundleId: null, udid: 'ACTUAL' }, { key: 'privacy reset', target: 'app', config, capturedAt })).toMatchObject({ action: 'reset', bundleId: null, udid: 'ACTUAL' });
    expect(commandResult({ udid: 'ACTUAL' }, { key: 'push', target: 'app', config, capturedAt }).bundleId).toBe('com.example.app');
  });

  it('groups diagnostics artifacts without confusing log text, crash sources or build products with evidence paths', () => {
    const diagnosis = { generatedAt: capturedAt, evidence: {
      simulator: { udid: 'ACTUAL' }, build: { appPath: '/products/App.app' },
      observation: { screenshot: '.agemu/runs/a/screenshots/screen.png' },
      logs: { artifact: '.agemu/runs/b/logs.txt', logs: ['Text is not a path'] },
      crashes: { crashes: [{ file: '.agemu/runs/c/crashes/App.ips', source: 'original.ips' }] },
      server: { outputSource: '.agemu/metro.log', output: ['Console text'] },
    } };
    const mapped = commandResult(diagnosis, { key: 'diagnose', target: 'app', config });
    expect(mapped).toMatchObject({ udid: 'ACTUAL', bundleId: 'com.example.app', run: null, capturedAt, generatedAt: capturedAt, evidence: diagnosis.evidence });
    expect(mapped.artifacts).toEqual({ screenshots: ['.agemu/runs/a/screenshots/screen.png'], recordings: [],
      logs: ['.agemu/runs/b/logs.txt', '.agemu/metro.log'], reports: ['.agemu/runs/c/crashes/App.ips'], files: [], transcript: null, backend: null });
  });

  it('retains flat UI evidence and backend aliases while collecting all media under common artifacts', () => {
    const ui = { udid: 'ACTUAL', bundleId: 'com.example.app', run: '.agemu/runs/ui', backend: 'xctest', completed: 3, actions: 3,
      screenshot: 'shot.png', screenshots: ['shot.png', 'later.png'], recordings: ['flow.mp4'], inspections: [{ index: 1, elements: [] }],
      transcript: 'ui.log', resultBundle: 'result.xcresult', backendArtifacts: { resultBundle: 'result.xcresult' }, runnerResult: { completed: 3 } };
    const mapped = commandResult(ui, { key: 'ui run', target: 'app', config, capturedAt });
    expect(mapped).toMatchObject(ui);
    expect(mapped.artifacts).toEqual({ screenshots: ['shot.png', 'later.png'], recordings: ['flow.mp4'], logs: [], reports: [], files: [], transcript: 'ui.log', backend: { resultBundle: 'result.xcresult' } });
  });

  it('exposes build log aliases and explicit empty/null evidence for Expo native-only fields', () => {
    const expo = { target: null, derivedData: null, logs: { build: '.agemu/runs/build/build.log', settings: null }, appPath: '/products/App.app' };
    const mapped = commandResult(expo, { key: 'build', target: 'app', config, capturedAt });
    expect(mapped).toMatchObject(expo);
    expect(mapped.artifacts.logs).toEqual(['.agemu/runs/build/build.log']);
    expect(mapped.artifacts.files).toEqual([]);
    expect(mapped.run).toBeNull();
  });
});
