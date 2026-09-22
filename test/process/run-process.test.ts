import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/process/run-process.js';

const node = process.execPath;

describe('runProcess', () => {
  it('passes every argument as data without shell interpretation', async () => {
    const argumentsToPreserve = ['space value', '"quoted"', '; echo injected', '$HOME', ''];
    const result = await runProcess(node, [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ...argumentsToPreserve,
    ]);

    expect(JSON.parse(result.stdout)).toEqual(argumentsToPreserve);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps child output and nonzero exit status distinct', async () => {
    const result = await runProcess(node, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
    ]);

    expect(result).toMatchObject({ stdout: 'out', stderr: 'err', exitCode: 7, signal: null });
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a timed-out process separately from a process failure', async () => {
    await expect(runProcess(node, ['-e', 'setTimeout(() => {}, 10_000)'], { timeoutMs: 20 }))
      .rejects.toMatchObject({ code: 'PROCESS_TIMEOUT' });
  });

  it('reports a missing executable as TOOL_NOT_FOUND', async () => {
    await expect(runProcess('agemu-test-command-does-not-exist', []))
      .rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
  });

  it('reports caller cancellation after terminating the child', async () => {
    const controller = new AbortController();
    const pending = runProcess(node, ['-e', 'setTimeout(() => {}, 10_000)'], { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT', message: 'Process cancelled' });
  });

  it('preserves a child termination signal', async () => {
    const result = await runProcess(node, ['-e', 'process.kill(process.pid, "SIGTERM")']);

    expect(result).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
  });
});
