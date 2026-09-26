import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, nativeApp } from '../../src/config/config.js';
import { resolveDevice } from '../../src/native/simctl.js';

const valid = {
  version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App/App.xcodeproj',
  scheme: 'App',
  configuration: 'Debug',
  bundleId: 'com.example.app' },
  simulator: { udid: 'chosen', name: 'Ignored', runtime: 'iOS-18-0' },
};

describe('config', () => {
  it('resolves a single relative project path from the supplied root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-config-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify(valid));
    try {
      await expect(loadConfig(root)).resolves.toMatchObject({ app: { project: path.join(root, 'App/App.xcodeproj') }, root });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports both configured build sources with their paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-config-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({ ...valid, app: { ...valid.app, workspace: 'App/App.xcworkspace' }, token: 'secret' }));
    try {
      await expect(loadConfig(root)).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        details: {
          issues: expect.arrayContaining([
            { path: 'app.project', message: 'exactly one of project or workspace is required' },
            { path: 'app.workspace', message: 'exactly one of project or workspace is required' },
            { path: 'token', message: 'is not allowed' },
          ]),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects version 1, another platform, and mixed app fields before commands run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-config-'));
    try {
      await writeFile(path.join(root, '.agemu.json'), JSON.stringify({ ...valid, version: 1, platform: 'android', app: { ...valid.app, port: 8081 } }));
      await expect(loadConfig(root)).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        details: { issues: expect.arrayContaining([
          { path: 'version', message: 'must be 2' },
          { path: 'platform', message: 'must be ios' },
          { path: 'app.port', message: 'is not allowed' },
        ]) },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('loads React Native paths for native execution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-config-'));
    try {
      await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
        ...valid,
        app: { ...valid.app, type: 'react-native', root: 'mobile', port: 8081 },
      }));
      const config = await loadConfig(root);
      expect(config.app).toMatchObject({ root: path.join(root, 'mobile'), project: path.join(root, 'App/App.xcodeproj') });
      expect(nativeApp(config).type).toBe('react-native');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses a configured UDID before name and runtime', () => {
    const device = resolveDevice([
      { udid: 'chosen', name: 'Other', runtime: 'iOS-17-0', state: 'Shutdown', isAvailable: true },
      { udid: 'name-match', name: 'Ignored', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true },
    ], valid.simulator);

    expect(device.udid).toBe('chosen');
  });
});
