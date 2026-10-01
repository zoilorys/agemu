import { describe, expect, it } from 'vitest';
import {
  captureConsole, listTargets, renderArgs, selectTarget, type JsConsoleMessage, type SocketEvent, type WebSocketLike,
} from '../../src/native/js-console.js';

// Shapes recorded in .tasks/diagnostics-evidence/prototype-js-console.md (Expo Go 57, RN 0.86.3, Metro 0.84.5).
const recordedTarget = {
  id: '17f540a5ab9120967d2ea29496a25014754d71fe-1',
  title: 'host.exp.Exponent (iPhone 16 Plus)',
  description: 'React Native Bridgeless [C++ connection]',
  appId: 'host.exp.Exponent',
  type: 'node',
  devtoolsFrontendUrl: '/debugger-frontend/rn_fusebox.html?ws=…',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8093/inspector/debug?device=17f540a5ab9120967d2ea29496a25014754d71fe&page=1',
  deviceName: 'iPhone 16 Plus',
  reactNative: {
    logicalDeviceId: '17f540a5ab9120967d2ea29496a25014754d71fe',
    capabilities: { nativePageReloads: true, nativeSourceCodeFetching: false, supportsMultipleDebuggers: true },
  },
};
const bundleUrl = 'http://127.0.0.1:8093/index.bundle//&platform=ios&dev=true';
const top = { columnNumber: 39, functionName: 'anonymous', lineNumber: 1168, scriptId: '7', url: bundleUrl };
const consoleEvent = (params: Record<string, unknown>) => JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { executionContextId: 1, stackTrace: { callFrames: [top] }, ...params } });
const notice = (timestamp: number) => consoleEvent({ type: 'info', timestamp, args: [{ type: 'string', value: '\u001b[48;2;253;247;231m\u001b[30m\u001b[1mNOTE: \u001b[22mYou are using an unsupported debugging client. Use the Dev Menu in your app (or type `j` in the Metro terminal) to open React Native DevTools.' }] });
const probeLog = (timestamp: number) => consoleEvent({ type: 'log', timestamp, args: [{ type: 'string', value: 'agemu-js-probe' }, { type: 'number', value: Math.floor(timestamp) }] });
const probeWarn = (timestamp: number) => consoleEvent({ type: 'warning', timestamp, args: [{ type: 'string', value: 'agemu-js-probe-warn' }, { className: 'Object', description: 'Object', objectId: '1', type: 'object' }] });
const probeError = (timestamp: number) => consoleEvent({ type: 'error', timestamp, args: [{ type: 'string', value: 'agemu-js-probe-error' }, { className: 'Object', description: 'Object', objectId: '2', type: 'object' }] });

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(event: SocketEvent) => void>>();
  constructor(readonly url: string, readonly init: { headers: Record<string, string> }) {}
  addEventListener(type: string, listener: (event: SocketEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  emit(type: string, event: SocketEvent = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

const connect = (deadlineInMs: number, startMs = Date.now(), onMessage: (message: JsConsoleMessage) => boolean | void = () => false) => {
  let socket!: FakeSocket;
  const capture = captureConsole(recordedTarget.webSocketDebuggerUrl, {
    port: 8093, startMs, deadlineMs: Date.now() + deadlineInMs, onMessage,
    WebSocketImpl: (url, init) => (socket = new FakeSocket(url, init)),
  });
  return { capture, socket };
};

describe('selectTarget', () => {
  it('selects the recorded Expo Go target by app ID and Simulator name', () => {
    const other = { ...recordedTarget, id: 'other-1', appId: 'com.example.other', title: 'com.example.other (iPhone 16 Plus)' };
    const elsewhere = { ...recordedTarget, id: 'ipad-1', deviceName: 'iPad Pro' };
    expect(selectTarget([other, recordedTarget, elsewhere], 'host.exp.Exponent', 'iPhone 16 Plus')).toEqual({
      id: recordedTarget.id, title: recordedTarget.title, description: recordedTarget.description, webSocketDebuggerUrl: recordedTarget.webSocketDebuggerUrl,
    });
  });

  it('fails with guidance when the bundle has not loaded (empty /json/list)', () => {
    expect(() => selectTarget([], 'host.exp.Exponent', 'iPhone 16 Plus')).toThrow(expect.objectContaining({
      code: 'PROCESS_FAILED',
      message: 'No JavaScript target for host.exp.Exponent on iPhone 16 Plus; launch the app with agemu app launch and wait for it to load',
    }));
  });

  it('lists every candidate when two Simulators share a name (P7)', () => {
    const twin = { ...recordedTarget, id: '0000aaaa-1' };
    let thrown: unknown;
    try { selectTarget([recordedTarget, twin], 'host.exp.Exponent', 'iPhone 16 Plus'); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({
      code: 'PROCESS_FAILED',
      message: expect.stringContaining(`${recordedTarget.id} (${recordedTarget.title}; ${recordedTarget.description}), 0000aaaa-1`),
      details: { targets: [{ id: recordedTarget.id, title: recordedTarget.title, description: recordedTarget.description }, expect.objectContaining({ id: '0000aaaa-1' })] },
    });
  });

  it.each([false, undefined])('refuses a target whose supportsMultipleDebuggers is %s', (supportsMultipleDebuggers) => {
    const single = { ...recordedTarget, reactNative: { ...recordedTarget.reactNative, capabilities: { ...recordedTarget.reactNative.capabilities, supportsMultipleDebuggers } } };
    expect(() => selectTarget([single], 'host.exp.Exponent', 'iPhone 16 Plus')).toThrow(expect.objectContaining({ code: 'PROCESS_FAILED', message: expect.stringContaining('disconnect React Native DevTools') }));
  });
});

describe('listTargets', () => {
  it('reads /json/list on the configured port', async () => {
    const urls: string[] = [];
    const targets = await listTargets(8093, 1_000, async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => [recordedTarget] }; });
    expect(urls).toEqual(['http://127.0.0.1:8093/json/list']);
    expect(targets).toEqual([recordedTarget]);
  });

  it('times out with PROCESS_FAILED when Metro does not answer', async () => {
    const hanging = (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(listTargets(8093, 20, hanging)).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('timed out after 20 ms') });
  });
});

describe('renderArgs', () => {
  it('renders the recorded argument shapes by the findings rule', () => {
    const errorStack = 'Error: boom\n    at typesOnce (…)\n    at anonymous (…)';
    const args = [
      { type: 'string', value: 'agemu-js-types' },
      { subtype: 'null', type: 'object', value: null },
      { type: 'undefined' },
      { type: 'boolean', value: true },
      { description: '7n', type: '', unserializableValue: '7n' },
      { description: 'NaN', type: 'number', unserializableValue: 'NaN' },
      { description: '-Infinity', type: 'number', unserializableValue: '-Infinity' },
      { description: 'Symbol(s)', objectId: '48', type: 'symbol' },
      { className: 'Array', description: 'Array(3)', objectId: '49', preview: { description: 'Array(3)', overflow: false, properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'number', value: '2' }, { name: '2', type: 'number', value: '3' }], subtype: 'array', type: 'object' }, subtype: 'array', type: 'object' },
      { description: 'function named() { [bytecode] }', objectId: '50', type: 'function', value: '' },
      { className: 'Object', description: 'Object', objectId: '51', preview: { description: 'Object', overflow: false, properties: [{ name: 'plain', type: 'number', value: '1' }, { name: 'trap', type: 'number', value: '2' }], type: 'object' }, type: 'object' },
      { className: 'Error', description: errorStack, objectId: '53', preview: { description: 'Object', overflow: false, properties: [{ name: 'message', type: 'string', value: 'boom' }], type: 'object' }, subtype: 'error', type: 'object' },
      { className: 'Error', description: 'TypeError: bad\n    at typesOnce (…)', objectId: '54', subtype: 'error', type: 'object' },
      // Logged while no client was connected: no preview.
      { className: 'Object', description: 'Object', objectId: '24', type: 'object' },
    ];
    expect(renderArgs(args)).toBe('agemu-js-types null undefined true 7n NaN -Infinity Symbol(s) [1, 2, 3] function named() { [bytecode] } {plain: 1, trap: 2} Error: boom TypeError: bad Object');
  });

  it('marks overflowing previews and falls back to subtype or type for property values', () => {
    const object = { type: 'object', description: 'Object', preview: { overflow: true, properties: [{ name: 'nested', type: 'object', subtype: 'array' }, { name: 'fn', type: 'function' }] } };
    expect(renderArgs([object])).toBe('{nested: array, fn: function, …}');
    expect(renderArgs([{ type: 'object', subtype: 'array', description: 'Array(200)', preview: { overflow: true, properties: [{ name: '0', type: 'number', value: '1' }] } }])).toBe('[1, …]');
  });

  it('strips ANSI escapes and caps a message at 4000 characters', () => {
    expect(renderArgs([{ type: 'string', value: '\u001b[30m\u001b[1mNOTE: \u001b[22mhello' }])).toBe('NOTE: hello');
    expect(renderArgs([{ type: 'string', value: 'x'.repeat(5_000) }])).toHaveLength(4_000);
  });
});

describe('captureConsole', () => {
  it('connects with a local Origin header and sends only Runtime.enable', async () => {
    const { capture, socket } = connect(10_000);
    expect(socket.url).toBe(recordedTarget.webSocketDebuggerUrl);
    expect(socket.init).toEqual({ headers: { Origin: 'http://127.0.0.1:8093' } });
    expect(socket.sent).toEqual([]);
    socket.emit('open');
    expect(socket.sent.map((data) => JSON.parse(data) as unknown)).toEqual([{ id: 1, method: 'Runtime.enable', params: {} }]);
    socket.emit('close', { code: 1000, reason: '[CONNECTION_LOST] Connection lost to corresponding device' });
    await capture;
    expect(socket.sent).toHaveLength(1);
  });

  it('drops replayed messages and the injected notice, maps levels and stacks, and keeps events across context changes', async () => {
    const startMs = 1790886605000;
    const received: JsConsoleMessage[] = [];
    const { capture, socket } = connect(10_000, startMs, (message) => { received.push(message); });
    socket.emit('open');
    socket.emit('message', { data: notice(startMs + 50) });
    socket.emit('message', { data: JSON.stringify({ method: 'Runtime.executionContextCreated', params: { context: { name: 'main', origin: '', id: 1 } } }) });
    socket.emit('message', { data: probeLog(startMs - 70_000) });
    socket.emit('message', { data: probeWarn(startMs - 1) });
    socket.emit('message', { data: JSON.stringify({ id: 1, result: {} }) });
    socket.emit('message', { data: probeLog(1790886605477.953) });
    socket.emit('message', { data: JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }) });
    socket.emit('message', { data: probeWarn(startMs + 1_000) });
    socket.emit('message', { data: probeError(startMs + 1_010) });
    socket.emit('close', { code: 1000, reason: '[CONNECTION_LOST] Connection lost to corresponding device' });
    expect(await capture).toEqual({ stoppedBy: 'disconnected', closeCode: 1000, closeReason: '[CONNECTION_LOST] Connection lost to corresponding device' });
    const stack = `anonymous ${bundleUrl}:1168:39`;
    expect(received).toEqual([
      { level: 'log', text: 'agemu-js-probe 1790886605477', timestamp: new Date(1790886605477.953).toISOString(), stack },
      { level: 'warn', text: 'agemu-js-probe-warn Object', timestamp: new Date(startMs + 1_000).toISOString(), stack },
      { level: 'error', text: 'agemu-js-probe-error Object', timestamp: new Date(startMs + 1_010).toISOString(), stack },
    ]);
  });

  it('stops and closes the socket when onMessage reports an --until match', async () => {
    const startMs = Date.now();
    const received: string[] = [];
    const { capture, socket } = connect(10_000, startMs, (message) => { received.push(message.text); return message.level === 'error'; });
    socket.emit('open');
    socket.emit('message', { data: probeLog(startMs + 1) });
    socket.emit('message', { data: probeError(startMs + 2) });
    socket.emit('message', { data: probeLog(startMs + 3) });
    expect(await capture).toEqual({ stoppedBy: 'until' });
    expect(socket.closed).toBe(true);
    expect(received).toEqual(['agemu-js-probe ' + String(startMs + 1), 'agemu-js-probe-error Object']);
  });

  it('stops at the deadline and closes the socket', async () => {
    const { capture, socket } = connect(30);
    socket.emit('open');
    expect(await capture).toEqual({ stoppedBy: 'duration' });
    expect(socket.closed).toBe(true);
  });

  it('reports the Origin requirement when the handshake is rejected (error then close 1006, no open)', async () => {
    const { capture, socket } = connect(10_000);
    socket.emit('error', { message: '' });
    socket.emit('close', { code: 1006, reason: '' });
    await expect(capture).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('Metro requires a local Origin header') });
  });

  it('fails when the socket never opens within the remaining duration', async () => {
    const { capture, socket } = connect(20);
    await expect(capture).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('timed out') });
    expect(socket.closed).toBe(true);
  });

  it('returns disconnected with the reason when a non-multi-debugger peer replaces the client', async () => {
    const { capture, socket } = connect(10_000);
    socket.emit('open');
    socket.emit('close', { code: 1000, reason: '[NEW_DEBUGGER_OPENED] New debugger opened for the same app instance' });
    expect(await capture).toMatchObject({ stoppedBy: 'disconnected', closeReason: '[NEW_DEBUGGER_OPENED] New debugger opened for the same app instance' });
  });
});
