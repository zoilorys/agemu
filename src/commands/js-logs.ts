import { closeSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { appendEvent, createRun } from '../artifacts/runs.js';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import {
  captureConsole, listTargets, selectTarget, type CaptureResult, type FetchLike, type JsConsoleMessage, type SelectedTarget, type WebSocketFactory,
} from '../native/js-console.js';
import { listDevices, resolveDevice, type Device } from '../native/simctl.js';
import { requireBooted } from '../native/simctl-commands.js';
import { server } from './server.js';

export type JsLogOptions = { duration?: string; until?: string; limit?: number };
type Dependencies = {
  now?: () => Date;
  clock?: () => number;
  serverStatus?: (config: LoadedConfig) => Promise<{ running: boolean; collision?: boolean }>;
  listDevices?: () => Promise<Device[]>;
  fetch?: FetchLike;
  WebSocketImpl?: WebSocketFactory;
};

const defaultStatus = async (config: LoadedConfig) => {
  const result = await server(config, 'status');
  return { running: 'running' in result && result.running === true, collision: 'collision' in result && result.collision === true };
};

export async function captureJsLogs(config: LoadedConfig, options: JsLogOptions = {}, dependencies: Dependencies = {}) {
  if (config.app.type === 'native') throw new CliError('WORKFLOW_UNSUPPORTED', 'logs js requires a React Native or Expo app');
  const port = config.app.port;
  const secrets = config.redactions ?? [];
  const limit = options.limit ?? 100;
  const match = options.duration === undefined ? null : /^(\d+)([sm])$/.exec(options.duration);
  const durationMs = match ? Number(match[1]) * (match[2] === 'm' ? 60_000 : 1_000) : NaN;
  if (!(durationMs >= 1_000 && durationMs <= 600_000)) throw new CliError('COMMAND_INVALID', '--duration is required: a number followed by s or m, from 1s to 10m');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) throw new CliError('COMMAND_INVALID', '--limit must be an integer from 0 to 10000');
  let until: RegExp | undefined;
  if (options.until !== undefined) {
    if (options.until.length === 0) throw new CliError('COMMAND_INVALID', '--until requires a non-empty regular expression');
    try { until = new RegExp(options.until); }
    catch (error) { throw new CliError('COMMAND_INVALID', `--until is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const status = await (dependencies.serverStatus ?? defaultStatus)(config);
  if (!status.running || status.collision) throw new CliError('PROCESS_FAILED', 'Metro/Expo server is not running for this project; run agemu server start');
  const devices = await (dependencies.listDevices ?? listDevices)();
  const device = resolveDevice(devices, config.simulator);
  requireBooted(device);
  // Metro identifies a target only by device name, so a same-name booted Simulator would be indistinguishable.
  const twins = devices.filter((other) => other.udid !== device.udid && other.name === device.name && other.state === 'Booted');
  if (twins.length > 0) {
    throw new CliError('PROCESS_FAILED', `Another booted Simulator is also named ${device.name}; Metro identifies JavaScript targets only by device name, so agemu cannot tell them apart. Shut down or rename the other Simulator`, {
      udid: device.udid, sameName: twins.map((other) => other.udid),
    });
  }
  const now = dependencies.now?.() ?? new Date();
  const clock = dependencies.clock ?? Date.now;
  const run = await createRun(config.root, now);
  const bundleId = targetBundleId(config);
  const artifact = path.join(run.directory, 'js-console.jsonl');
  const artifactPath = redact(path.relative(config.root, artifact), secrets);
  const base = { run: run.relativeDirectory, bundleId: redact(bundleId, secrets), port, duration: options.duration! };
  const fd = openSync(artifact, 'w', 0o600);
  const fail = async (error: unknown): Promise<CliError> => {
    const normalized = error instanceof CliError ? error : new CliError('PROCESS_FAILED', error instanceof Error ? error.message : String(error));
    const details = { ...(normalized.details ?? {}), artifact: artifactPath, run: run.relativeDirectory };
    const redacted = new CliError(normalized.code, redact(normalized.message, secrets), details);
    await appendEvent(config.root, { at: now.toISOString(), command: 'logs js', status: 'error', error: { code: redacted.code, message: redacted.message }, details }, secrets);
    return redacted;
  };
  // The duration covers target discovery, connection, and capture.
  const startMs = clock();
  const deadlineMs = startMs + durationMs;
  const messages: JsConsoleMessage[] = [];
  let total = 0;
  let matchedMessage: string | undefined;
  let target: SelectedTarget;
  let outcome: CaptureResult;
  try {
    const targets = await listTargets(port, Math.min(5_000, deadlineMs - clock()), dependencies.fetch);
    target = selectTarget(targets, bundleId, device.name);
    outcome = await captureConsole(target.webSocketDebuggerUrl, {
      port, startMs, deadlineMs, clock, secrets, WebSocketImpl: dependencies.WebSocketImpl,
      onMessage: (raw) => {
        const message: JsConsoleMessage = { ...raw, text: redact(raw.text, secrets), ...(raw.stack !== undefined ? { stack: redact(raw.stack, secrets) } : {}) };
        total += 1;
        writeSync(fd, `${JSON.stringify(message)}\n`);
        if (limit > 0) { messages.push(message); if (messages.length > limit) messages.shift(); }
        if (until?.test(message.text)) { matchedMessage = message.text; return true; }
        return false;
      },
    });
  } catch (error) {
    closeSync(fd);
    throw await fail(error);
  }
  closeSync(fd);
  const data = {
    ...base, target: { id: redact(target.id, secrets), title: redact(target.title, secrets) },
    stoppedBy: outcome.stoppedBy,
    ...(outcome.stoppedBy === 'disconnected' ? { disconnect: { code: outcome.closeCode, reason: redact(outcome.closeReason ?? '', secrets) } } : {}),
    matched: matchedMessage !== undefined, ...(matchedMessage !== undefined ? { matchedMessage } : {}),
    messages, truncated: total > limit, artifact: artifactPath, capturedAt: now.toISOString(),
  };
  await appendEvent(config.root, { at: now.toISOString(), command: 'logs js', status: 'ok', data: { ...data, messages: undefined } }, secrets);
  return data;
}
