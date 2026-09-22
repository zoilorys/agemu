import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUiRunner, injectEnvironment } from '../../src/commands/ui.js';

describe('XCTest run manifest', () => {
  it('passes the plan only to test targets and preserves existing variables', () => {
    const manifest = {
      AgentRunner: { TestBundlePath: 'AgentRunner.xctest', EnvironmentVariables: { TERM: 'dumb' } },
      metadata: { FormatVersion: 1 },
    };

    expect(injectEnvironment(manifest, { AGEMU_PLAN_BASE64: 'encoded' })).toBe(1);
    expect(manifest.AgentRunner.EnvironmentVariables).toEqual({ TERM: 'dumb', AGEMU_PLAN_BASE64: 'encoded' });
    expect(manifest.metadata).toEqual({ FormatVersion: 1 });
  });

  it('reuses a built runner without invoking xcodebuild', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-runner-'));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, 'fixture');
    try {
      const result = await buildUiRunner({
        version: 1, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
        bundleId: 'com.example.app', simulator: { udid: 'PHONE' }, root,
      }, {
        run: async () => { throw new Error('xcodebuild must not run'); },
      });
      expect(result).toMatchObject({ manifest, cached: true, udid: 'PHONE' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
