import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamLines, type StreamChild } from '../../src/process/stream-lines.js';

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  unref = vi.fn();
  signals: NodeJS.Signals[] = [];
  constructor(private readonly exitOn: NodeJS.Signals[] = []) { super(); }
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitOn.includes(signal)) void Promise.resolve().then(() => this.emit('close', null, signal));
    return true;
  }
}

const spawnOf = (child: FakeChild) => () => child as unknown as StreamChild;

describe('streamLines', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reassembles lines split across chunks and stops with SIGINT when onLine returns true', async () => {
    const child = new FakeChild(['SIGINT']);
    const seen: string[] = [];
    const result = streamLines('x', [], { durationMs: 30_000, spawn: spawnOf(child), onLine: (line) => { seen.push(line); return line.includes('READY'); } });
    child.stdout.emit('data', Buffer.from('alpha\r\nbe'));
    child.stdout.emit('data', 'ta\nRE');
    child.stdout.emit('data', 'ADY now\nafter match\n');
    await expect(result).resolves.toMatchObject({ stoppedBy: 'until' });
    expect(seen).toEqual(['alpha', 'beta', 'READY now']);
    expect(child.signals).toEqual(['SIGINT']);
  });

  it('stops at the duration and escalates to SIGKILL, resolving within the 3 s grace even without close', async () => {
    const child = new FakeChild();
    let settled = false;
    const result = streamLines('x', [], { durationMs: 5_000, spawn: spawnOf(child), onLine: () => false });
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGINT']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(settled).toBe(false);
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    await expect(result).resolves.toMatchObject({ stoppedBy: 'duration', signal: 'SIGKILL' });
    // Pipes held open by a surviving grandchild must not keep the CLI alive.
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
  });

  it('rejects and sends SIGINT when onLine throws', async () => {
    const child = new FakeChild(['SIGINT']);
    const result = streamLines('x', [], { durationMs: 30_000, spawn: spawnOf(child), onLine: () => { throw new Error('disk full'); } });
    child.stdout.emit('data', 'line\n');
    await expect(result).rejects.toThrow('disk full');
    expect(child.signals).toEqual(['SIGINT']);
  });

  it('reports an early exit with its code, stderr, and the final unterminated line', async () => {
    const child = new FakeChild();
    const seen: string[] = [];
    const result = streamLines('x', [], { durationMs: 30_000, spawn: spawnOf(child), onLine: (line) => { seen.push(line); } });
    child.stdout.emit('data', 'last line');
    child.stderr.emit('data', 'Invalid device');
    child.emit('close', 148, null);
    await expect(result).resolves.toEqual({ stoppedBy: 'exit', exitCode: 148, signal: null, stderr: 'Invalid device' });
    expect(seen).toEqual(['last line']);
    expect(child.signals).toEqual([]);
  });

  it('rejects when the executable cannot be spawned', async () => {
    const child = new FakeChild();
    const result = streamLines('x', [], { durationMs: 30_000, spawn: spawnOf(child), onLine: () => false });
    child.emit('error', new Error('spawn x ENOENT'));
    await expect(result).rejects.toThrow('ENOENT');
  });
});
