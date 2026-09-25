import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../../src/config/config.js';
import { buildArguments, selectBuildProduct } from '../../src/native/xcodebuild.js';

const root = '/repo';
const base: LoadedConfig = {
  version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
  simulator: { udid: 'PHONE' }, root,
};
let settings: string;

beforeAll(async () => {
  settings = await readFile(fileURLToPath(new URL('../fixtures/xcodebuild-settings.txt', import.meta.url)), 'utf8');
});

describe('xcodebuild', () => {
  it('targets the selected simulator and reusable DerivedData for projects and workspaces', () => {
    expect(buildArguments(base, 'PHONE', 'build')).toEqual([
      '-project', '/repo/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug',
      '-destination', 'platform=iOS Simulator,id=PHONE', '-derivedDataPath', '/repo/.agemu/DerivedData', 'build',
    ]);
    const workspace: LoadedConfig = { ...base, app: { ...base.app, project: undefined, workspace: '/repo/App.xcworkspace' } } as LoadedConfig;
    expect(buildArguments(workspace, 'OTHER', 'settings')).toEqual([
      '-workspace', '/repo/App.xcworkspace', '-scheme', 'App', '-configuration', 'Debug',
      '-destination', 'platform=iOS Simulator,id=OTHER', '-derivedDataPath', '/repo/.agemu/DerivedData', '-showBuildSettings',
    ]);
  });

  it('selects the recorded app settings by exact bundle ID', () => {
    expect(selectBuildProduct(settings, 'com.example.app')).toEqual({
      target: 'ExampleApp',
      appPath: path.join('/tmp/DerivedData/Build/Products/Debug-iphonesimulator', 'Example App.app'),
      bundleId: 'com.example.app',
      executableName: 'ActualExecutable',
    });
    expect(() => selectBuildProduct(settings, 'missing.app')).toThrow('found 0');
  });
});
