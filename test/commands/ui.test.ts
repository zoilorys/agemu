import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLaunchMarker } from '../../src/artifacts/launch-marker.js';
import { buildUiRunner, injectEnvironment, inspectScreen, runUiPlan } from '../../src/commands/ui.js';
import { CliError } from '../../src/core/errors.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const result = (stdout = '', stderr = '', exitCode: number | null = 0): ProcessResult => ({
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

describe('ui inspect', () => {
  const inspectConfig = (root: string) => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const,
    project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root });
  const tree = JSON.stringify([
    { type: 'Application', AXLabel: 'App', frame: { x: 0, y: 0, width: 400, height: 800 } },
    { type: 'Button', AXUniqueId: 'saveButton', AXLabel: 'Save', frame: { x: 10, y: 10, width: 80, height: 40 } },
    { type: 'StaticText', AXLabel: 'Item 24', frame: { x: 0, y: 1600, width: 400, height: 44 } },
  ]);
  const recordingRun = (calls: string[][]) => async (executable: string, args: string[]) => {
    calls.push([executable, ...args]);
    if (executable === 'idb' && args[1] === 'describe-all') return result(tree);
    if (args.includes('launchctl')) return result(running);
    return result();
  };
  const running = '81859\t0\tUIKitApplication:com.example.app[0afb][rb-legacy]\n';

  it('returns only on-screen elements by default and all elements with all, with counts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    try {
      const visible = await inspectScreen(inspectConfig(root), { backend: 'idb' }, { run: recordingRun([]) });
      expect(visible.elements.map(element => element.label)).toEqual(['App', 'Save']);
      expect(visible.counts).toEqual({ total: 3, visible: 2 });
      expect(visible.screenshot).toMatch(/screenshots\/1-inspect\.png$/);
      expect(visible).toMatchObject({ udid: 'PHONE', bundleId: 'com.example.app', backend: 'idb' });

      const all = await inspectScreen(inspectConfig(root), { backend: 'idb', all: true }, { run: recordingRun([]) });
      expect(all.elements.find(element => element.label === 'Item 24')).toMatchObject({ visible: false });
      expect(all.counts).toEqual({ total: 3, visible: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never launches, terminates, or taps the app', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    const calls: string[][] = [];
    try {
      await inspectScreen(inspectConfig(root), { backend: 'idb', all: true }, { run: recordingRun(calls) });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.slice(0, 3)).not.toEqual(['xcrun', 'simctl', 'launch']);
        expect(call.slice(0, 3)).not.toEqual(['xcrun', 'simctl', 'terminate']);
        expect(call[0] === 'idb' && call[1] === 'ui' && ['tap', 'swipe', 'text'].includes(call[2]!)).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['only SpringBoard runs', '81000\t0\tUIKitApplication:com.apple.springboard[0afb][rb-legacy]\n'],
    ['only an app with a longer id runs', '81859\t0\tUIKitApplication:com.example.app2[0afb][rb-legacy]\n'],
  ])('reports the app as not running when %s', async (_case, listing) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    try {
      await expect(inspectScreen(inspectConfig(root), { backend: 'idb' }, {
        run: async (executable, args) => {
          if (executable === 'idb' && args[1] === 'describe-all') return result(tree);
          return args.includes('launchctl') ? result(listing) : result();
        },
      })).rejects.toMatchObject({ code: 'UI_DELIVERY_FAILED', message: expect.stringContaining('Launch the app first') });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses to report the foreground app on idb when the configured app is not running', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    const calls: string[][] = [];
    try {
      const error = await inspectScreen(inspectConfig(root), { backend: 'idb' }, {
        run: async (executable, args) => {
          calls.push([executable, ...args]);
          // SpringBoard is in the foreground: idb works, but the app is absent from launchctl.
          if (executable === 'idb' && args[1] === 'describe-all') return result(tree);
          if (args.includes('launchctl')) return result('81000\t0\tUIKitApplication:com.apple.springboard[0afb][rb-legacy]\n');
          return result();
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { failedAction: { index: 0, kind: 'inspect' } } });
      expect((error as CliError).message).toMatch(/Launch the app first/);
      expect(calls.some(call => call[0] === 'idb' || call.includes('launch'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const appinfo = (name?: string) => `{\n    CFBundleIdentifier = "com.example.app";\n${name ? `    CFBundleDisplayName = ${name};\n` : ''}}\n`;
  const foregroundRun = (calls: string[][], foreground: string, info: string) => async (executable: string, args: string[]) => {
    calls.push([executable, ...args]);
    if (executable === 'idb' && args[1] === 'describe-all') {
      return result(JSON.stringify([{ type: 'Application', AXLabel: foreground, frame: { x: 0, y: 0, width: 400, height: 800 } }]));
    }
    if (args.includes('launchctl')) return result(running);
    if (args[1] === 'appinfo') return result(info);
    return result();
  };

  it('fails on idb when the running app is backgrounded and another app is in the foreground', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    const calls: string[][] = [];
    try {
      const error = await inspectScreen(inspectConfig(root), { backend: 'idb' }, { run: foregroundRun(calls, 'SpringBoard', appinfo('App')) })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { failedAction: {
        index: 0, kind: 'inspect', message: 'com.example.app is not in the foreground (foreground: SpringBoard)' } } });
      expect((error as CliError).message).toMatch(/agemu app launch/);
      expect(calls.some(call => call[2] === 'launch' || call[2] === 'terminate')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['the foreground app has the display name', 'App', appinfo('App')],
    ['the display name is unknown', 'SpringBoard', appinfo()],
  ])('inspects on idb when %s', async (_case, foreground, info) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    try {
      const inspected = await inspectScreen(inspectConfig(root), { backend: 'idb' }, { run: foregroundRun([], foreground, info) });
      expect(inspected.elements.map(element => element.label)).toEqual([foreground]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the app running when an XCTest inspect times out', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, 'fixture');
    const calls: string[][] = [];
    try {
      const error = await inspectScreen(inspectConfig(root), { backend: 'xctest', timeoutMs: 60_000 }, {
        runnerProject: path.join(root, 'missing.xcodeproj'),
        run: async (executable, args) => {
          calls.push([executable, ...args]);
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'AgentRunner.xctest' } }));
          if (executable === 'xcodebuild') throw new CliError('PROCESS_TIMEOUT', 'timed out', { result: { stdout: '', stderr: '' } });
          return result();
        },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT' });
      expect(calls.some(call => call[1] === 'simctl' && call[2] === 'terminate' && call.includes('com.example.app'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('passes through a screenshot export error', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-inspect-'));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, 'fixture');
    const calls: string[][] = [];
    try {
      const inspected = await inspectScreen(inspectConfig(root), { backend: 'xctest' }, {
        runnerProject: path.join(root, 'missing.xcodeproj'),
        run: async (executable, args) => {
          calls.push([executable, ...args]);
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'AgentRunner.xctest' } }));
          if (executable === 'xcodebuild') {
            await mkdir(args[args.indexOf('-resultBundlePath') + 1]!, { recursive: true });
            const encoded = Buffer.from(JSON.stringify({ completed: 2, inspections: [{ index: 0, nodes: [] }] })).toString('base64');
            return result(`AGEMU_RESULT:${encoded}\n`);
          }
          if (executable === 'xcrun' && args[0] === 'xcresulttool') return result('', 'export broke', 1);
          return result();
        },
      });
      expect(inspected.screenshotExportError).toBe('export broke');
      expect(inspected.screenshot).toBeUndefined();
      // XCTest inspection is scoped to the app, so no foreground check runs.
      expect(calls.some(call => call.includes('appinfo'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('UI plan launch marker', () => {
  const markerConfig = (root: string) => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'),
    scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root });
  const idbRun = (onLaunch: () => Promise<void>) => async (executable: string, args: string[]) => {
    if (executable === 'idb' && args[1] === 'describe-all') return result('[]');
    if (executable === 'xcrun' && args[1] === 'launch') await onLaunch();
    return result();
  };

  it('records each idb launch when it executes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-marker-'));
    const seen: Array<Awaited<ReturnType<typeof readLaunchMarker>>> = [];
    const launchCalls: number[] = [];
    try {
      await runUiPlan(markerConfig(root), { json: JSON.stringify({ version: 1, actions: [{ launch: {} }, { wait: { duration: 0.05 } }, { launch: {} }] }) }, {
        backend: 'idb',
        run: idbRun(async () => { launchCalls.push(Date.now()); seen.push(await readLaunchMarker(root)); }),
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ udid: 'PHONE', bundleId: 'com.example.app', source: 'ui run' });
      // The second launch starts a new window instead of keeping the first launch's time.
      expect(Date.parse(seen[1]!.at)).toBeGreaterThan(launchCalls[0]!);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('records nothing for a plan without a launch action', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-marker-'));
    try {
      await runUiPlan(markerConfig(root), { json: JSON.stringify({ version: 1, actions: [{ tap: { x: 1, y: 2 } }] }) }, {
        backend: 'idb', run: idbRun(async () => undefined),
      });
      expect(await readLaunchMarker(root)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the previous window when the plan fails before any launch runs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-marker-'));
    const previous = { at: '2026-09-30T10:00:00.000Z', udid: 'PHONE', bundleId: 'com.example.app', source: 'app launch' };
    try {
      await mkdir(path.join(root, '.agemu'), { recursive: true });
      await writeFile(path.join(root, '.agemu', 'launch.json'), JSON.stringify(previous));
      await expect(runUiPlan(markerConfig(root), { json: JSON.stringify({ version: 1, actions: [{ launch: {} }] }) }, {
        backend: 'xctest', run: async () => { throw new Error('runner build failed'); },
      })).rejects.toThrow();
      expect(await readLaunchMarker(root)).toEqual(previous);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('records an XCTest launch plan just before the runner executes it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-marker-'));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    let atRun: Awaited<ReturnType<typeof readLaunchMarker>>;
    try {
      await mkdir(path.dirname(manifest), { recursive: true });
      await writeFile(manifest, 'fixture');
      await runUiPlan(markerConfig(root), { json: JSON.stringify({ version: 1, actions: [{ launch: {} }] }) }, {
        backend: 'xctest',
        run: async (executable, args) => {
          if (executable === 'plutil' && args[1] === 'json') {
            expect(await readLaunchMarker(root)).toBeUndefined();
            return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
          }
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') atRun = await readLaunchMarker(root);
          return result();
        },
      }).catch(() => undefined);
      expect(atRun!).toMatchObject({ udid: 'PHONE', bundleId: 'com.example.app', source: 'ui run' });
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
            return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 5, inspections: [] })).toString('base64')}\n`);
          }
          return result();
        },
      });
      expect(events).toEqual(['start', 'tap', 'stop']);
      expect(output).toMatchObject({ backend: 'xctest', recordings: [expect.stringContaining('1-flow.mp4')] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps concurrent UI plans with identical timestamps in separate run directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-runs-'));
    const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
      bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    const start = () => runUiPlan(config, { json: JSON.stringify({ version: 1, actions: [{ inspect: {} }] }) }, {
      backend: 'idb', now: () => new Date('2026-09-25T12:00:00.000Z'),
      run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result('[]') : result(),
    });
    try {
      const [first, second] = await Promise.all([start(), start()]);
      expect(first.run).not.toBe(second.run);
      for (const output of [first, second]) {
        expect(output.run.startsWith('.agemu/runs/2026-09-25T12-00-00.000Z-')).toBe(true);
        await expect(readFile(path.join(root, (output as { transcript: string }).transcript), 'utf8')).resolves.toBeTypeOf('string');
      }
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
          ...(scrolled ? [{ AXLabel: 'Next item', frame: { x: 20, y: 120, width: 200, height: 40 } }] : []),
          ...(menu ? [{ AXLabel: 'Context menu', frame: { x: 40, y: 90, width: 120, height: 60 } }] : []),
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

  it('taps a non-unique idb target at its frame center and a unique one through accessibility', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-fallback-tap-'));
    const commands: string[][] = [];
    const config = { version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug',
      bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, root };
    try {
      const output = await runUiPlan(config, { json: JSON.stringify({ version: 1, actions: [
        { tap: { identifier: 'row', index: 1 } }, { tap: { labelContains: 'Save', index: 1 } },
      ] }) }, { backend: 'idb', run: async (executable, args) => {
        commands.push([executable, ...args]);
        if (executable === 'idb' && args[1] === 'describe-all') return result(JSON.stringify([
          // Neither the id nor the label is unique, so only a coordinate tap reaches the second row.
          { AXUniqueId: 'row', AXLabel: 'Item', frame: { x: 0, y: 100, width: 300, height: 40 } },
          { AXUniqueId: 'row', AXLabel: 'Item', frame: { x: 0, y: 140, width: 300, height: 40 } },
          { AXUniqueId: 'saveButton', AXLabel: 'Save', frame: { x: 10, y: 10, width: 40, height: 40 } },
          { AXUniqueId: 'draftButton', AXLabel: 'Save draft', frame: { x: 60, y: 10, width: 40, height: 40 } },
        ]));
        return result();
      } });
      const taps = commands.filter(command => command[0] === 'idb' && command[2] === 'tap');
      expect(taps).toEqual([
        ['idb', 'ui', 'tap', '150', '160', '--udid', 'PHONE'],
        ['idb', 'ui', 'tap', 'draftButton', '--match-key', 'AXUniqueId', '--expected-key', 'AXUniqueId', '--expected-value', 'draftButton',
          '--api', 'axbridge', '--udid', 'PHONE'],
      ]);
      const transcript = await readFile(path.join(root, (output as { transcript: string }).transcript), 'utf8');
      expect(transcript).toContain('coordinate fallback: row (index 1) at 150,160');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('presses an id-less element with a unique label through accessibility', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-label-tap-'));
    const commands: string[][] = [];
    try {
      await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ tap: { label: 'Save' } }] }) }, {
        backend: 'idb',
        run: async (executable, args) => {
          commands.push([executable, ...args]);
          return executable === 'idb' && args[1] === 'describe-all' ? result(JSON.stringify([
            { AXLabel: 'Save draft', frame: { x: 60, y: 10, width: 40, height: 40 } },
            { AXLabel: 'Save', frame: { x: 10, y: 10, width: 40, height: 40 } },
          ])) : result();
        },
      });
      expect(commands.filter(command => command[0] === 'idb' && command[2] === 'tap')).toEqual([
        ['idb', 'ui', 'tap', 'Save', '--match-key', 'AXLabel', '--expected-key', 'AXLabel', '--expected-value', 'Save', '--api', 'axbridge', '--udid', 'PHONE'],
      ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails an idb action whose index is beyond the matches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-index-'));
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ tap: { labelContains: 'Save', index: 1 } }] }) }, {
        backend: 'idb',
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all'
          ? result(JSON.stringify([{ AXUniqueId: 'saveButton', AXLabel: 'Save', frame: { x: 10, y: 10, width: 40, height: 40 } }])) : result(),
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { failedAction: { index: 0, kind: 'tap', message: 'element not found: Save (index 1)' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const secretConfig = (root: string) => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const,
    project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.secret-app.x' },
  simulator: { udid: 'PHONE' }, root, redactions: ['secret-app'] });

  it('redacts configured secrets from idb runner results and inspections', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-redact-'));
    try {
      const output = await runUiPlan(secretConfig(root), { json: JSON.stringify({ version: 1, actions: [{ inspect: {} }] }) }, {
        backend: 'idb',
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all'
          ? result(JSON.stringify([{ AXLabel: 'Welcome to secret-app' }])) : result(),
      });
      const json = JSON.stringify(output);
      expect(json).not.toContain('secret-app');
      expect(json).toContain('com.[REDACTED].x');
      expect(output.runnerResult).toMatchObject({ inspections: [{ index: 0, elements: [{ label: 'Welcome to [REDACTED]' }] }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports an idb inspection after a recording boundary by its submitted plan index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-inspect-offset-'));
    try {
      const output = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { inspect: {} }, { startVideoRecording: {} }, { tap: { x: 1, y: 2 } }, { inspect: {} }, { stopVideoRecording: {} },
      ] }) }, {
        backend: 'idb',
        startRecording: async () => ({ stop: async () => undefined }),
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all'
          ? result(JSON.stringify([{ type: 'Button', AXLabel: 'Go', frame: { x: 0, y: 0, width: 10, height: 10 } }])) : result(),
      }) as { segments: Array<{ runnerResult: { inspections: Array<{ index: number }> } }> };
      expect(output.segments.map(segment => segment.runnerResult.inspections.map(inspection => inspection.index))).toEqual([[0], [3]]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('redacts configured secrets from the decoded XCTest runner result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-xctest-redact-'));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, 'fixture');
    try {
      const output = await runUiPlan(secretConfig(root), { json: JSON.stringify({ version: 1, actions: [{ inspect: {} }] }) }, {
        backend: 'xctest',
        run: async (executable, args) => {
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') {
            const payload = { completed: 1, bundleId: 'com.secret-app.x', inspections: [{ index: 0, nodes: [{
              type: 'application', identifier: '', label: 'Application com.secret-app.x', value: '',
              x: 0, y: 0, width: 390, height: 844, enabled: true, selected: false, depth: 0,
            }] }] };
            return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify(payload)).toString('base64')}\n`);
          }
          return result();
        },
      });
      const json = JSON.stringify(output);
      expect(json).not.toContain('secret-app');
      expect(output.runnerResult).toEqual({ completed: 1, bundleId: 'com.[REDACTED].x', inspections: [{ index: 0, elements: [{
        type: 'application', label: 'Application com.[REDACTED].x', frame: { x: 0, y: 0, width: 390, height: 844 },
        visible: true, enabled: true, selected: false, depth: 0,
      }] }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a failed runner build as BUILD_FAILED with a plain-text log and redacted parsed errors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-redact-'));
    const stderr = `${'x'.repeat(5_000)}\nerror: cannot sign secret-app`;
    try {
      const failure = await buildUiRunner(secretConfig(root), {
        now: () => new Date('2026-09-25T12:00:00.000Z'),
        run: async (executable) => executable === 'xcodebuild' ? result('Build started\n', stderr, 65) : result(),
      }).catch((error: unknown) => error) as CliError;
      expect(failure).toMatchObject({ code: 'BUILD_FAILED', message: 'Unable to build the XCTest UI runner', details: {
        exitCode: 65, errors: [{ message: 'cannot sign [REDACTED]' }],
      } });
      expect(failure.details).not.toHaveProperty('stderr');
      const log = failure.details?.log as string;
      expect(log).toMatch(/^\.agemu\/runs\/2026-09-25T12-00-00\.000Z-.*\/runner-build\.log$/);
      const text = await readFile(path.join(root, log), 'utf8');
      expect(text.startsWith('Build started\n--- stderr ---\n')).toBe(true);
      expect(text).toContain('error: cannot sign [REDACTED]');
      expect(text).not.toContain('secret-app');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const cachedRunnerRoot = async (prefix: string) => {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    const manifest = path.join(root, '.agemu', 'RunnerDerivedData', 'Build', 'Runner.xctestrun');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, 'fixture');
    return root;
  };
  const nativeConfig = (root: string) => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const,
    project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
  simulator: { udid: 'PHONE' }, root });
  const failingXctest = (stdout: string) => async (executable: string, args: string[]) => {
    if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
    if (executable === 'xcodebuild' && args[0] === 'test-without-building') return result(stdout, '', 65);
    return result();
  };

  it('reports the failing XCTest action from the runner failure marker', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-failure-');
    const failure = Buffer.from(JSON.stringify({ index: 1, kind: 'wait', message: 'element did not appear: missing' })).toString('base64');
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { launch: {} }, { wait: { identifier: 'missing', timeout: 1 } }, { longPress: { identifier: 'pressTarget' } },
      ] }) }, { backend: 'xctest', run: failingXctest(`AGEMU_ACTION:0\nAGEMU_ACTION:1\nAGEMU_FAILURE:${failure}\n`) }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', message: 'UI action 1 (wait) failed: element did not appear: missing',
        details: { exitCode: 65, failedAction: { index: 1, kind: 'wait', message: 'element did not appear: missing' }, completed: 1 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('falls back to XCTest internal failure text for the last started action', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-internal-');
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { launch: {} }, { inspect: {} }, { tap: { identifier: 'x' } }, { inspect: {} },
      ] }) }, { backend: 'xctest', run: failingXctest([
        'AGEMU_ACTION:0', 'Test Case started AGEMU_ACTION:1', 'AGEMU_ACTION:2', 'AGEMU_FAILURE:!!not-base64!!',
        '/tmp/AgentRunner.swift:120: error: -[AgentRunner.AgentRunner testPlan] : Failed to tap "x"',
      ].join('\n')) }).catch((e: unknown) => e);
      expect(error).toMatchObject({ message: 'UI action 2 (tap) failed: Failed to tap "x"',
        details: { failedAction: { index: 2, kind: 'tap', message: 'Failed to tap "x"' }, completed: 2 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('omits failedAction when XCTest fails before any action starts', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-crash-');
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ inspect: {} }] }) },
        { backend: 'xctest', run: failingXctest('Testing failed: runner crashed\n') }).catch((e: unknown) => e) as { message: string; details: Record<string, unknown> };
      expect(error.message).toBe('The XCTest UI plan failed');
      expect(error.details.failedAction).toBeUndefined();
      expect(error.details.completed).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('maps an idb segment failure to its index in the submitted plan', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-offset-'));
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { startVideoRecording: {} }, { tap: { x: 1, y: 2 } }, { stopVideoRecording: {} },
        { startVideoRecording: {} }, { assertVisible: { identifier: 'missing' } }, { stopVideoRecording: {} },
      ] }) }, {
        backend: 'idb',
        startRecording: async () => ({ stop: async () => undefined }),
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result('[]') : result(),
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', message: 'UI action 4 (assertVisible) failed: element is not visible: missing',
        details: { failedAction: { index: 4, kind: 'assertVisible' }, completed: 4 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports a failing idb recording boundary by its own plan index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-record-fail-'));
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { tap: { x: 1, y: 2 } }, { startVideoRecording: {} }, { tap: { x: 3, y: 4 } }, { stopVideoRecording: {} },
      ] }) }, {
        backend: 'idb',
        startRecording: async () => { throw new Error('recorder busy'); },
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result('[]') : result(),
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ details: { failedAction: { index: 1, kind: 'startVideoRecording', message: 'recorder busy' }, completed: 1 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('stops an idb plan at the first failed action', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-failfast-'));
    const commands: string[][] = [];
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { assertVisible: { identifier: 'missing' } }, { tap: { x: 10, y: 20 } },
      ] }) }, {
        backend: 'idb',
        run: async (executable, args) => {
          commands.push([executable, ...args]);
          return executable === 'idb' && args[1] === 'describe-all' ? result('[]') : result();
        },
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ details: { failedAction: { index: 0, kind: 'assertVisible' }, completed: 0 } });
      expect(commands.some(command => command[0] === 'idb' && command[2] === 'tap')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('cuts an idb wait at the plan deadline and reports PROCESS_TIMEOUT', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-deadline-'));
    const started = Date.now();
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ wait: { duration: 5 } }, { tap: { x: 1, y: 2 } }] }) }, {
        backend: 'idb', timeoutMs: 200,
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result('[]') : result(),
      }).catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', message: 'UI plan exceeded 0.2 s', details: { failedAction: { index: 0, kind: 'wait' }, completed: 0 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('terminates the runner and app after an XCTest timeout and reports the last started action', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-timeout-');
    const commands: string[][] = [];
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { launch: {} }, { inspect: {} }, { tap: { label: 'Go' } }, { wait: { duration: 60 } },
      ] }) }, {
        backend: 'xctest', timeoutMs: 5_000,
        run: async (executable, args, options) => {
          commands.push([executable, ...args]);
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') {
            expect(options?.timeoutMs).toBeGreaterThan(0);
            expect(options?.timeoutMs).toBeLessThanOrEqual(5_000);
            throw new CliError('PROCESS_TIMEOUT', 'Process timed out', { result: result('AGEMU_ACTION:0\nAGEMU_ACTION:3\n', 'partial err', null) });
          }
          return result();
        },
      }).catch((e: unknown) => e) as CliError;
      expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', message: 'UI plan exceeded 5 s',
        details: { lastStartedAction: 3, resultBundle: expect.stringContaining('AgentRunner.xcresult') } });
      expect(commands).toContainEqual(['xcrun', 'simctl', 'terminate', 'PHONE', 'dev.agemu.agemu-agent-runner.xctrunner']);
      expect(commands).toContainEqual(['xcrun', 'simctl', 'terminate', 'PHONE', 'com.example.app']);
      expect(commands.some(command => command[1] === 'xcresulttool')).toBe(false);
      await expect(readFile(path.join(root, error.details?.transcript as string), 'utf8')).resolves.toContain('AGEMU_ACTION:3');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports a runner build timeout inside ui run against the plan deadline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-runner-timeout-'));
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ inspect: {} }] }) }, {
        backend: 'xctest', timeoutMs: 3_000,
        run: async (executable, args) => {
          if (executable === 'xcodebuild' && args.includes('build-for-testing')) throw new CliError('PROCESS_TIMEOUT', 'Process timed out');
          return result();
        },
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', message: 'UI plan exceeded 3 s' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const passingXctestWithBundle =(exportAttachments: (output: string) => Promise<ReturnType<typeof result>>) =>
    async (executable: string, args: string[]) => {
      if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
      if (executable === 'xcodebuild' && args[0] === 'test-without-building') {
        await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
        return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 4, inspections: [] })).toString('base64')}\n`);
      }
      if (executable === 'xcrun' && args[0] === 'xcresulttool') return exportAttachments(args[args.indexOf('--output-path') + 1]);
      return result();
    };
  const screenshotPlan = JSON.stringify({ version: 1, actions: [{ launch: {} }, { inspect: {} }, { tap: { label: 'Go' } }, { screenshot: { name: 'done' } }] });

  it('exports only AgentRunner screenshot attachments under the idb file naming', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-shots-');
    try {
      const output = await runUiPlan(nativeConfig(root), { json: screenshotPlan }, {
        backend: 'xctest',
        run: passingXctestWithBundle(async (directory) => {
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, 'A1.png'), 'png-bytes');
          await writeFile(path.join(directory, 'B2.txt'), 'log');
          await writeFile(path.join(directory, 'manifest.json'), JSON.stringify([{ testIdentifier: 'AgentRunner/testPlan()', attachments: [
            { exportedFileName: 'A1.png', suggestedHumanReadableName: 'agemu-3-done_0_ABC.png', isAssociatedWithFailure: false },
            { exportedFileName: 'B2.txt', suggestedHumanReadableName: 'Debug description_0_DEF.txt', isAssociatedWithFailure: false },
          ] }]));
          return result();
        }),
      }) as { run: string; screenshots: string[] };
      expect(output.screenshots).toEqual([`${output.run}/screenshots/3-done.png`]);
      expect(output).not.toHaveProperty('screenshotExportError');
      await expect(readFile(path.join(root, output.run, 'screenshots', '3-done.png'), 'utf8')).resolves.toBe('png-bytes');
      await expect(stat(path.join(root, output.run, 'attachments'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps a passing XCTest plan ok when screenshot export fails', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-export-fail-');
    try {
      const output = await runUiPlan(secretConfig(root), { json: screenshotPlan }, {
        backend: 'xctest',
        run: passingXctestWithBundle(async () => result('', 'error: cannot open secret-app bundle', 1)),
      });
      expect(output).toMatchObject({ backend: 'xctest', runnerResult: { completed: 4 }, screenshots: [],
        screenshotExportError: 'error: cannot open [REDACTED] bundle' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('treats an export without a manifest as a run with no attachments', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-no-manifest-');
    try {
      const output = await runUiPlan(nativeConfig(root), { json: screenshotPlan }, {
        backend: 'xctest',
        run: passingXctestWithBundle(async (directory) => { await mkdir(directory, { recursive: true }); return result(); }),
      });
      expect(output).toMatchObject({ backend: 'xctest', screenshots: [] });
      expect(output).not.toHaveProperty('screenshotExportError');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns the exported failure screenshot for a failing XCTest plan', async () => {
    const root = await cachedRunnerRoot('agemu-xctest-failure-shot-');
    const failure = Buffer.from(JSON.stringify({ index: 1, kind: 'tap', message: 'missing' })).toString('base64');
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ launch: {} }, { tap: { label: 'Go' } }] }) }, {
        backend: 'xctest',
        run: async (executable, args) => {
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') {
            await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
            return result(`AGEMU_ACTION:1\nAGEMU_FAILURE:${failure}\n`, '', 65);
          }
          if (executable === 'xcrun' && args[0] === 'xcresulttool') {
            const directory = args[args.indexOf('--output-path') + 1];
            await mkdir(directory, { recursive: true });
            await writeFile(path.join(directory, 'F.png'), 'failure-png');
            await writeFile(path.join(directory, 'manifest.json'), JSON.stringify([{ attachments: [
              { exportedFileName: 'F.png', suggestedHumanReadableName: 'agemu-failure_0_XYZ.png', isAssociatedWithFailure: false },
            ] }]));
          }
          return result();
        },
      }).catch((e: unknown) => e) as { details: { failureScreenshot: string; screenshots: string[] } };
      expect(error.details.screenshots).toEqual([]);
      await expect(readFile(path.join(root, error.details.failureScreenshot), 'utf8')).resolves.toBe('failure-png');
      expect(path.basename(error.details.failureScreenshot)).toBe('failure.png');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('captures a failure screenshot when an idb action fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-failure-shot-'));
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ screenshot: { name: 'before' } }, { assertVisible: { identifier: 'missing' } }] }) }, {
        backend: 'idb',
        run: async (executable, args) => {
          if (executable === 'idb' && args[1] === 'describe-all') return result('[]');
          if (executable === 'idb' && args[0] === 'screenshot') await writeFile(args[1], 'png');
          return result();
        },
      }).catch((e: unknown) => e) as { details: { failureScreenshot: string; screenshots: string[] } };
      expect(error.details.screenshots.map(file => path.basename(file))).toEqual(['0-before.png']);
      expect(error.details.failureScreenshot).toMatch(/screenshots\/failure\.png$/);
      await expect(readFile(path.join(root, error.details.failureScreenshot), 'utf8')).resolves.toBe('png');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['unknown kind', { tapp: {} }, 'Action 1: unknown action tapp'],
    ['two kinds', { tap: { label: 'Go' }, inspect: {} }, 'Action 1: must contain exactly one action'],
    ['non-object action', 'tap', 'Action 1: must contain exactly one action'],
    ['tap without target', { tap: {} }, 'Action 1: tap needs a string identifier, label, or labelContains'],
    ['tap with target and coordinates', { tap: { label: 'Go', x: 1, y: 2 } }, 'Action 1: tap needs a target or finite x and y, not both'],
    ['tap with index and coordinates', { tap: { index: 0, x: 1, y: 2 } }, 'Action 1: tap needs a target or finite x and y, not both'],
    ['assertVisible with both targets', { assertVisible: { identifier: 'a', label: 'b' } }, 'Action 1: assertVisible accepts identifier or label, not both'],
    ['type alone', { tap: { type: 'button' } }, 'Action 1: tap needs a string identifier, label, or labelContains'],
    ['type alone on wait', { wait: { type: 'button', timeout: 1 } }, 'Action 1: wait needs a string identifier, label, or labelContains'],
    ['negative index', { assertExists: { identifier: 'row', index: -1 } }, 'Action 1: assertExists index must be a non-negative integer'],
    ['fractional index', { assertExists: { identifier: 'row', index: 1.5 } }, 'Action 1: assertExists index must be a non-negative integer'],
    ['negative index on a swipe target', { swipe: { direction: 'up', identifier: 'list', index: -1 } }, 'Action 1: swipe index must be a non-negative integer'],
    ['non-string labelContains', { longPress: { labelContains: 3 } }, 'Action 1: longPress labelContains must be a string'],
    ['unknown type', { assertExists: { label: 'Go', type: 'widget' } }, expect.stringMatching(/^Action 1: assertExists type must be one of .*button/)],
    ['application type', { assertExists: { label: 'Go', type: 'application' } }, expect.stringMatching(/^Action 1: assertExists type must be one of/)],
    ['empty labelContains', { assertExists: { labelContains: '' } }, 'Action 1: assertExists labelContains must not be empty'],
    ['unsafe index', { assertExists: { identifier: 'row', index: 1e300 } }, 'Action 1: assertExists index must be a non-negative integer'],
    ['the catch-all other type', { assertExists: { label: 'Go', type: 'other' } }, expect.stringMatching(/^Action 1: assertExists type must be one of/)],
    ['type without text', { type: { identifier: 'email' } }, 'Action 1: type needs string text'],
    ['assertValue without value', { assertValue: { identifier: 'email' } }, 'Action 1: assertValue needs string value'],
    ['unknown field', { assertExists: { label: 'Go', timeout: 2 } }, 'Action 1: assertExists does not accept timeout'],
    ['non-empty inspect', { inspect: { depth: 1 } }, 'Action 1: inspect does not accept depth'],
    ['bad env name', { launch: { environment: { 'BAD-NAME': 'x' } } }, 'Action 1: launch environment must map valid variable names to strings'],
    ['non-string argument', { launch: { arguments: [1] } }, 'Action 1: launch arguments must be an array of strings'],
    ['non-string screenshot name', { screenshot: { name: 3 } }, 'Action 1: screenshot name must be a string'],
    ['unknown key', { pressKey: { key: 'escape' } }, 'Action 1: pressKey key must be one of return, delete, tab, space'],
    ['missing key', { pressKey: {} }, 'Action 1: pressKey key must be one of return, delete, tab, space'],
    ['zero key count', { pressKey: { key: 'delete', count: 0 } }, 'Action 1: pressKey count must be an integer from 1 to 100'],
    ['key count above 100', { pressKey: { key: 'delete', count: 101 } }, 'Action 1: pressKey count must be an integer from 1 to 100'],
    ['fractional key count', { pressKey: { key: 'delete', count: 1.5 } }, 'Action 1: pressKey count must be an integer from 1 to 100'],
    ['unknown button', { pressButton: { button: 'lock' } }, 'Action 1: pressButton button must be one of home'],
    ['clear without target', { clear: {} }, 'Action 1: clear needs a string identifier, label, or labelContains'],
    ['openUrl without url', { openUrl: {} }, 'Action 1: openUrl needs a valid url string'],
    ['unparsable url', { openUrl: { url: 'not a url' } }, 'Action 1: openUrl needs a valid url string'],
    ['non-boolean confirm', { openUrl: { url: 'app://x', confirm: 'yes' } }, 'Action 1: openUrl confirm must be a boolean'],
    ['terminate with fields', { terminate: { bundleId: 'other.app' } }, 'Action 1: terminate does not accept bundleId'],
    ['assertText with two modes', { assertText: { label: 'A', equals: 'x', contains: 'x' } }, 'Action 1: assertText needs exactly one string equals, contains, or matches'],
    ['assertText with no mode', { assertText: { label: 'A' } }, 'Action 1: assertText needs exactly one string equals, contains, or matches'],
    ['assertText with a non-string mode', { assertText: { label: 'A', equals: 3 } }, 'Action 1: assertText needs exactly one string equals, contains, or matches'],
    ['assertText with a bad regex', { assertText: { label: 'A', matches: '(' } }, 'Action 1: assertText matches must be a valid regular expression'],
    ['assertText without target', { assertText: { equals: 'x' } }, 'Action 1: assertText needs a string identifier, label, or labelContains'],
    ['scrollUntilVisible without target', { scrollUntilVisible: {} }, 'Action 1: scrollUntilVisible target must be an object'],
    ['scrollUntilVisible with zero maxSwipes', { scrollUntilVisible: { target: { label: 'A' }, maxSwipes: 0 } },
      'Action 1: scrollUntilVisible maxSwipes must be an integer from 1 to 50'],
    ['scrollUntilVisible with 51 maxSwipes', { scrollUntilVisible: { target: { label: 'A' }, maxSwipes: 51 } },
      'Action 1: scrollUntilVisible maxSwipes must be an integer from 1 to 50'],
    ['scrollUntilVisible with a bad direction', { scrollUntilVisible: { target: { label: 'A' }, direction: 'sideways' } },
      'Action 1: scrollUntilVisible direction must be one of up, down, left, right'],
    ['scrollUntilVisible with a bad nested target', { scrollUntilVisible: { target: { identifier: 'a', label: 'b' } } },
      'Action 1: scrollUntilVisible target accepts identifier or label, not both'],
    ['scrollUntilVisible with a bad container', { scrollUntilVisible: { target: { label: 'A' }, in: { type: 'table' } } },
      'Action 1: scrollUntilVisible in needs a string identifier, label, or labelContains'],
    ['scrollUntilVisible with an unknown nested field', { scrollUntilVisible: { target: { label: 'A', timeout: 1 } } },
      'Action 1: scrollUntilVisible target does not accept timeout'],
  ])('rejects a plan with %s before any process runs', async (_name, action, message) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-validate-'));
    const commands: string[] = [];
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [{ inspect: {} }, action] }) }, {
        run: async (executable) => { commands.push(executable); return result('[]'); },
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'UI_VALIDATION_FAILED', message });
      expect(commands).toEqual([]);
      await expect(stat(path.join(root, '.agemu'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const runIdbKeys = async (actions: unknown[], value?: string) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-keys-'));
    const commands: string[][] = [];
    try {
      const output = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions }) }, {
        backend: 'idb',
        run: async (executable, args) => {
          commands.push([executable, ...args]);
          return executable === 'idb' && args[1] === 'describe-all' ? result(JSON.stringify([
            { AXUniqueId: 'nameField', ...(value === undefined ? {} : { AXValue: value }), frame: { x: 10, y: 100, width: 200, height: 40 } },
          ])) : result();
        },
      });
      return { output, inputs: commands.filter(command => command[0] === 'idb' && command[1] === 'ui' && command[2] !== 'describe-all') };
    } finally { await rm(root, { recursive: true, force: true }); }
  };
  const tapNameField = ['idb', 'ui', 'tap', 'nameField', '--match-key', 'AXUniqueId', '--expected-key', 'AXUniqueId', '--expected-value', 'nameField',
    '--api', 'axbridge', '--udid', 'PHONE'];
  const deleteKey = ['idb', 'ui', 'key', '42', '--udid', 'PHONE'];

  it('clears an idb field by tapping it and deleting each character of its value', async () => {
    const { output, inputs } = await runIdbKeys([{ clear: { identifier: 'nameField' } }], 'abc');
    expect(output).toMatchObject({ backend: 'idb', runnerResult: { completed: 1 } });
    expect(inputs).toEqual([tapNameField, deleteKey, deleteKey, deleteKey]);
  });

  it.each([['an empty value', ''], ['no value', undefined]])('clears an idb field with %s without keystrokes', async (_case, value) => {
    expect((await runIdbKeys([{ clear: { identifier: 'nameField' } }], value)).inputs).toEqual([tapNameField]);
  });

  it('presses keys and the Home button through idb', async () => {
    const { inputs } = await runIdbKeys([{ pressKey: { key: 'return' } }, { pressKey: { key: 'space', count: 2 } }, { pressButton: { button: 'home' } }]);
    expect(inputs).toEqual([
      ['idb', 'ui', 'key', '40', '--udid', 'PHONE'],
      ['idb', 'ui', 'key', '44', '--udid', 'PHONE'],
      ['idb', 'ui', 'key', '44', '--udid', 'PHONE'],
      ['idb', 'ui', 'button', 'HOME', '--udid', 'PHONE'],
    ]);
  });

  const existingOpen = { type: 'Button', AXLabel: 'Open', frame: { x: 10, y: 10, width: 60, height: 40 } };
  const promptOpen = { type: 'Button', AXLabel: 'Open', frame: { x: 200, y: 400, width: 120, height: 44 } };
  const openText = { type: 'StaticText', AXLabel: 'Open', frame: { x: 0, y: 600, width: 100, height: 20 } };
  const promptTitle = (app: string) => ({ type: 'StaticText', AXLabel: `Open in “${app}”?`, frame: { x: 60, y: 340, width: 270, height: 22 } });
  const promptCancel = { type: 'Button', AXLabel: 'Cancel', frame: { x: 70, y: 400, width: 120, height: 44 } };
  /** Runs an idb plan whose tree is `before` until `simctl openurl` succeeds, then `before` plus `after`. */
  const runIdbOpenUrl = async (actions: unknown[], options: { before?: object[]; after?: object[]; terminateStderr?: string; openurlStderr?: string;
    appName?: string } = {}) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-openurl-'));
    const commands: string[][] = [];
    let prompted = false;
    try {
      const output = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions }) }, {
        backend: 'idb',
        run: async (executable, args) => {
          commands.push([executable, ...args]);
          if (executable === 'idb' && args[1] === 'describe-all') {
            return result(JSON.stringify([...(options.before ?? []), ...(prompted ? options.after ?? [] : [])]));
          }
          if (executable === 'xcrun' && args[1] === 'openurl') {
            if (options.openurlStderr) return result('', options.openurlStderr, 1);
            prompted = true;
          }
          if (executable === 'xcrun' && args[1] === 'terminate' && options.terminateStderr) return result('', options.terminateStderr, 3);
          if (executable === 'xcrun' && args[1] === 'appinfo' && options.appName) return result(`{\n    CFBundleDisplayName = "${options.appName}";\n}\n`);
          return result();
        },
      }).catch((e: unknown) => e);
      const transcript = await readFile(path.join(root, (output as { transcript?: string; details?: { transcript?: string } }).transcript
        ?? (output as { details: { transcript: string } }).details.transcript), 'utf8');
      return { output, commands, transcript, taps: commands.filter(command => command[0] === 'idb' && command[2] === 'tap') };
    } finally { await rm(root, { recursive: true, force: true }); }
  };

  it('opens a URL and terminates the app through simctl, tolerating an app that is not running', async () => {
    const { output, commands } = await runIdbOpenUrl([{ openUrl: { url: 'agemufixture://deep/link' } }, { terminate: {} }],
      { terminateStderr: 'found nothing to terminate' });
    expect(output).toMatchObject({ backend: 'idb', runnerResult: { completed: 2 } });
    expect(commands).toContainEqual(['xcrun', 'simctl', 'openurl', 'PHONE', 'agemufixture://deep/link']);
    expect(commands).toContainEqual(['xcrun', 'simctl', 'terminate', 'PHONE', 'com.example.app']);
  });

  it('fails openUrl with the simctl error when no app handles the URL', async () => {
    const { output } = await runIdbOpenUrl([{ openUrl: { url: 'nohandler://x' } }], { openurlStderr: 'no application registered for nohandler' });
    expect(output).toMatchObject({ code: 'UI_DELIVERY_FAILED',
      details: { failedAction: { index: 0, kind: 'openUrl', message: 'no application registered for nohandler' } } });
  });

  it('fails terminate when simctl reports another error', async () => {
    const { output } = await runIdbOpenUrl([{ terminate: {} }], { terminateStderr: 'device is not booted' });
    expect(output).toMatchObject({ details: { failedAction: { index: 0, kind: 'terminate', message: 'device is not booted' } } });
  });

  it('presses a newly appeared Open prompt after openUrl with confirm: true', async () => {
    const { output, taps, transcript } = await runIdbOpenUrl([{ openUrl: { url: 'agemufixture://deep/link', confirm: true } }],
      { after: [promptTitle('Fixture'), promptCancel, promptOpen], appName: 'Fixture' });
    expect(output).toMatchObject({ runnerResult: { completed: 1 } });
    expect(taps).toEqual([['idb', 'ui', 'tap', 'Open', '--match-key', 'AXLabel', '--expected-key', 'AXLabel', '--expected-value', 'Open',
      '--api', 'axbridge', '--udid', 'PHONE']]);
    expect(transcript).toContain('openUrl confirmation: pressed Open');
  });

  it('presses only the new Open button, never a new "Open" text or the one already on screen', async () => {
    // Duplicate labels force a tap at the new button's center (260,422).
    const { taps } = await runIdbOpenUrl([{ openUrl: { url: 'agemufixture://deep/link', confirm: true } }],
      { before: [existingOpen], after: [openText, promptTitle('Fixture'), promptCancel, promptOpen] });
    expect(taps).toEqual([['idb', 'ui', 'tap', '260', '422', '--udid', 'PHONE']]);
  });

  it.each([
    ['a new app Open button without the prompt title or Cancel', [promptOpen], undefined],
    ['a prompt naming a different app', [promptTitle('Other'), promptCancel, promptOpen], 'Fixture'],
  ])('does not press %s', async (_case, after, appName) => {
    const { output, taps, transcript } = await runIdbOpenUrl([{ openUrl: { url: 'agemufixture://deep/link', confirm: true } }], { after, appName });
    expect(output).toMatchObject({ runnerResult: { completed: 1 } });
    expect(taps).toEqual([]);
    expect(transcript).toContain('openUrl confirmation: no Open prompt appeared');
  });

  it('makes no tree reads or taps for openUrl without confirm', async () => {
    const { commands } = await runIdbOpenUrl([{ openUrl: { url: 'agemufixture://deep/link' } }]);
    // Only the backend probe reads the tree.
    expect(commands.filter(command => command[0] === 'idb' && command[2] === 'describe-all')).toHaveLength(1);
    expect(commands.filter(command => command[0] === 'idb' && command[2] === 'tap')).toEqual([]);
  });

  it('does not press an Open button that was on screen before openUrl', async () => {
    const { output, taps, transcript } = await runIdbOpenUrl([{ openUrl: { url: 'agemufixture://deep/link', confirm: true } }], { before: [existingOpen], after: [openText] });
    expect(output).toMatchObject({ runnerResult: { completed: 1 } });
    expect(taps).toEqual([]);
    expect(transcript).toContain('openUrl confirmation: no Open prompt appeared');
  });

  const offscreenTree = JSON.stringify([
    { type: 'Application', AXLabel: 'Fixture', frame: { x: 0, y: 0, width: 390, height: 844 } },
    { type: 'StaticText', AXLabel: 'Item 1', frame: { x: 0, y: 100, width: 390, height: 44 } },
    { type: 'StaticText', AXLabel: 'Item 24', frame: { x: 0, y: 1440, width: 390, height: 44 } },
    { type: 'Group', AXLabel: 'Hidden', frame: { x: 0, y: 100, width: 0, height: 0 } },
  ]);
  const runIdbAssertion = (root: string, action: Record<string, unknown>) => runUiPlan(nativeConfig(root),
    { json: JSON.stringify({ version: 1, actions: [action] }) }, {
      backend: 'idb',
      run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result(offscreenTree) : result(),
    });

  it('applies screen-visibility semantics to idb assertions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-visibility-'));
    try {
      await expect(runIdbAssertion(root, { assertVisible: { label: 'Item 24' } })).rejects.toMatchObject({
        code: 'UI_DELIVERY_FAILED', details: { failedAction: { index: 0, kind: 'assertVisible', message: 'element is not visible: Item 24 (exists but not hittable)' } },
      });
      await expect(runIdbAssertion(root, { assertVisible: { label: 'Hidden' } })).rejects.toMatchObject({ code: 'UI_DELIVERY_FAILED' });
      await expect(runIdbAssertion(root, { assertExists: { label: 'Item 24' } })).resolves.toMatchObject({ backend: 'idb', runnerResult: { completed: 1 } });
      await expect(runIdbAssertion(root, { assertNotVisible: { label: 'Item 24' } })).resolves.toMatchObject({ backend: 'idb', runnerResult: { completed: 1 } });
      await expect(runIdbAssertion(root, { assertNotVisible: { label: 'Missing' } })).resolves.toMatchObject({ backend: 'idb' });
      await expect(runIdbAssertion(root, { assertVisible: { label: 'Item 1' } })).resolves.toMatchObject({ backend: 'idb' });
      await expect(runIdbAssertion(root, { assertNotVisible: { label: 'Item 1' } })).rejects.toMatchObject({
        details: { failedAction: { kind: 'assertNotVisible', message: 'element is visible: Item 1' } },
      });
      await expect(runIdbAssertion(root, { assertExists: { label: 'Missing' } })).rejects.toMatchObject({
        details: { failedAction: { kind: 'assertExists', message: 'element does not exist: Missing' } },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  /** Runs an idb plan over a list whose `Item 24` scrolls on screen after `visibleAfter` swipes (never when undefined). */
  const runIdbScroll = async (actions: unknown[], visibleAfter?: number) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-scroll-'));
    const swipes: string[][] = [];
    try {
      const output = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions }) }, {
        backend: 'idb',
        run: async (executable, args) => {
          if (executable === 'idb' && args[1] === 'swipe') swipes.push([executable, ...args]);
          if (executable === 'idb' && args[1] === 'describe-all') {
            const shown = visibleAfter !== undefined && swipes.length >= visibleAfter;
            return result(JSON.stringify([
              { type: 'Application', AXLabel: 'Fixture', frame: { x: 0, y: 0, width: 390, height: 844 } },
              { type: 'Table', AXUniqueId: 'resultsList', frame: { x: 0, y: 100, width: 390, height: 600 } },
              { type: 'StaticText', AXLabel: 'Item 24', frame: { x: 0, y: shown ? 400 : 1440, width: 390, height: 44 } },
            ]));
          }
          return result();
        },
      }).catch((e: unknown) => e);
      return { output, swipes };
    } finally { await rm(root, { recursive: true, force: true }); }
  };

  it('swipes the idb container until the target is visible, then stops', async () => {
    const { output, swipes } = await runIdbScroll([{ scrollUntilVisible: { target: { label: 'Item 24' }, in: { identifier: 'resultsList' } } }], 2);
    expect(output).toMatchObject({ backend: 'idb', runnerResult: { completed: 1 } });
    // Finger moves up across the list's center: 30% of its height each way.
    expect(swipes).toEqual([
      ['idb', 'ui', 'swipe', '195', '580', '195', '220', '--udid', 'PHONE'],
      ['idb', 'ui', 'swipe', '195', '580', '195', '220', '--udid', 'PHONE'],
    ]);
  });

  it('does not swipe when the idb target is already visible', async () => {
    const { output, swipes } = await runIdbScroll([{ scrollUntilVisible: { target: { label: 'Item 24' } } }], 0);
    expect(output).toMatchObject({ runnerResult: { completed: 1 } });
    expect(swipes).toEqual([]);
  });

  it('swipes the idb app frame in the given direction when no container is given', async () => {
    const { swipes } = await runIdbScroll([{ scrollUntilVisible: { target: { label: 'Item 24' }, direction: 'down' } }], 1);
    expect(swipes).toEqual([['idb', 'ui', 'swipe', '195', '169', '195', '675', '--udid', 'PHONE']]);
  });

  it('fails after exactly maxSwipes idb swipes when the target never appears', async () => {
    const { output, swipes } = await runIdbScroll([{ scrollUntilVisible: { target: { label: 'Item 24' }, maxSwipes: 3 } }]);
    expect(swipes).toHaveLength(3);
    expect(output).toMatchObject({ code: 'UI_DELIVERY_FAILED',
      details: { failedAction: { index: 0, kind: 'scrollUntilVisible', message: 'target not visible after 3 swipes: Item 24' } } });
  });

  it('names a missing idb container without swiping', async () => {
    const { output, swipes } = await runIdbScroll([{ scrollUntilVisible: { target: { label: 'Item 24' }, in: { identifier: 'missingList' } } }]);
    expect(swipes).toEqual([]);
    expect(output).toMatchObject({ details: { failedAction: { message: 'container not found: missingList' } } });
  });

  it('stops idb scrolling at the plan deadline', async () => {
    const started = Date.now();
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-scroll-deadline-'));
    try {
      const error = await runUiPlan(nativeConfig(root), { json: JSON.stringify({ version: 1, actions: [
        { scrollUntilVisible: { target: { label: 'Item 24' }, maxSwipes: 50 } }] }) }, {
        backend: 'idb', timeoutMs: 500,
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result(offscreenTree) : result(),
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', details: { failedAction: { kind: 'scrollUntilVisible' } } });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const textTree = JSON.stringify([
    { AXUniqueId: 'status', AXLabel: 'Status', AXValue: 'Swiped left', frame: { x: 0, y: 0, width: 100, height: 20 } },
    { AXUniqueId: 'title', AXLabel: 'Item 24', AXValue: '', frame: { x: 0, y: 30, width: 100, height: 20 } },
  ]);
  const runIdbText = (root: string, assertion: Record<string, unknown>) => runUiPlan(nativeConfig(root),
    { json: JSON.stringify({ version: 1, actions: [{ assertText: assertion }] }) }, {
      backend: 'idb',
      run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result(textTree) : result(),
    });

  it.each([
    ['equals on the value', { identifier: 'status', equals: 'Swiped left' }],
    ['contains on the value', { identifier: 'status', contains: 'left' }],
    ['matches searched in the value', { identifier: 'status', matches: 'ped\\s+l' }],
    ['equals on the label when the value is empty', { identifier: 'title', equals: 'Item 24' }],
    ['matches anchored on the label', { identifier: 'title', matches: '^Item \\d+$' }],
  ])('passes idb assertText with %s', async (_case, assertion) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-text-'));
    try {
      await expect(runIdbText(root, assertion)).resolves.toMatchObject({ runnerResult: { completed: 1 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['equals the label while a value exists', { identifier: 'status', equals: 'Status' }, 'text does not match: expected equals Status, got Swiped left'],
    ['contains a missing fragment', { identifier: 'status', contains: 'right' }, 'text does not match: expected contains right, got Swiped left'],
    ['matches a non-matching pattern', { identifier: 'title', matches: '^Item \\d$' }, 'text does not match: expected matches ^Item \\d$, got Item 24'],
    ['a missing element', { identifier: 'nothing', equals: 'x' }, 'element not found: nothing'],
  ])('fails idb assertText that %s', async (_case, assertion, message) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-idb-text-'));
    try {
      await expect(runIdbText(root, assertion)).rejects.toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { failedAction: { kind: 'assertText', message } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('runs the README plan example without a validation error', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-readme-plan-'));
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('## Run a UI plan'));
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(block).toBeDefined();
    const frame = { x: 10, y: 100, width: 200, height: 40 };
    try {
      const output = await runUiPlan(nativeConfig(root), { json: block! }, {
        backend: 'idb',
        startRecording: async () => ({ stop: async () => undefined }),
        run: async (executable, args) => executable === 'idb' && args[1] === 'describe-all' ? result(JSON.stringify([
          { AXUniqueId: 'email', frame }, { AXUniqueId: 'resultsList', frame }, { AXLabel: 'More options', frame },
          { AXUniqueId: 'save', frame }, { AXLabel: 'Saved', frame },
        ])) : result(),
      });
      expect(output).toMatchObject({ actions: 11, recordings: [expect.stringContaining('save-flow.mp4')] });
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
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 1, inspections: [] })).toString('base64')}\n`);
          if (executable === 'xcodebuild') throw new Error('The cached runner must be reused');
          return result();
        },
      });
      expect(output).toMatchObject({ backend: 'xctest', runnerCached: true, runnerResult: { completed: 1 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
