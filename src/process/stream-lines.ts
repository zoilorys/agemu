import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

type Readable = { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown; destroy?(): unknown };
export type StreamChild = {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal: NodeJS.Signals): boolean;
  unref?(): void;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};
export type StreamSpawn = (executable: string, args: string[]) => StreamChild;
export type StreamOptions = {
  durationMs: number;
  onLine: (line: string) => boolean | void;
  spawn?: StreamSpawn;
  /** Time between SIGINT and SIGKILL. */
  graceMs?: number;
  /** Time after SIGKILL to wait for 'close' before resolving anyway. */
  killWaitMs?: number;
};
export type StreamResult = {
  stoppedBy: 'duration' | 'until' | 'exit';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

const defaultSpawn: StreamSpawn = (executable, args) => nodeSpawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });

// Bounded: resolves no later than durationMs + graceMs + killWaitMs after spawn.
export function streamLines(executable: string, args: string[], options: StreamOptions): Promise<StreamResult> {
  const graceMs = options.graceMs ?? 2_000;
  const killWaitMs = options.killWaitMs ?? 1_000;
  return new Promise<StreamResult>((resolve, reject) => {
    let child: StreamChild;
    try { child = (options.spawn ?? defaultSpawn)(executable, args); }
    catch (error) { reject(error); return; }
    let stoppedBy: StreamResult['stoppedBy'] | undefined;
    let settled = false;
    let partial = '';
    let stderr = '';
    // One decoder per pipe keeps a multi-byte character split across chunks intact.
    const stdoutText = new StringDecoder('utf8');
    const stderrText = new StringDecoder('utf8');
    let failure: unknown;
    const timers: NodeJS.Timeout[] = [];
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // A grandchild (the in-Simulator log process) may hold the pipes open; release them so Node can exit.
      try { child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.(); } catch { /* best effort */ }
      if (failure !== undefined) reject(failure);
      else resolve({ stoppedBy: stoppedBy ?? 'exit', exitCode, signal, stderr });
    };
    const stop = (reason: StreamResult['stoppedBy']) => {
      if (stoppedBy || settled) return;
      stoppedBy = reason;
      try { child.kill('SIGINT'); } catch { /* already gone */ }
      timers.push(setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        timers.push(setTimeout(() => finish(null, 'SIGKILL'), killWaitMs));
      }, graceMs));
    };
    const deliver = (line: string) => {
      if (stoppedBy || settled) return;
      try { if (options.onLine(line) === true) stop('until'); }
      catch (error) { failure = error; stop('exit'); }
    };
    child.stdout?.on('data', (chunk) => {
      if (stoppedBy || settled) return;
      const lines = (partial + (typeof chunk === 'string' ? chunk : stdoutText.write(chunk))).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) deliver(line);
    });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += typeof chunk === 'string' ? chunk : stderrText.write(chunk); });
    child.once('error', (error) => { if (!stoppedBy) failure = error; finish(null, null); });
    child.once('close', (code, signal) => {
      partial += stdoutText.end();
      if (partial) { deliver(partial); partial = ''; }
      finish(code, signal);
    });
    timers.push(setTimeout(() => stop('duration'), options.durationMs));
  });
}
