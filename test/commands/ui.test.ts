import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUiRunner, injectEnvironment, runUiPlan } from '../../src/commands/ui.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const result = (stdout = '', stderr = '', exitCode = 0): ProcessResult => ({
  stdout, stderr, exitCode, signal: null, startedAt: '2026-09-25T00:00:00.000Z', durationMs: 1,
});

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
        version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
        bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root,
      }, {
        run: async () => { throw new Error('xcodebuild must not run'); },
      });
      expect(result).toMatchObject({ manifest, cached: true, udid: 'PHONE' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('UI backend selection', () => {
  it('keeps each recording active through its actions and supports multiple videos', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-videos-'));
    const events: string[] = [];
    const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
      bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      const plan = { version: 1, actions: [
        { startVideoRecording: { name: 'first' } }, { tap: { x: 10, y: 20 } }, { wait: { duration: 0 } },
        { tap: { x: 30, y: 40 } }, { stopVideoRecording: {} },
        { startVideoRecording: { name: 'second' } }, { tap: { x: 50, y: 60 } }, { stopVideoRecording: {} },
      ] };
      const output = await runUiPlan(config, { json: JSON.stringify(plan) }, {
        backend: 'idb',
        startRecording: async (_udid, file) => {
          events.push(`start:${path.basename(file)}`);
          return { stop: async () => { events.push('stop'); } };
        },
        run: async (executable, args) => {
          if (executable === 'idb' && args[1] === 'describe-all') return result('[]');
          if (executable === 'idb' && args[1] === 'tap') events.push(`tap:${args[2]}`);
          return result();
        },
      });
      expect(events).toEqual(['start:1-first.mp4', 'tap:10', 'tap:30', 'stop', 'start:2-second.mp4', 'tap:50', 'stop']);
      expect(output.recordings).toHaveLength(2);
      expect(output.segments).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('stops a recording when an action fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-video-failure-'));
    let stopped = false;
    const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
      bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      await expect(runUiPlan(config, { json: JSON.stringify({ version: 1, actions: [
        { startVideoRecording: {} }, { assertVisible: { label: 'Missing' } }, { stopVideoRecording: {} },
      ] }) }, {
        backend: 'idb',
        startRecording: async () => ({ stop: async () => { stopped = true; } }),
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result('[]') : result(),
      })).rejects.toMatchObject({ code: 'UI_DELIVERY_FAILED' });
      expect(stopped).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps one XCTest session across recording boundaries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-xctest-video-'));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, 'fixture');
    const events: string[] = [];
    const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
      bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      const output = await runUiPlan(config, { json: JSON.stringify({ version: 1, actions: [
        { launch: {} }, { startVideoRecording: { name: 'flow' } }, { tap: { label: 'Save' } },
        { stopVideoRecording: {} }, { assertVisible: { label: 'Saved' } },
      ] }) }, {
        backend: 'xctest',
        startRecording: async () => { events.push('start'); return { stop: async () => { events.push('stop'); } }; },
        run: async (executable, args) => {
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') {
            const runManifest = JSON.parse(await readFile(args[args.indexOf('-xctestrun') + 1], 'utf8'));
            const environment = runManifest.AgentRunner.EnvironmentVariables;
            const plan = JSON.parse(Buffer.from(environment.AGEMU_PLAN_BASE64, 'base64').toString());
            expect(plan.actions).toHaveLength(5);
            const url = `http://127.0.0.1:${environment.AGEMU_VIDEO_PORT}`;
            expect((await fetch(`${url}/start?name=flow`, { method: 'POST' })).status).toBe(200);
            events.push('tap');
            expect((await fetch(`${url}/stop`, { method: 'POST' })).status).toBe(200);
            return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 5, trees: [] })).toString('base64')}\n`);
          }
          return result();
        },
      });
      expect(events).toEqual(['start', 'tap', 'stop']);
      expect(output).toMatchObject({ backend: 'xctest', recordings: [expect.stringContaining('1-flow.mp4')] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('scrolls a target and holds a point through idb', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-gestures-'));
    const commands: string[][] = [];
    let scrolled = false;
    let menu = false;
    const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
      bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      const plan = { version: 1, actions: [
        { swipe: { identifier: 'results', direction: 'up', duration: 0.3 } },
        { assertVisible: { label: 'Next item' } },
        { longPress: { x: 42, y: 80, duration: 1.5 } },
        { assertVisible: { label: 'Context menu' } },
      ] };
      const output = await runUiPlan(config, { json: JSON.stringify(plan) }, { run: async (executable, args) => {
        commands.push([executable, ...args]);
        if (executable === 'xcodebuild') throw new Error('XCTest must not start');
        if (executable === 'idb' && args[1] === 'describe-all') return result(JSON.stringify([
          { AXUniqueId: 'results', frame: { x: 20, y: 100, width: 200, height: 400 } },
          ...(scrolled ? [{ AXLabel: 'Next item' }] : []),
          ...(menu ? [{ AXLabel: 'Context menu' }] : []),
        ]));
        if (executable === 'idb' && args[1] === 'swipe' && args[2] === '120' && args[3] === '420' && args[5] === '180') scrolled = true;
        if (executable === 'idb' && args[1] === 'tap' && args[2] === '42' && args[5] === '1.5') menu = true;
        return result();
      } });
      expect(output).toMatchObject({ backend: 'idb', runnerResult: { completed: 4 } });
      expect(commands).toContainEqual(['idb', 'ui', 'swipe', '120', '420', '120', '180', '--duration', '0.3', '--udid', 'PHONE']);
      expect(commands).toContainEqual(['idb', 'ui', 'tap', '42', '80', '--duration', '1.5', '--udid', 'PHONE']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses a working idb companion and matches exact labels before tapping', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-'));
    const commands: string[][] = [];
    let saved = false;
    let email = '';
    const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
      bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      const plan = { version: 1, actions: [
        { launch: {} }, { tap: { label: 'Save' } }, { type: { identifier: 'email', text: 'a@b.test' } },
        { wait: { label: 'Saved', timeout: 1 } }, { assertValue: { identifier: 'email', value: 'a@b.test' } },
        { wait: { duration: 0.1 } }, { screenshot: { name: 'done' } }, { inspect: {} },
      ] };
      const started = Date.now();
      const output = await runUiPlan(config, { json: JSON.stringify(plan) }, { run: async (executable, args) => {
        commands.push([executable, ...args]);
        if (executable === 'xcodebuild') throw new Error('XCTest must not start');
        if (executable === 'xcrun' && args[1] === 'terminate') return result('', 'not running', 3);
        if (executable === 'idb' && args[1] === 'describe-all') return result(JSON.stringify([
          { AXLabel: 'Save draft', frame: { x: 10, y: 10, width: 40, height: 40 } },
          { AXUniqueId: 'save-button', AXLabel: 'Save', frame: { x: 200, y: 10, width: 40, height: 40 } },
          { AXUniqueId: 'email', AXValue: email, frame: { x: 10, y: 100, width: 80, height: 40 } },
          ...(saved ? [{ AXLabel: 'Saved' }] : []),
        ]));
        if (executable === 'idb' && args[1] === 'tap' && args[2] === 'save-button') saved = true;
        if (executable === 'idb' && args[1] === 'text') email = args.at(-1) ?? '';
        if (executable === 'idb' && args[0] === 'screenshot') await writeFile(args[1], 'png');
        return result();
      } });
      expect(output).toMatchObject({ backend: 'idb', actions: 8, runnerResult: { completed: 8 }, screenshots: [expect.stringContaining('done.png')] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(90);
      expect(commands).toContainEqual(['idb', 'ui', 'tap', 'save-button', '--match-key', 'AXUniqueId', '--expected-key', 'AXLabel', '--expected-value', 'Save', '--api', 'axbridge', '--udid', 'PHONE']);
      expect(commands.some(command => command[0] === 'xcodebuild')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses the cached XCTest runner when idb cannot start', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-fallback-'));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, 'fixture');
    try {
      const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
        bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
      const output = await runUiPlan(config, { json: JSON.stringify({ version: 1, actions: [{ inspect: {} }] }) }, {
        run: async (executable, args) => {
          if (executable === 'idb') throw new Error('idb is not installed');
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 1, trees: [] })).toString('base64')}\n`);
          if (executable === 'xcodebuild') throw new Error('The cached runner must be reused');
          return result();
        },
      });
      expect(output).toMatchObject({ backend: 'xctest', runnerCached: true, runnerResult: { completed: 1 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
