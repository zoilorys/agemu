import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { checkUiDeadline, uiOperation } from './ui-deadline.js';
import type { Deadline } from '../process/run-process.js';
import { CliError } from '../core/errors.js';
import { uiArtifactStem } from './ui-artifact-name.js';

export type RecordingOptions = { timeoutMs?: number };
export type Recording = { stop: (options?: RecordingOptions) => Promise<void> };
export type RecordingStarter = (udid: string, file: string, options?: RecordingOptions) => Promise<Recording>;

export function createRecordingSession(udid: string, directory: string, root: string, start: RecordingStarter, limit: Deadline, secrets: string[] = []) {
  const recordings: string[] = [];
  let active: Recording | undefined;
  let starting = false;
  let closed = false;
  const cleanup = async (recording: Recording) => {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([recording.stop({ timeoutMs: 1_000 }), new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]); }
    catch { /* Cleanup never replaces the plan outcome. */ }
    finally { if (timer) clearTimeout(timer); }
  };
  return {
    recordings,
    start: async (name?: string) => {
      checkUiDeadline(limit);
      if (closed) throw new Error('Recording session is closed');
      if (active || starting) throw new Error('A video recording is already active');
      starting = true;
      const stem = uiArtifactStem(name, 'video', secrets);
      const file = path.join(directory, `${recordings.length + 1}-${stem}.mp4`);
      const pending = start(udid, file, { timeoutMs: Math.min(10_000, limit.remaining()) });
      let cleaned = false;
      try {
        const recording = await uiOperation(limit, () => pending);
        if (closed) { cleaned = true; await cleanup(recording); throw new Error('Recording session is closed'); }
        active = recording;
        recordings.push(path.relative(root, file));
      } catch (error) {
        // A late injected starter must not leave a recorder running after the command timed out.
        if (!cleaned) pending.then(cleanup, () => undefined);
        throw error;
      } finally { starting = false; }
    },
    stop: async () => {
      if (!active) throw new Error('No video recording is active');
      const recording = active;
      try { await uiOperation(limit, () => recording.stop({ timeoutMs: Math.min(10_000, limit.remaining()) })); active = undefined; }
      catch (error) { await cleanup(recording); active = undefined; throw error; }
    },
    close: async () => { closed = true; const recording = active; active = undefined; if (recording) await cleanup(recording); },
  };
}

export async function createRecordingBridge(udid: string, directory: string, root: string, start: RecordingStarter, limit: Deadline, secrets: string[] = []) {
  const session = createRecordingSession(udid, directory, root, start, limit, secrets);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') throw new Error('Unsupported recording request');
      if (request.url?.startsWith('/start?')) {
        await session.start(new URL(request.url, 'http://localhost').searchParams.get('name') ?? undefined);
      } else if (request.url === '/stop') await session.stop();
      else throw new Error('Unsupported recording request');
      response.writeHead(200).end('ok');
    } catch (error) { response.writeHead(500).end(error instanceof Error ? error.message : String(error)); }
  });
  try {
    await uiOperation(limit, () => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }));
  } catch (error) { server.closeAllConnections(); server.close(() => undefined); await session.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recording bridge has no port');
  return {
    port: address.port, recordings: session.recordings,
    close: async () => { server.closeAllConnections(); server.close(); await session.close(); },
  };
}

export async function startVideoRecording(udid: string, file: string, options: RecordingOptions = {}): Promise<Recording> {
  const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timeoutMs = Math.min(10_000, options.timeoutMs ?? 10_000);
  // simctl prints this after the capture stream is ready.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      if (stderr.includes('Recording started')) return resolve();
      const ready = (chunk: Buffer) => {
        if (String(chunk).includes('Recording started') || stderr.includes('Recording started')) {
          child.stderr.off('data', ready);
          resolve();
        }
      };
      child.stderr.on('data', ready);
      ended.then(() => { child.stderr.off('data', ready); reject(new Error(stderr.trim() || 'simctl recordVideo exited before recording started')); }, reject);
    }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('simctl recordVideo did not start within its deadline')), timeoutMs); }),
  ]).catch(error => {
    child.kill('SIGINT');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1_000);
    kill.unref();
    ended.finally(() => clearTimeout(kill)).catch(() => undefined);
    throw new CliError('UI_DELIVERY_FAILED', `Unable to start video recording: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => { if (timer) clearTimeout(timer); });
  return {
    stop: async (stopOptions = {}) => {
      child.kill('SIGINT');
      let stopTimer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        ended,
        new Promise<never>((_, reject) => {
          stopTimer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new CliError('UI_DELIVERY_FAILED', 'Video recording did not stop within its deadline'));
          }, Math.min(10_000, stopOptions.timeoutMs ?? 10_000));
        }),
      ]).finally(() => { if (stopTimer) clearTimeout(stopTimer); });
      if (outcome.code !== 0 && outcome.signal !== 'SIGINT') {
        throw new CliError('UI_DELIVERY_FAILED', `Unable to finish video recording: ${stderr.trim() || `simctl exited ${outcome.code}`}`);
      }
      const saved = await stat(file).catch(() => undefined);
      if (!saved || saved.size === 0) throw new CliError('UI_DELIVERY_FAILED', 'Video recording produced no file');
    },
  };
}
