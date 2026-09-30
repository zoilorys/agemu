import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { CliError } from '../core/errors.js';

export type Recording = { stop: () => Promise<void> };
export type RecordingStarter = (udid: string, file: string) => Promise<Recording>;

export async function createRecordingBridge(udid: string, directory: string, root: string, start: RecordingStarter) {
  const recordings: string[] = [];
  let active: Recording | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') throw new Error('Unsupported recording request');
      if (request.url?.startsWith('/start?')) {
        if (active) throw new Error('A video recording is already active');
        const name = new URL(request.url, 'http://localhost').searchParams.get('name')?.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'video';
        const file = path.join(directory, `${recordings.length + 1}-${name}.mp4`);
        active = await start(udid, file);
        recordings.push(path.relative(root, file));
      } else if (request.url === '/stop') {
        if (!active) throw new Error('No video recording is active');
        const recording = active;
        active = undefined;
        await recording.stop();
      } else throw new Error('Unsupported recording request');
      response.writeHead(200).end('ok');
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recording bridge has no port');
  return {
    port: address.port,
    recordings,
    close: async () => {
      server.close();
      if (active) await active.stop();
    },
  };
}

export async function startVideoRecording(udid: string, file: string): Promise<Recording> {
  const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
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
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('simctl recordVideo did not start within 10 seconds')), 10_000); }),
  ]).catch(error => {
    child.kill('SIGINT');
    throw new CliError('UI_DELIVERY_FAILED', `Unable to start video recording: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => { if (timer) clearTimeout(timer); });
  return {
    stop: async () => {
      child.kill('SIGINT');
      let stopTimer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        ended,
        new Promise<never>((_, reject) => {
          stopTimer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new CliError('UI_DELIVERY_FAILED', 'Video recording did not stop within 10 seconds'));
          }, 10_000);
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
