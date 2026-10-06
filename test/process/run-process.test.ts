import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/process/run-process.js';

const node = process.execPath;

describe('runProcess', () => {
  it('sends exact multiline Unicode input on stdin with EOF and excludes it from argv', async () => {
    const input = '第一行\n$HOME; $(false)\n';
    const result = await runProcess(node, ['-e', "const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ args: process.argv.slice(1), input: Buffer.concat(chunks).toString('utf8') })));"], { stdin: input, timeoutMs: 2000 });
    expect(JSON.parse(result.stdout)).toEqual({ args: [], input });
    const empty = await runProcess(node, ['-e', "process.stdin.on('end', () => process.stdout.write('EOF')); process.stdin.resume();"], { stdin: '', timeoutMs: 2000 });
    expect(empty.stdout).toBe('EOF');
  });

  it('does not crash on broken stdin or replace the child nonzero failure', async () => {
    const input = 'private-input'.repeat(100_000);
    const result = await runProcess(node, ['-e', "process.stdin.destroy(); process.stderr.write('rejected'); process.exit(7);"], { stdin: input, timeoutMs: 2000 });
    expect(result).toMatchObject({ exitCode: 7, stderr: 'rejected' });
  });

  it('terminates a stalled reader without including stdin in timeout details', async () => {
    const privateInput = 'PRIVATE_INPUT_0123456789';
    const error = await runProcess(node, ['-e', 'setTimeout(() => {}, 10_000)'], { stdin: privateInput.repeat(100_000), timeoutMs: 20 }).catch(error => error);
    expect(error).toMatchObject({ code: 'PROCESS_TIMEOUT' });
    expect(JSON.stringify(error)).not.toContain(privateInput);
  });

  it('decodes UTF-8 output across byte boundaries', async () => {
    const result = await runProcess(node, ['-e', "const value = Buffer.from('秘密'); process.stdout.write(value.subarray(0, 2)); setTimeout(() => process.stdout.end(value.subarray(2)), 20);"], { timeoutMs: 2000 });
    expect(result.stdout).toBe('秘密');
  });
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
