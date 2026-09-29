import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUiRunner, injectEnvironment, runUiPlan } from '../../src/commands/ui.js';
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

  const secretConfig = (root: string) => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const,
    project: path.join(root, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.secret-app.x' },
  simulator: { udid: 'PHONE' }, root, redactions: ['secret-app'] });

  it('redacts configured secrets from idb runner results and trees', async () => {
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
      expect(json).toContain('Welcome to [REDACTED]');
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
            const payload = { completed: 1, bundleId: 'com.secret-app.x', trees: ['Application com.secret-app.x'] };
            return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify(payload)).toString('base64')}\n`);
          }
          return result();
        },
      });
      const json = JSON.stringify(output);
      expect(json).not.toContain('secret-app');
      expect(output.runnerResult).toEqual({ completed: 1, bundleId: 'com.[REDACTED].x', trees: ['Application com.[REDACTED].x'] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a failed runner build with redacted stderr capped to its last 4000 characters', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-build-redact-'));
    const stderr = `${'x'.repeat(5_000)}\nerror: cannot sign secret-app`;
    try {
      const failure = await buildUiRunner(secretConfig(root), {
        run: async (executable) => executable === 'xcodebuild' ? result('', stderr, 65) : result(),
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { exitCode: 65 } });
      const captured = (failure as { details: { stderr: string } }).details.stderr;
      expect(captured).toHaveLength(4_000);
      expect(captured.endsWith('error: cannot sign [REDACTED]')).toBe(true);
      expect(captured).not.toContain('secret-app');
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
        return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 4, trees: [] })).toString('base64')}\n`);
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
    ['tap without target', { tap: {} }, 'Action 1: tap needs exactly one string identifier or label'],
    ['tap with target and coordinates', { tap: { label: 'Go', x: 1, y: 2 } }, 'Action 1: tap needs one string identifier or label, or finite x and y, not both'],
    ['assertVisible with both targets', { assertVisible: { identifier: 'a', label: 'b' } }, 'Action 1: assertVisible needs exactly one string identifier or label'],
    ['type without text', { type: { identifier: 'email' } }, 'Action 1: type needs string text'],
    ['assertValue without value', { assertValue: { identifier: 'email' } }, 'Action 1: assertValue needs string value'],
    ['unknown field', { assertExists: { label: 'Go', timeout: 2 } }, 'Action 1: assertExists does not accept timeout'],
    ['non-empty inspect', { inspect: { depth: 1 } }, 'Action 1: inspect does not accept depth'],
    ['bad env name', { launch: { environment: { 'BAD-NAME': 'x' } } }, 'Action 1: launch environment must map valid variable names to strings'],
    ['non-string argument', { launch: { arguments: [1] } }, 'Action 1: launch arguments must be an array of strings'],
    ['non-string screenshot name', { screenshot: { name: 3 } }, 'Action 1: screenshot name must be a string'],
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
          if (executable === 'xcodebuild' && args[0] === 'test-without-building') return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 1, trees: [] })).toString('base64')}\n`);
          if (executable === 'xcodebuild') throw new Error('The cached runner must be reused');
          return result();
        },
      });
      expect(output).toMatchObject({ backend: 'xctest', runnerCached: true, runnerResult: { completed: 1 } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
