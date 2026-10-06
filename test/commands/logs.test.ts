import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeLaunchMarker } from '../../src/artifacts/launch-marker.js';
import { showLogs, streamLogs } from '../../src/commands/diagnostics.js';
import { captureJsLogs } from '../../src/commands/js-logs.js';
import type { AppState } from '../../src/commands/build.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { Device } from '../../src/native/simctl.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const device: Device = { udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true };
const config = (root: string): LoadedConfig => ({ version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root });
const state: AppState = { appPath: '/products/MyApp.app', bundleId: 'com.example.app', executableName: 'RealExecutable', udid: 'PHONE', configuration: 'Debug', updatedAt: '' };

describe('logs show command', () => {
  it('refuses to query a stopped simulator with a redacted prerequisite error', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-stopped-'));
    let called = false;
    try {
      await expect(showLogs(config(root), {}, {
        resolveDevice: async () => ({ ...device, name: 'secret-value phone', state: 'Shutdown' }), readState: async () => state,
        runner: async () => { called = true; return { stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
      })).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED', message: 'Simulator [REDACTED] phone (PHONE) is not booted; run agemu simulator boot', details: { udid: 'PHONE', state: 'Shutdown' } });
      expect(called).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains log success, its artifact and the primary error when events cannot be written', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-event-failure-'));
    const dependencies = { resolveDevice: async () => device, readState: async () => state };
    try {
      await mkdir(path.join(root, '.agemu/events.jsonl'), { recursive: true });
      const result = await showLogs(config(root), {}, { ...dependencies, runner: async () => ({ stdout: 'captured secret-value', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }) });
      expect(result.logs).toEqual(['captured [REDACTED]']);
      expect(await readFile(path.join(root, result.artifact), 'utf8')).toBe('captured [REDACTED]');
      await expect(showLogs(config(root), {}, { ...dependencies, runner: async () => ({ stdout: '', stderr: 'primary failure secret-value', exitCode: 1, signal: null, startedAt: '', durationMs: 1 }) }))
        .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'primary failure [REDACTED]' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('queries the installed Expo Go executable without native build state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-go-logs-'));
    const calls: string[][] = [];
    const go: LoadedConfig = { ...config(root), app: { type: 'expo', root, port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' } };
    try {
      const result = await showLogs(go, {}, {
        resolveDevice: async () => device,
        readState: async () => { throw new Error('no native build'); },
        runner: async (args) => {
          calls.push(args);
          return { stdout: args[0] === 'listapps' ? '{ "host.exp.Exponent" = { CFBundleIdentifier = "host.exp.Exponent"; CFBundleExecutable = Exponent; }; }' : 'Expo host log\n', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 };
        },
      });
      expect(result).toMatchObject({ bundleId: 'host.exp.Exponent', logs: ['Expo host log'] });
      expect(calls).toContainEqual(['spawn', 'PHONE', 'log', 'show', '--last', '30s', '--predicate', 'process == "Exponent"', '--style', 'compact']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns a bounded tail and retains the complete redacted log artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    const output = 'first secret-value\nsecond\nknown app message\nfourth\n';
    try {
      const result = await showLogs(config(root), { last: '45s', level: 'info', limit: 2 }, {
        now: () => new Date('2026-09-21T12:00:00.000Z'), resolveDevice: async () => device, readState: async () => state,
        runner: async (args) => { calls.push(args); return { stdout: output, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
      });
      expect(result).toMatchObject({ logs: ['known app message', 'fourth'], truncated: true, last: '45s', level: 'info' });
      expect(calls[0]).toEqual(['spawn', 'PHONE', 'log', 'show', '--last', '45s', '--info', '--predicate', 'process == "RealExecutable"', '--style', 'compact']);
      const artifact = await readFile(path.join(root, result.artifact), 'utf8');
      expect(artifact).toBe('first [REDACTED]\nsecond\nknown app message\nfourth\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('redacts the configured simulator identity from the result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const secretDevice = { ...device, udid: 'secret-value-PHONE' };
    try {
      const result = await showLogs(config(root), {}, {
        resolveDevice: async () => secretDevice,
        readState: async () => ({ ...state, udid: secretDevice.udid }),
        runner: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }),
      });
      expect(result.udid).toBe('[REDACTED]-PHONE');
      expect(JSON.stringify(result)).not.toContain('secret-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('starts at the latest agemu launch in local time with --since=launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    const launchedAt = new Date(2026, 8, 30, 7, 5, 9, 500);
    try {
      await writeLaunchMarker(root, { at: launchedAt, udid: 'PHONE', bundleId: 'com.example.app', source: 'app launch' });
      const result = await showLogs(config(root), { since: 'launch' }, {
        resolveDevice: async () => device, readState: async () => state,
        runner: async (args) => {
          calls.push(args);
          const stdout = 'Timestamp               Ty Process[PID:TID]\n2026-09-30 07:05:09.200 Df RealExecutable[1:2] before launch\n2026-09-30 07:05:09.600 Df RealExecutable[1:2] after launch\n';
          return { stdout, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 };
        },
      });
      expect(calls[0]).toEqual(['spawn', 'PHONE', 'log', 'show', '--start', expect.stringMatching(/^2026-09-30 07:05:09[+-]\d{4}$/), '--predicate', 'process == "RealExecutable"', '--style', 'compact']);
      expect(result).toMatchObject({ since: { start: launchedAt.toISOString(), source: 'launch' } });
      expect(result.logs).toEqual(['Timestamp               Ty Process[PID:TID]', '2026-09-30 07:05:09.600 Df RealExecutable[1:2] after launch']);
      expect(result).not.toHaveProperty('last');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects --since with --last and --since=launch without a recorded launch, before querying logs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    const dependencies = {
      resolveDevice: async () => device, readState: async () => state,
      runner: async (args: string[]) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
    };
    try {
      await expect(showLogs(config(root), { since: 'launch', last: '1m' }, dependencies)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
      await expect(showLogs(config(root), { since: 'launch' }, dependencies)).rejects.toMatchObject({ code: 'COMMAND_INVALID', message: expect.stringContaining('No agemu launch recorded') });
      expect(calls).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  describe('logs stream', () => {
    type Call = { executable: string; args: string[] };
    const streamOf = (lines: string[], calls: Call[], exit = { exitCode: 0 as number | null, stderr: '' }) =>
      async (executable: string, args: string[], options: { onLine: (line: string) => boolean | void }) => {
        calls.push({ executable, args });
        for (const line of lines) if (options.onLine(line) === true) return { stoppedBy: 'until' as const, exitCode: null, signal: 'SIGINT' as const, stderr: '' };
        return { stoppedBy: exit.exitCode === 0 ? 'duration' as const : 'exit' as const, exitCode: exit.exitCode, signal: null, stderr: exit.stderr };
      };

    it('keeps capture success and failure when events cannot be written', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-event-failure-'));
      const dependencies = { resolveDevice: async () => device, readState: async () => state };
      try {
        await mkdir(path.join(root, '.agemu/events.jsonl'), { recursive: true });
        const result = await streamLogs(config(root), { duration: '3s' }, { ...dependencies, stream: streamOf(['captured secret-value'], []) });
        expect(result.logs).toEqual(['captured [REDACTED]']);
        expect(await readFile(path.join(root, result.artifact), 'utf8')).toBe('captured [REDACTED]\n');
        await expect(streamLogs(config(root), { duration: '3s' }, { ...dependencies, stream: streamOf([], [], { exitCode: 1, stderr: 'primary secret-value failure' }) }))
          .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'primary [REDACTED] failure' });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('redacts lines before matching and saves the redacted capture without the filter banner', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      const calls: Call[] = [];
      const lines = ['Filtering the log data using "process == \\"RealExecutable\\""', 'token secret-value issued', 'Login succeeded for [REDACTED]', 'never read'];
      try {
        const result = await streamLogs(config(root), { duration: '30s', until: 'issued|succeeded', level: 'debug' }, {
          resolveDevice: async () => device, readState: async () => state, stream: streamOf(lines, calls),
        });
        expect(calls[0]).toEqual({ executable: 'xcrun', args: ['simctl', 'spawn', 'PHONE', 'log', 'stream', '--style', 'compact', '--level', 'debug', '--predicate', 'process == "RealExecutable"'] });
        expect(result).toMatchObject({ stoppedBy: 'until', matched: true, matchedLine: 'token [REDACTED] issued', logs: ['token [REDACTED] issued'] });
        expect(await readFile(path.join(root, result.artifact), 'utf8')).toBe('token [REDACTED] issued\n');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('does not match a regex that only the unredacted secret would satisfy', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      try {
        const result = await streamLogs(config(root), { duration: '3s', until: 'secret-value', limit: 1 }, {
          resolveDevice: async () => device, readState: async () => state, stream: streamOf(['a secret-value', 'b'], []),
        });
        expect(result).toMatchObject({ stoppedBy: 'duration', matched: false, logs: ['b'], truncated: true });
        expect(result).not.toHaveProperty('matchedLine');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('fails with PROCESS_FAILED when log stream exits early with an error', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      try {
        await expect(streamLogs(config(root), { duration: '10s' }, {
          resolveDevice: async () => device, readState: async () => state, stream: streamOf([], [], { exitCode: 1, stderr: 'bad secret-value' }),
        })).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'bad [REDACTED]' });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it.each([[{}], [{ duration: '11m' }], [{ duration: '0s' }], [{ duration: '5h' }], [{ duration: '5s', until: '(' }]])(
      'rejects invalid options %j before streaming', async (options) => {
        const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
        const calls: Call[] = [];
        try {
          await expect(streamLogs(config(root), options, { resolveDevice: async () => device, readState: async () => state, stream: streamOf([], calls) }))
            .rejects.toMatchObject({ code: 'COMMAND_INVALID' });
          expect(calls).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
      });

    it('requires a booted simulator', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-stream-'));
      const calls: Call[] = [];
      try {
        await expect(streamLogs(config(root), { duration: '5s' }, {
          resolveDevice: async () => ({ ...device, state: 'Shutdown' }), readState: async () => state, stream: streamOf([], calls),
        })).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED', message: expect.stringContaining('not booted') });
        expect(calls).toEqual([]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  describe('logs js', () => {
    type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;
    const target = {
      id: '17f540a5ab9120967d2ea29496a25014754d71fe-1', title: 'host.exp.Exponent (iPhone)', description: 'React Native Bridgeless [C++ connection]',
      appId: 'host.exp.Exponent', deviceName: 'iPhone', webSocketDebuggerUrl: 'ws://127.0.0.1:8093/inspector/debug?device=17f540a5ab9120967d2ea29496a25014754d71fe&page=1',
      reactNative: { capabilities: { supportsMultipleDebuggers: true } },
    };
    const goConfig = (root: string): LoadedConfig => ({ ...config(root), app: { type: 'expo', root, port: 8093, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' } });
    // A socket that opens and then delivers the given CDP frames, as Metro's inspector proxy does.
    const socketOf = (frames: string[], sent: string[] = []) => () => {
      const listeners = new Map<string, Listener[]>();
      setTimeout(() => {
        for (const listener of listeners.get('open') ?? []) listener({});
        for (const data of frames) for (const listener of listeners.get('message') ?? []) listener({ data });
      }, 0);
      return { addEventListener: (type: string, listener: Listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); }, send: (data: string) => { sent.push(data); }, close: () => {} };
    };
    const consoleFrame = (type: string, timestamp: number, value: string) => JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {
      type, timestamp, args: [{ type: 'string', value }], stackTrace: { callFrames: [{ functionName: 'login', url: 'http://127.0.0.1:8093/secret-value.bundle', lineNumber: 3, columnNumber: 7 }] },
    } });
    const dependencies = (frames: string[], start: number) => ({
      clock: () => start, now: () => new Date(start), serverStatus: async () => ({ running: true }), listDevices: async () => [device],
      fetch: async () => ({ ok: true, status: 200, json: async () => [target] }), WebSocketImpl: socketOf(frames),
    });

    it('keeps JavaScript capture success and discovery failure when events cannot be written', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-js-event-failure-'));
      const start = Date.now();
      const base = dependencies([consoleFrame('log', start + 1, 'captured secret-value')], start);
      try {
        await mkdir(path.join(root, '.agemu/events.jsonl'), { recursive: true });
        const result = await captureJsLogs(goConfig(root), { duration: '3s', until: 'captured' }, base);
        expect(result).toMatchObject({ matched: true, matchedMessage: 'captured [REDACTED]' });
        expect(await readFile(path.join(root, result.artifact), 'utf8')).not.toContain('secret-value');
        await expect(captureJsLogs(goConfig(root), { duration: '3s' }, { ...base, fetch: async () => ({ ok: true, status: 200, json: async () => [] }) }))
          .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('No JavaScript target') });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('redacts console text before --until matching and in the response and artifact', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-js-'));
      const start = Date.now();
      const frames = [
        consoleFrame('log', start - 5_000, 'replayed before start'),
        consoleFrame('log', start + 1, 'token secret-value issued'),
        consoleFrame('warning', start + 2, 'login secret-value failed'),
        consoleFrame('error', start + 3, 'never read'),
      ];
      try {
        // 'secret-value' alone must not match: matching sees only redacted text.
        const result = await captureJsLogs(goConfig(root), { duration: '10s', until: 'secret-value|\\[REDACTED\\] failed' }, dependencies(frames, start));
        const stack = 'login http://127.0.0.1:8093/[REDACTED].bundle:3:7';
        expect(result).toMatchObject({
          bundleId: 'host.exp.Exponent', port: 8093, target: { id: target.id, title: target.title }, duration: '10s',
          stoppedBy: 'until', matched: true, matchedMessage: 'login [REDACTED] failed', truncated: false,
          messages: [
            { level: 'log', text: 'token [REDACTED] issued', timestamp: new Date(start + 1).toISOString(), stack },
            { level: 'warn', text: 'login [REDACTED] failed', timestamp: new Date(start + 2).toISOString(), stack },
          ],
        });
        expect(JSON.stringify(result)).not.toContain('secret-value');
        expect(result.artifact).toMatch(/js-console\.jsonl$/);
        const artifact = await readFile(path.join(root, result.artifact), 'utf8');
        expect(artifact.trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual(result.messages);
        const events = await readFile(path.join(root, '.agemu', 'events.jsonl'), 'utf8');
        expect(events).toContain('"command":"logs js"');
        expect(events).not.toContain('secret-value');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('redacts a secret that straddles the 4000-character cap', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-js-'));
      const start = Date.now();
      try {
        const result = await captureJsLogs(goConfig(root), { duration: '10s', until: 'x' }, dependencies([consoleFrame('log', start + 1, `${'x'.repeat(3990)}secret-value`)], start));
        expect(result.messages[0].text).toBe(`${'x'.repeat(3990)}[REDACTED]`);
        const artifact = await readFile(path.join(root, result.artifact), 'utf8');
        expect(artifact).not.toContain('secret-val');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('records a redacted error event with run and artifact when no JavaScript target exists', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-js-'));
      const secretConfig: LoadedConfig = { ...goConfig(root), redactions: ['Exponent'] };
      try {
        const failure = await captureJsLogs(secretConfig, { duration: '5s' }, { ...dependencies([], Date.now()), fetch: async () => ({ ok: true, status: 200, json: async () => [] }) })
          .then(() => undefined, (error: unknown) => error as { code: string; message: string; details: { run: string; artifact: string } });
        expect(failure).toMatchObject({ code: 'PROCESS_FAILED', message: 'No JavaScript target for host.exp.[REDACTED] on iPhone; launch the app with agemu app launch and wait for it to load' });
        expect(failure!.details.artifact).toMatch(/js-console\.jsonl$/);
        await readFile(path.join(root, failure!.details.artifact), 'utf8');
        const events = (await readFile(path.join(root, '.agemu', 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events).toContainEqual(expect.objectContaining({
          command: 'logs js', status: 'error', error: { code: 'PROCESS_FAILED', message: failure!.message }, details: expect.objectContaining({ run: failure!.details.run }),
        }));
        expect(JSON.stringify(events)).not.toContain('Exponent');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('rejects native apps, a stopped server, and invalid options before contacting Metro', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-js-'));
      const fetched: string[] = [];
      const base = { ...dependencies([], Date.now()), fetch: async (url: string) => { fetched.push(url); return { ok: true, status: 200, json: async () => [target] }; } };
      try {
        await expect(captureJsLogs(config(root), { duration: '5s' }, base)).rejects.toMatchObject({ code: 'WORKFLOW_UNSUPPORTED' });
        await expect(captureJsLogs(goConfig(root), { duration: '5s' }, { ...base, serverStatus: async () => ({ running: false }) }))
          .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: 'Metro/Expo server is not running for this project; run agemu server start' });
        await expect(captureJsLogs(goConfig(root), { duration: '5s' }, { ...base, serverStatus: async () => ({ running: true, collision: true }) }))
          .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('run agemu server start') });
        for (const options of [{}, { duration: '11m' }, { duration: '0s' }, { duration: '5s', until: '(' }, { duration: '5s', limit: 10_001 }]) {
          await expect(captureJsLogs(goConfig(root), options, base)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
        }
        expect(fetched).toEqual([]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('refuses a shut-down Simulator or a same-name booted Simulator before contacting Metro', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agemu-js-'));
      const fetched: string[] = [];
      // Metro lists the app on a Simulator named like the configured one, so only the device check can refuse it.
      const base = { ...dependencies([], Date.now()), fetch: async (url: string) => { fetched.push(url); return { ok: true, status: 200, json: async () => [target] }; } };
      const twin: Device = { ...device, udid: 'TWIN' };
      try {
        await expect(captureJsLogs(goConfig(root), { duration: '5s' }, { ...base, listDevices: async () => [{ ...device, state: 'Shutdown' }, twin] }))
          .rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED', details: { udid: 'PHONE' } });
        await expect(captureJsLogs(goConfig(root), { duration: '5s' }, { ...base, listDevices: async () => [device, twin] }))
          .rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('Another booted Simulator is also named iPhone'), details: { udid: 'PHONE', sameName: ['TWIN'] } });
        expect(fetched).toEqual([]);
        const start = Date.now();
        await expect(captureJsLogs(goConfig(root), { duration: '5s', until: 'x' }, { ...dependencies([consoleFrame('log', start + 1, 'x')], start), listDevices: async () => [device, { ...twin, state: 'Shutdown' }] }))
          .resolves.toMatchObject({ target: { id: target.id } });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  it.each([
    ['default', ['--predicate', 'process == "RealExecutable"']],
    ['debug', ['--debug', '--predicate', 'process == "RealExecutable"']],
    ['error', ['--predicate', 'process == "RealExecutable" AND (messageType == error OR messageType == fault)']],
    ['fault', ['--predicate', 'process == "RealExecutable" AND messageType == fault']],
  ])('maps the %s level to supported log show arguments', async (level, expected) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-logs-'));
    const calls: string[][] = [];
    try {
      await showLogs(config(root), { level }, {
        resolveDevice: async () => device, readState: async () => state,
        runner: async (args) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 }; },
      });
      expect(calls[0]).toEqual(['spawn', 'PHONE', 'log', 'show', '--last', '30s', ...expected, '--style', 'compact']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
