import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/process/run-process.js';
import { resolveExpoBundleId, setup } from '../../src/commands/setup.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const result = (stdout: string): ProcessResult => ({ stdout, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 });
const phone = { udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true };

const settings = JSON.stringify([
  { target: 'App', action: 'build', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application', PRODUCT_BUNDLE_IDENTIFIER: 'com.example.app' } },
  { target: 'Widget', action: 'build', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.app-extension', PRODUCT_BUNDLE_IDENTIFIER: 'com.example.app.widget' } },
  { target: 'AppTests', action: 'build', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.bundle.unit-test', PRODUCT_BUNDLE_IDENTIFIER: 'com.example.app.AppTests' } },
  { target: 'Watch', action: 'build', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application.watchapp2', PRODUCT_BUNDLE_IDENTIFIER: 'com.example.app.watch' } },
  { target: 'Unresolved', action: 'build', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application', PRODUCT_BUNDLE_IDENTIFIER: '$(UNSET)' } },
]);

const xcodebuild = (calls: string[][]) => async (executable: string, args: string[]): Promise<ProcessResult> => {
  expect(executable).toBe('xcodebuild');
  calls.push(args);
  if (args.includes('-list')) return result(JSON.stringify({ project: { schemes: ['App'] } }));
  return result(settings);
};

describe('Xcode setup discovery', () => {
  it('selects only the application target bundle ID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-native-'));
    try {
      await mkdir(path.join(root, 'App.xcodeproj'));
      const calls: string[][] = [];
      await setup(root, false, false, { listDevices: async () => [phone], run: xcodebuild(calls) });
      const config = JSON.parse(await readFile(path.join(root, '.agemu', 'config.json'), 'utf8'));
      expect(config.app).toMatchObject({ type: 'native', project: 'App.xcodeproj', scheme: 'App', bundleId: 'com.example.app' });
      expect(config.app.port).toBeUndefined();
      expect(calls[1]).toContain('-json');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the config and later evidence out of the enclosing git repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ignored-'));
    try {
      await runProcess('git', ['init', '-q'], { cwd: root });
      await mkdir(path.join(root, 'App.xcodeproj'));
      await setup(root, false, false, { listDevices: async () => [phone], run: xcodebuild([]) });
      await mkdir(path.join(root, '.agemu', 'runs', 'r1'), { recursive: true });
      await writeFile(path.join(root, '.agemu', 'runs', 'r1', 'screen.png'), '');
      const status = await runProcess('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
      expect(status.stdout.split('\n').filter(line => line.includes('.agemu'))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes the requested port for React Native', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-rn-'));
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
      await mkdir(path.join(root, 'ios/App.xcodeproj'), { recursive: true });
      await setup(root, false, false, { listDevices: async () => [phone], run: xcodebuild([]), port: 8082 });
      const config = JSON.parse(await readFile(path.join(root, '.agemu', 'config.json'), 'utf8'));
      expect(config.app).toMatchObject({ type: 'react-native', port: 8082, bundleId: 'com.example.app' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects --port for native projects without writing config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-native-port-'));
    try {
      await mkdir(path.join(root, 'App.xcodeproj'));
      await expect(setup(root, false, false, { listDevices: async () => [phone], run: xcodebuild([]), port: 8082 }))
        .rejects.toMatchObject({ code: 'COMMAND_INVALID' });
      await expect(access(path.join(root, '.agemu', 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports non-JSON build settings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-native-text-'));
    try {
      await mkdir(path.join(root, 'App.xcodeproj'));
      const run = async (_executable: string, args: string[]) => result(args.includes('-list') ? JSON.stringify({ project: { schemes: ['App'] } }) : 'PRODUCT_BUNDLE_IDENTIFIER = com.example.app');
      await expect(setup(root, false, false, { listDevices: async () => [phone], run }))
        .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'xcodebuild did not return JSON build settings' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('Expo setup discovery', () => {
  it('selects the only booted Simulator during noninteractive setup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-booted-'));
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
      await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.dev' } } }));
      const devices = [
        { udid: 'OFF', name: 'iPhone 16', runtime: 'iOS-18-0', state: 'Shutdown', isAvailable: true },
        { udid: 'ON', name: 'iPhone 17', runtime: 'iOS-19-0', state: 'Booted', isAvailable: true },
      ];
      const selected = await setup(root, false, false, { listDevices: async () => devices });
      expect(selected.config.simulator.udid).toBe('ON');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses an explicit UDID when several Simulators are available', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-udid-'));
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
      await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.dev' } } }));
      const devices = [
        { udid: 'ONE', name: 'iPhone 16', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true },
        { udid: 'TWO', name: 'iPhone 17', runtime: 'iOS-19-0', state: 'Booted', isAvailable: true },
      ];
      const selected = await setup(root, false, false, { listDevices: async () => devices, udid: 'TWO' });
      expect(selected.config.simulator.udid).toBe('TWO');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('sets up a development build without querying installed Expo Go hosts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-dev-'));
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
      await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.dev' } } }));
      const output = await setup(root, false, false, {
        listDevices: async () => [{ udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Shutdown', isAvailable: true }],
        installedExpoGoHosts: async () => { throw new Error('host lookup must not run'); },
      });
      expect(output.config.app).toMatchObject({ launchTarget: 'development-build', bundleId: 'com.example.dev' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes the requested Metro port', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-port-'));
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
      await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.dev' } } }));
      await setup(root, false, false, { listDevices: async () => [phone], port: 19000 });
      expect(JSON.parse(await readFile(path.join(root, '.agemu', 'config.json'), 'utf8')).app.port).toBe(19000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('resolves dynamic Expo config through the local CLI without generating native files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-setup-'));
    try {
      await mkdir(path.join(root, 'node_modules/expo/bin'), { recursive: true });
      await writeFile(path.join(root, 'node_modules/expo/bin/cli'), '');
      await writeFile(path.join(root, 'app.config.js'), 'module.exports = { ios: { bundleIdentifier: "com.example.dynamic" } };');
      await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.stale' } } }));
      let cwd: string | undefined;
      const bundleId = await resolveExpoBundleId(root, async (_executable, args, options) => {
        expect(args).toEqual([path.join(root, 'node_modules/expo/bin/cli'), 'config', '--json', '--type', 'public']);
        cwd = options?.cwd;
        return result(JSON.stringify({ ios: { bundleIdentifier: 'com.example.dynamic' } }));
      });
      expect(bundleId).toBe('com.example.dynamic');
      expect(cwd).toBe(root);
      await expect(access(path.join(root, 'ios'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(root, 'app.json'), 'utf8')).toContain('com.example.stale');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
