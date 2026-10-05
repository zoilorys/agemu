import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUiPlan } from '../../src/commands/ui.js';
import { loadConfig } from '../../src/config/config.js';
import type { Deadline } from '../../src/process/run-process.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-deadline-'));
  roots.push(root);
  await writeFile(path.join(root, '.agemu.json'), JSON.stringify({ version: 2, platform: 'ios',
    app: { type: 'expo', root: '.', port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' },
    simulator: { udid: 'PHONE' }, redactions: ['secret-token'] }));
  const cancellation = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(cancellation.signal);
  // Force cancellation to win before an elapsed-time check or the independent project request timer.
  const limit: Deadline = { ms: 30000, remaining: () => 30000, expired: () => false };
  const run = vi.fn(async () => { throw new Error('backend must not start'); });
  return { config: await loadConfig(root), cancellation, limit, run };
}
const source = { json: '{"version":1,"actions":[{"launch":{}}]}' };

describe('Expo UI deadline error precedence', () => {
  it.each(['request', 'body'])('reports authoritative deadline cancellation when %s rejects first', async phase => {
    const f = await fixture();
    let signal: AbortSignal | undefined;
    const fail = () => {
      f.cancellation.abort(new DOMException('UI deadline elapsed', 'TimeoutError'));
      throw new DOMException('The operation was aborted', 'AbortError');
    };
    const request: typeof fetch = async (_input, options) => {
      signal = options?.signal ?? undefined;
      if (phase === 'request') return fail();
      const response = new Response('{"url":');
      vi.spyOn(response, 'json').mockImplementation(async () => fail());
      return response;
    };
    await expect(runUiPlan(f.config, source, { run: f.run, deadline: f.limit, backend: 'xctest',
      serverStatus: async () => ({ running: true }), request })).rejects.toMatchObject({
      code: 'PROCESS_TIMEOUT', details: { timeoutSeconds: 30, failedAction: null },
    });
    expect(signal?.aborted).toBe(true);
    expect(f.limit.expired()).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(['request', 'body'])('preserves an early %s network failure and redacts its evidence', async phase => {
    const f = await fixture();
    const fail = () => { throw new Error('network failed secret-token'); };
    const request: typeof fetch = async () => {
      if (phase === 'request') return fail();
      const response = new Response('{"url":');
      vi.spyOn(response, 'json').mockImplementation(async () => fail());
      return response;
    };
    const error = await runUiPlan(f.config, source, { run: f.run, deadline: f.limit, backend: 'xctest',
      serverStatus: async () => ({ running: true }), request }).catch(error => error);
    expect(error).toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('network failed') });
    expect(error.message).not.toContain('secret-token');
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect(f.cancellation.signal.aborted).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('preserves a foreign abort before the UI deadline', async () => {
    const f = await fixture();
    await expect(runUiPlan(f.config, source, { run: f.run, deadline: f.limit, backend: 'xctest',
      serverStatus: async () => ({ running: true }), request: async () => {
        throw new DOMException('External cancellation', 'AbortError');
      } })).rejects.toMatchObject({ code: 'PROCESS_FAILED', message: expect.stringContaining('External cancellation') });
    expect(f.cancellation.signal.aborted).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('preserves an earlier project-request timeout rather than attributing it to the UI deadline', async () => {
    const f = await fixture();
    await expect(runUiPlan(f.config, source, { run: f.run, deadline: f.limit, backend: 'xctest',
      requestTimeoutMs: 10, serverStatus: async () => ({ running: true }),
      request: async (_input, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Request cancelled', 'AbortError')), { once: true });
      }),
    })).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT', details: { timeoutMs: 10 },
      message: expect.stringContaining('timed out after 10ms') });
    expect(f.cancellation.signal.aborted).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });
});
