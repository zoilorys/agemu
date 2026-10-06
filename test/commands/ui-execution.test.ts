import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runUiPlan, type UiDependencies } from '../../src/commands/ui.js';
import type { LoadedConfig } from '../../src/config/config.js';
import { readLaunchMarker, writeLaunchMarker } from '../../src/artifacts/launch-marker.js';
import { CliError } from '../../src/core/errors.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const result = (stdout = '', exitCode: number | null = 0): ProcessResult => ({ stdout, stderr: '', exitCode,
  signal: null, startedAt: new Date().toISOString(), durationMs: 1 });
const marker = (kind: string, payload: unknown) => `AGEMU_${kind}:${Buffer.from(JSON.stringify(payload)).toString('base64')}\n`;
const config = (root: string): LoadedConfig => ({ root, version: 2, platform: 'ios', simulator: { udid: 'PHONE' },
  app: { type: 'native', project: 'Fixture.xcodeproj', scheme: 'Fixture', configuration: 'Debug', bundleId: 'dev.fixture' } });
const withRoot = async (operation: (root: string) => Promise<void>) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-execution-'));
  try {
    const directory = path.join(root, '.agemu', 'RunnerDerivedData');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'Runner.xctestrun'), 'fixture');
    await operation(root);
  } finally { await rm(root, { recursive: true, force: true }); }
};
const source = (actions: unknown[]) => ({ json: JSON.stringify({ version: 1, actions }) });
const manifest = { AgentRunner: { TestBundlePath: 'Runner.xctest' } };
const tree = [{ type: 'Application', AXLabel: 'Fixture', frame: { x: 0, y: 0, width: 100, height: 100 } },
  { type: 'Button', AXLabel: 'Go', frame: { x: 20, y: 20, width: 20, height: 20 } }];
const node = { type: 'button', identifier: '', label: 'Go', value: '', x: 20, y: 20, width: 20, height: 20,
  enabled: true, selected: false, depth: 1 };
const runner = (stdout: string, exitCode = 0): NonNullable<UiDependencies['run']> => async (executable, args) => {
  if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
  if (executable === 'xcodebuild') return result(stdout, exitCode);
  return result();
};

// Every case previously looked like an exit-zero success, silently losing inspection evidence.
describe('XCTest result protocol', () => {
  const valid = { completed: 2, bundleId: 'dev.fixture', inspections: [{ index: 0, nodes: [node] }] };
  it.each([
    ['missing marker', 'test process exited successfully'],
    ['malformed base64', 'AGEMU_RESULT:!!'],
    ['truncated JSON', `AGEMU_RESULT:${Buffer.from('{"completed":2').toString('base64')}`],
    ['duplicate result', marker('RESULT', valid) + marker('RESULT', valid)],
    ['wrong app', marker('RESULT', { ...valid, bundleId: 'other.app' })],
    ['too few actions', marker('RESULT', { ...valid, completed: 1 })],
    ['too many actions', marker('RESULT', { ...valid, completed: 3 })],
    ['fractional count', marker('RESULT', { ...valid, completed: 1.5 })],
    ['absent inspections', marker('RESULT', { ...valid, inspections: undefined })],
    ['missing inspect result', marker('RESULT', { ...valid, inspections: [] })],
    ['non-inspect action index', marker('RESULT', { ...valid, inspections: [{ index: 1, nodes: [] }] })],
    ['duplicate inspect result', marker('RESULT', { ...valid, inspections: [{ index: 0, nodes: [] }, { index: 0, nodes: [] }] })],
    ['malformed geometry', marker('RESULT', { ...valid, inspections: [{ index: 0, nodes: [{ ...node, width: null }] }] })],
  ])('rejects %s with complete failure evidence', async (_case, stdout) => withRoot(async root => {
    const error = await runUiPlan(config(root), source([{ inspect: {} }, { screenshot: {} }]), {
      backend: 'xctest', run: runner(stdout),
    }).catch((caught: unknown) => caught) as CliError;
    expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', message: expect.stringContaining('Invalid XCTest runner result'),
      details: { failedAction: null, completed: 0, screenshots: [], recordings: [], inspections: [], transcript: expect.any(String) } });
  }));
});

describe('flat UI execution evidence', () => {
  it.each(['idb', 'xctest'] as const)('returns the same public fields with recording on %s', async backend => withRoot(async root => {
    const actions = [{ inspect: {} }, { startVideoRecording: { name: 'flow' } }, { screenshot: { name: 'inside' } },
      { stopVideoRecording: {} }, { screenshot: { name: 'outside' } }];
    const events: string[] = [];
    const output = await runUiPlan(config(root), source(actions), {
      backend,
      startRecording: async () => { events.push('start'); return { stop: async () => { events.push('stop'); } }; },
      run: async (executable, args) => {
        if (executable === 'idb' && args[1] === 'describe-all') return result(JSON.stringify(tree));
        if (executable === 'idb' && args[0] === 'screenshot') { await writeFile(args[1], 'png'); return result(); }
        if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
        if (executable === 'xcodebuild') {
          const runManifest = JSON.parse(await readFile(args[args.indexOf('-xctestrun') + 1], 'utf8'));
          const port = runManifest.AgentRunner.EnvironmentVariables.AGEMU_VIDEO_PORT;
          await fetch(`http://127.0.0.1:${port}/start?name=flow`, { method: 'POST' });
          await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST' });
          await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
          return result(marker('RESULT', { completed: 5, bundleId: 'dev.fixture', inspections: [{ index: 0, nodes: [node] }] }));
        }
        if (args[0] === 'xcresulttool') {
          const exported = args[args.indexOf('--output-path') + 1];
          await mkdir(exported, { recursive: true });
          await Promise.all(['A.png', 'B.png'].map(name => writeFile(path.join(exported, name), 'png')));
          await writeFile(path.join(exported, 'manifest.json'), JSON.stringify([{ attachments: [
            { exportedFileName: 'A.png', suggestedHumanReadableName: 'agemu-2-inside_X.png' },
            { exportedFileName: 'B.png', suggestedHumanReadableName: 'agemu-4-outside_X.png' },
          ] }]));
        }
        return result();
      },
    });
    expect(output).toMatchObject({ backend, bundleId: 'dev.fixture', actions: 5, completed: 5,
      transcript: expect.any(String), backendArtifacts: expect.any(Object) });
    expect(output.screenshots.map(file => path.basename(file))).toEqual(['2-inside.png', '4-outside.png']);
    expect(output.recordings.map(file => path.basename(file))).toEqual(['1-flow.mp4']);
    expect(output.inspections.map(entry => entry.index)).toEqual([0]);
    expect(output.runnerResult.inspections).toEqual(output.inspections);
    expect(output).not.toHaveProperty('segments');
    expect(events).toEqual(['start', 'stop']);
  }));

  it.each(['idb', 'xctest'] as const)('retains screenshots, videos and inspections before a later failure on %s', async backend => withRoot(async root => {
    let stops = 0;
    const actions = [{ inspect: {} }, { screenshot: { name: 'before' } }, { startVideoRecording: { name: 'first' } },
      { stopVideoRecording: {} }, { screenshot: { name: 'after' } }, { inspect: {} },
      { startVideoRecording: { name: 'second' } }, { assertExists: { label: 'Missing' } }, { stopVideoRecording: {} }];
    const failed = { index: 7, kind: 'assertExists', message: 'element does not exist: Missing' };
    const error = await runUiPlan(config(root), source(actions), {
      backend, startRecording: async () => ({ stop: async () => { stops += 1; } }),
      run: async (executable, args) => {
        if (executable === 'idb' && args[1] === 'describe-all') return result(JSON.stringify(tree));
        if (executable === 'idb' && args[0] === 'screenshot') { await writeFile(args[1], 'png'); return result(); }
        if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
        if (executable === 'xcodebuild') {
          const runManifest = JSON.parse(await readFile(args[args.indexOf('-xctestrun') + 1], 'utf8'));
          const origin = `http://127.0.0.1:${runManifest.AgentRunner.EnvironmentVariables.AGEMU_VIDEO_PORT}`;
          await fetch(`${origin}/start?name=first`, { method: 'POST' });
          await fetch(`${origin}/stop`, { method: 'POST' });
          await fetch(`${origin}/start?name=second`, { method: 'POST' });
          await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
          return result(marker('INSPECTION', { index: 0, nodes: [node] }) + marker('INSPECTION', { index: 5, nodes: [node] }) +
            'AGEMU_ACTION:7\n' + marker('FAILURE', failed), 65);
        }
        if (args[0] === 'xcresulttool') {
          const directory = args[args.indexOf('--output-path') + 1];
          await mkdir(directory, { recursive: true });
          await Promise.all(['A.png', 'B.png'].map(name => writeFile(path.join(directory, name), 'png')));
          await writeFile(path.join(directory, 'manifest.json'), JSON.stringify([{ attachments: [
            { exportedFileName: 'A.png', suggestedHumanReadableName: 'agemu-1-before_X.png' },
            { exportedFileName: 'B.png', suggestedHumanReadableName: 'agemu-4-after_X.png' },
          ] }]));
        }
        return result();
      },
    }).catch((caught: unknown) => caught) as CliError;
    expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { failedAction: failed, completed: 7 } });
    const details = error.details!;
    expect((details.screenshots as string[]).map(file => path.basename(file))).toEqual(['1-before.png', '4-after.png']);
    expect((details.recordings as string[]).map(file => path.basename(file))).toEqual(['1-first.mp4', '2-second.mp4']);
    expect((details.inspections as { index: number }[]).map(entry => entry.index)).toEqual([0, 5]);
    expect(stops).toBe(2);
  }));

  it('cleans a pending bridge recording after an early runner failure without replacing that failure', async () => withRoot(async root => {
    let stopped = 0;
    let begin!: () => void;
    const began = new Promise<void>(resolve => { begin = resolve; });
    const error = await runUiPlan(config(root), source([{ startVideoRecording: {} }, { stopVideoRecording: {} }]), {
      backend: 'xctest', timeoutMs: 80,
      startRecording: async () => { begin(); await new Promise(resolve => setTimeout(resolve, 140)); return { stop: async () => { stopped += 1; } }; },
      run: async (executable, args) => {
        if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
        if (executable === 'xcodebuild') {
          const value = JSON.parse(await readFile(args[args.indexOf('-xctestrun') + 1], 'utf8'));
          fetch(`http://127.0.0.1:${value.AgentRunner.EnvironmentVariables.AGEMU_VIDEO_PORT}/start?name=flow`, { method: 'POST' }).catch(() => undefined);
          await began;
          return result('AGEMU_ACTION:0\n', 65);
        }
        return result();
      },
    }).catch((caught: unknown) => caught) as CliError;
    expect(error).toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { failedAction: { index: 0, kind: 'startVideoRecording' } } });
    await new Promise(resolve => setTimeout(resolve, 170));
    expect(stopped).toBe(1);
  }));

  it('redacts encoded marker evidence without changing protocol comparisons', async () => withRoot(async root => {
    const secretNode = { ...node, label: 'secret token' };
    const inspected = await runUiPlan({ ...config(root), redactions: ['secret', 'dev.fixture'] }, source([{ inspect: {} }]), {
      backend: 'xctest', run: runner(marker('INSPECTION', { index: 0, nodes: [secretNode] }) +
        marker('RESULT', { completed: 1, bundleId: 'dev.fixture', inspections: [{ index: 0, nodes: [secretNode] }] })),
    });
    expect(inspected.inspections[0].elements[0].label).toBe('[REDACTED] token');
    const text = await readFile(path.join(root, inspected.transcript), 'utf8');
    const payloads = [...text.matchAll(/AGEMU_(?:RESULT|INSPECTION):([A-Za-z0-9+/=]+)/g)]
      .map(match => Buffer.from(match[1], 'base64').toString('utf8'));
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) { expect(payload).not.toContain('secret'); expect(payload).not.toContain('dev.fixture'); }
  }));
});


describe('one UI command deadline', () => {
  it('fails when screenshot export reaches the command deadline and retains completed inspections', async () => withRoot(async root => {
    const actions = [{ inspect: {} }, { screenshot: {} }];
    let exportTimeout = 0;
    const start = Date.now();
    const error = await runUiPlan(config(root), source(actions), {
      backend: 'xctest', timeoutMs: 180,
      run: async (executable, args, options) => {
        if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
        if (executable === 'xcodebuild') {
          await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
          await new Promise(resolve => setTimeout(resolve, 45));
          return result('AGEMU_ACTION:0\nAGEMU_ACTION:1\n' + marker('RESULT', { completed: 2, bundleId: 'dev.fixture', inspections: [{ index: 0, nodes: [node] }] }));
        }
        if (args[0] === 'xcresulttool') {
          exportTimeout = options!.timeoutMs!;
          await new Promise(resolve => setTimeout(resolve, exportTimeout));
          throw new CliError('PROCESS_TIMEOUT', 'export timed out');
        }
        return result();
      },
    }).catch((caught: unknown) => caught) as CliError;
    expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', details: { failedAction: null, completed: 2, screenshots: [], recordings: [], inspections: [{ index: 0 }] } });
    expect(exportTimeout).toBeGreaterThan(0);
    expect(exportTimeout).toBeLessThan(180);
    expect(Date.now() - start).toBeLessThan(700);
  }));

  it('bounds Expo server preflight and never launches after it expires', async () => withRoot(async root => {
    let launches = 0;
    const expo: LoadedConfig = { ...config(root), app: { type: 'expo', root, port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.expo' } };
    const start = Date.now();
    const error = await runUiPlan(expo, source([{ launch: {} }]), {
      timeoutMs: 40,
      serverStatus: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { running: true }; },
      resolveExpoUrl: async () => 'exp://127.0.0.1:8081',
      run: async () => { launches += 1; return result('[]'); },
    }).catch((caught: unknown) => caught) as CliError;
    expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', details: { completed: 0, screenshots: [], recordings: [], inspections: [] } });
    expect(Date.now() - start).toBeLessThan(180);
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(launches).toBe(0);
  }));

  it('stops an injected recording that starts after the deadline', async () => withRoot(async root => {
    let stopped = 0;
    const error = await runUiPlan(config(root), source([{ startVideoRecording: {} }, { stopVideoRecording: {} }]), {
      backend: 'idb', timeoutMs: 25, run: async () => result('[]'),
      startRecording: async () => { await new Promise(resolve => setTimeout(resolve, 70)); return { stop: async () => { stopped += 1; } }; },
    }).catch((caught: unknown) => caught) as CliError;
    expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT', details: { failedAction: { index: 0, kind: 'startVideoRecording' }, completed: 0, recordings: [] } });
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(stopped).toBe(1);
  }));
});


describe('Expo plan launches', () => {
  it.each([
    ['idb', 'expo-go'], ['xctest', 'expo-go'], ['idb', 'development-build'], ['xctest', 'development-build'],
  ] as const)('opens the configured %s/%s project without changing action indexes', async (backend, launchTarget) => withRoot(async root => {
    const app: LoadedConfig['app'] = launchTarget === 'expo-go'
      ? { type: 'expo', root, port: 8081, launchTarget, hostBundleId: 'host.expo' }
      : { type: 'expo', root, port: 8081, launchTarget, bundleId: 'dev.expo' };
    const bundleId = launchTarget === 'expo-go' ? 'host.expo' : 'dev.expo';
    const url = launchTarget === 'expo-go' ? 'exp://127.0.0.1:8081' : 'exp+fixture://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081';
    const calls: string[][] = [];
    let submitted: { actions: { launch?: { projectUrl?: string } }[] } | undefined;
    const output = await runUiPlan({ ...config(root), app }, source([{ launch: { arguments: ['--testing'] } }, { inspect: {} }, { launch: {} }]), {
      backend, serverStatus: async () => ({ running: true }), resolveExpoUrl: async () => url,
      run: async (executable, args) => {
        calls.push([executable, ...args]);
        if (executable === 'idb') return result(JSON.stringify(tree));
        if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
        if (executable === 'xcodebuild') {
          const value = JSON.parse(await readFile(args[args.indexOf('-xctestrun') + 1], 'utf8'));
          submitted = JSON.parse(Buffer.from(value.AgentRunner.EnvironmentVariables.AGEMU_PLAN_BASE64, 'base64').toString());
          return result(marker('RESULT', { completed: 3, bundleId, inspections: [{ index: 1, nodes: [node] }] }));
        }
        return result();
      },
    });
    expect(output).toMatchObject({ backend, bundleId, completed: 3, actions: 3 });
    expect(output.inspections.map(entry => entry.index)).toEqual([1]);
    if (backend === 'idb') {
      expect(calls.filter(call => call[2] === 'launch' || call[2] === 'terminate' || call[2] === 'openurl')).toEqual([
        ['xcrun', 'simctl', 'terminate', 'PHONE', bundleId], ['xcrun', 'simctl', 'launch', 'PHONE', bundleId, '--testing'],
        ['xcrun', 'simctl', 'openurl', 'PHONE', url], ['xcrun', 'simctl', 'terminate', 'PHONE', bundleId],
        ['xcrun', 'simctl', 'launch', 'PHONE', bundleId], ['xcrun', 'simctl', 'openurl', 'PHONE', url],
      ]);
    } else {
      expect(submitted!.actions).toHaveLength(3);
      expect(submitted!.actions[0].launch!.projectUrl).toBe(url);
      expect(submitted!.actions[2].launch!.projectUrl).toBe(url);
    }
  }));
});


describe('reached XCTest launch evidence', () => {
  it('preserves the previous marker when an earlier action fails before a later launch', async () => withRoot(async root => {
    const previous = { at: '2026-10-05T10:00:00.000Z', udid: 'PHONE', bundleId: 'dev.fixture', source: 'app launch' };
    await writeLaunchMarker(root, previous);
    const error = await runUiPlan(config(root), source([{ assertExists: { label: 'Missing' } }, { launch: {} }]), {
      backend: 'xctest', run: runner('AGEMU_ACTION:0\n' + marker('FAILURE', { index: 0, kind: 'assertExists', message: 'missing' }), 65),
    }).catch((caught: unknown) => caught) as CliError;
    expect(error.code).toBe('UI_DELIVERY_FAILED');
    expect(await readLaunchMarker(root)).toEqual(previous);
  }));

  it('retains reached-launch telemetry when a process returns after its deadline', async () => withRoot(async root => {
    const at = '2026-10-05T12:00:00.444Z';
    const error = await runUiPlan(config(root), source([{ launch: {} }]), {
      backend: 'xctest', timeoutMs: 35,
      run: async (executable, args) => {
        if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
        if (executable === 'xcodebuild') {
          await new Promise(resolve => setTimeout(resolve, 55));
          return result(marker('LAUNCH', { index: 0, at }) + 'AGEMU_ACTION:0\n');
        }
        return result();
      },
    }).catch((caught: unknown) => caught) as CliError;
    expect(error.code).toBe('PROCESS_TIMEOUT');
    expect(await readLaunchMarker(root)).toMatchObject({ at, source: 'ui run' });
  }));

  it.each(['success', 'failure', 'timeout'] as const)('records the latest actual repeated launch on %s', async outcome => withRoot(async root => {
    const actions = [{ launch: {} }, { wait: { duration: 0 } }, { launch: {} }, { tap: { label: 'Missing' } }];
    const stdout = marker('LAUNCH', { index: 0, at: '2026-10-05T12:00:00.100Z' }) +
      marker('LAUNCH', { index: 2, at: '2026-10-05T12:00:02.987Z' }) + 'AGEMU_ACTION:3\n';
    const value = await runUiPlan(config(root), source(actions), {
      backend: 'xctest', run: async (executable, args) => {
        if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify(manifest));
        if (executable === 'xcodebuild') {
          if (outcome === 'timeout') throw new CliError('PROCESS_TIMEOUT', 'execution deadline', { result: result(stdout, null) });
          if (outcome === 'failure') return result(stdout + marker('FAILURE', { index: 3, kind: 'tap', message: 'missing' }), 65);
          return result(stdout + marker('RESULT', { completed: 4, bundleId: 'dev.fixture', inspections: [] }));
        }
        return result();
      },
    }).catch((caught: unknown) => caught);
    if (outcome === 'timeout') expect(value).toMatchObject({ code: 'PROCESS_TIMEOUT' });
    if (outcome === 'failure') expect(value).toMatchObject({ code: 'UI_DELIVERY_FAILED' });
    if (outcome === 'success') expect(value).toMatchObject({ completed: 4 });
    expect(await readLaunchMarker(root)).toEqual({ at: '2026-10-05T12:00:02.987Z', udid: 'PHONE', bundleId: 'dev.fixture', source: 'ui run' });
  }));
});
