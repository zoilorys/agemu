import { redact } from '../core/redact.js';
import { CliError } from '../core/errors.js';
import { connectWebSocket } from './websocket.js';

// CDP client for Metro's inspector proxy. Observe-only: the only request sent is Runtime.enable.
// Never send Runtime.getProperties (runs Proxy traps), Runtime.evaluate, Page.reload, or debugger domains.

export type CdpTarget = {
  id?: unknown; title?: unknown; description?: unknown; appId?: unknown; deviceName?: unknown;
  webSocketDebuggerUrl?: unknown; reactNative?: { capabilities?: { supportsMultipleDebuggers?: unknown } };
};
export type SelectedTarget = { id: string; title: string; description: string; webSocketDebuggerUrl: string };
export type JsConsoleMessage = { level: string; text: string; timestamp: string; stack?: string };

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type SocketEvent = { data?: unknown; code?: number; reason?: string; message?: string };
export type WebSocketLike = {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: SocketEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export type WebSocketFactory = (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

export const nonFuseboxNotice = 'You are using an unsupported debugging client';
const maxText = 4_000;

// The maintained transport accepts Metro's Origin and bounds the close handshake.
const defaultWebSocket: WebSocketFactory = (url, init) => connectWebSocket(url, init);

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function listTargets(port: number, timeoutMs: number, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<CdpTarget[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value) || !value.every(object)) throw new Error('response is not a list of targets');
    return value as CdpTarget[];
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : message(error);
    throw new CliError('PROCESS_FAILED', `Could not list Metro inspector targets on port ${port}: ${reason}`);
  } finally { clearTimeout(timer); }
}

const text = (value: unknown) => typeof value === 'string' ? value : '';

export function selectTarget(targets: CdpTarget[], bundleId: string, deviceName: string): SelectedTarget {
  const matches = targets.filter((target) => target.appId === bundleId && target.deviceName === deviceName);
  if (matches.length === 0) throw new CliError('PROCESS_FAILED', `No JavaScript target for ${bundleId} on ${deviceName}; launch the app with agemu app launch and wait for it to load`);
  if (matches.length > 1) {
    const listed = matches.map((target) => ({ id: text(target.id), title: text(target.title), description: text(target.description) }));
    throw new CliError('PROCESS_FAILED', `Multiple JavaScript targets for ${bundleId} on ${deviceName}: ${listed.map((target) => `${target.id} (${target.title}; ${target.description})`).join(', ')}`, { targets: listed });
  }
  const [target] = matches;
  if (target.reactNative?.capabilities?.supportsMultipleDebuggers !== true) {
    throw new CliError('PROCESS_FAILED', 'The JavaScript target does not support multiple debuggers; connecting would disconnect React Native DevTools');
  }
  if (typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) throw new CliError('PROCESS_FAILED', 'The JavaScript target has no webSocketDebuggerUrl');
  return { id: text(target.id), title: text(target.title), description: text(target.description), webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

type RemoteObject = {
  type?: string; subtype?: string; value?: unknown; unserializableValue?: unknown; description?: string;
  preview?: { overflow?: boolean; subtype?: string; properties?: Array<{ name?: string; type?: string; subtype?: string; value?: string }> };
};

function renderArg(arg: RemoteObject): string {
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
  if (arg.type === 'string') return typeof arg.value === 'string' ? arg.value : '';
  if (arg.type === 'number' || arg.type === 'boolean') return String(arg.value);
  if (arg.type === 'undefined') return 'undefined';
  if (arg.subtype === 'null') return 'null';
  if (arg.type === 'symbol' || arg.type === 'function' || arg.subtype === 'error') return (arg.description ?? arg.type ?? '').split('\n')[0];
  if (arg.preview) {
    const properties = arg.preview.properties ?? [];
    const more = arg.preview.overflow ? '…' : '';
    const value = (property: { type?: string; subtype?: string; value?: string }) => property.value ?? property.subtype ?? property.type ?? '';
    if (arg.subtype === 'array') return `[${[...properties.map(value), ...(more ? [more] : [])].join(', ')}]`;
    return `{${[...properties.map((property) => `${property.name ?? ''}: ${value(property)}`), ...(more ? [more] : [])].join(', ')}}`;
  }
  return arg.description ?? arg.type ?? '';
}

// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// Redacts before the cap so a secret cut at the boundary cannot survive as a partial match.
export function renderArgs(args: unknown, secrets: string[] = []): string {
  const list = Array.isArray(args) ? args as RemoteObject[] : [];
  return redact(list.map((arg) => renderArg(arg ?? {})).join(' ').replace(ansi, ''), secrets).slice(0, maxText);
}

type ConsoleParams = {
  type?: string; timestamp?: number; args?: unknown;
  stackTrace?: { callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }> };
};

/** Maps one Runtime.consoleAPICalled to a message, or undefined when it predates startMs or is React Native's injected notice. */
export function mapConsoleEvent(params: ConsoleParams, startMs: number, secrets: string[] = []): JsConsoleMessage | undefined {
  if (typeof params.timestamp !== 'number' || !Number.isFinite(params.timestamp) || params.timestamp < startMs
    || !Number.isFinite(new Date(params.timestamp).getTime())) return undefined;
  const rendered = renderArgs(params.args, secrets);
  if (rendered.includes(nonFuseboxNotice)) return undefined;
  const frame = params.stackTrace?.callFrames?.[0];
  const stack = frame ? `${frame.functionName || 'anonymous'} ${frame.url ?? ''}:${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0}` : undefined;
  const level = params.type === 'warning' ? 'warn' : params.type ?? 'log';
  return { level, text: rendered, timestamp: new Date(params.timestamp).toISOString(), ...(stack ? { stack } : {}) };
}

export type CaptureOptions = {
  port: number;
  startMs: number;
  /** Absolute deadline (epoch ms) for the whole capture. */
  deadlineMs: number;
  /** Return true to stop early (until match). */
  onMessage: (message: JsConsoleMessage) => boolean | void;
  WebSocketImpl?: WebSocketFactory;
  clock?: () => number;
  openTimeoutMs?: number;
  /** Redacted from message text before it is capped. */
  secrets?: string[];
};
export type CaptureResult = { stoppedBy: 'duration' | 'until' | 'disconnected'; closeCode?: number; closeReason?: string };

// Bounded: settles no later than the deadline (or the open timeout) plus timer latency; never waits for the close handshake.
export function captureConsole(url: string, options: CaptureOptions): Promise<CaptureResult> {
  const clock = options.clock ?? Date.now;
  return new Promise<CaptureResult>((resolve, reject) => {
    let socket: WebSocketLike;
    try { socket = (options.WebSocketImpl ?? defaultWebSocket)(url, { headers: { Origin: `http://127.0.0.1:${options.port}` } }); }
    catch (error) { reject(error instanceof CliError ? error : new CliError('PROCESS_FAILED', `Could not connect to the Metro inspector: ${message(error)}`)); return; }
    let opened = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const close = () => { try { socket.close(1000); } catch { /* already closed */ } };
    const settle = (outcome: { result: CaptureResult } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      close();
      if ('error' in outcome) reject(outcome.error); else resolve(outcome.result);
    };
    const connectFailure = (detail: string) => new CliError('PROCESS_FAILED', `Could not connect to the Metro inspector (${detail}); Metro requires a local Origin header`);
    const openTimeout = Math.max(0, Math.min(options.openTimeoutMs ?? 5_000, options.deadlineMs - clock()));
    timers.push(setTimeout(() => { if (!opened) settle({ error: connectFailure(`timed out after ${openTimeout} ms`) }); }, openTimeout));
    socket.addEventListener('open', () => {
      if (settled) return;
      opened = true;
      timers.push(setTimeout(() => settle({ result: { stoppedBy: 'duration' } }), Math.max(0, options.deadlineMs - clock())));
      try { socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} })); }
      catch (error) { settle({ error: new CliError('PROCESS_FAILED', `Could not enable the Runtime domain: ${message(error)}`) }); }
    });
    socket.addEventListener('message', (event) => {
      if (settled || !opened) return;
      let payload: { method?: string; params?: ConsoleParams };
      try {
        const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        const parsed: unknown = JSON.parse(raw);
        if (!object(parsed)) return;
        payload = parsed as typeof payload;
      } catch { return; }
      if (payload.method !== 'Runtime.consoleAPICalled' || !object(payload.params)) return;
      try {
        const mapped = mapConsoleEvent(payload.params, options.startMs, options.secrets);
        if (mapped && options.onMessage(mapped) === true) settle({ result: { stoppedBy: 'until' } });
      }
      catch (error) { settle({ error }); }
    });
    socket.addEventListener('error', (event) => {
      const detail = event.message ? `: ${event.message}` : '';
      settle({ error: opened ? new CliError('PROCESS_FAILED', `Metro inspector connection failed${detail}`) : connectFailure(`error${detail}`) });
    });
    socket.addEventListener('close', (event) => {
      if (!opened) { settle({ error: connectFailure(`closed with code ${event.code ?? 'unknown'}${event.reason ? `: ${event.reason}` : ''}`) }); return; }
      settle({ result: { stoppedBy: 'disconnected', ...(event.code !== undefined ? { closeCode: event.code } : {}), ...(event.reason ? { closeReason: event.reason } : {}) } });
    });
  });
}
