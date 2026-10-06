import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../src/commands/server.js';
import { runUiPlan } from '../../src/commands/ui.js';
import { parseArgs } from '../../src/cli/args.js';
import { CommandContext } from '../../src/cli/context.js';
import { loadConfig } from '../../src/config/config.js';
import { deadline, runProcess, type Deadline } from '../../src/process/run-process.js';
const execute = promisify(execFile);
const project = fileURLToPath(new URL('../..', import.meta.url));
let isolated: string;
let cli: string;

beforeAll(async () => {
  isolated = await mkdtemp(path.join(tmpdir(), 'agemu-r010-dist-'));
  // Native acceptance uses root dist concurrently; these process tests own only this isolated build.
  await execute('pnpm', ['exec', 'tsc', '-p', path.join(project, 'tsconfig.json'), '--outDir', path.join(isolated, 'dist')], { cwd: project });
  await copyFile(path.join(project, 'package.json'), path.join(isolated, 'package.json'));
  await symlink(path.join(project, 'node_modules'), path.join(isolated, 'node_modules'), 'dir');
  cli = path.join(isolated, 'dist', 'cli', 'main.js');
}, 30000);
afterAll(async () => { if (isolated) await rm(isolated, { recursive: true, force: true }); });

const inventory = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'PHONE', name: 'Phone', state: 'Booted', isAvailable: true }] } });
type Stage = 'inventory' | 'identity' | 'occupant' | 'parent' | 'project' | 'cumulative' | 'readiness' | 'url-body' | 'none';
async function fixture(stage: Stage) {
  const root = await mkdtemp(path.join(tmpdir(), 'agemu-r010-tools-'));
  const calls = path.join(root, 'calls.jsonl');
  const owned = stage === 'identity' || stage === 'parent' || stage === 'cumulative';
  let closedResponses = 0;
  let listener: Server | undefined;
  let port = 8081;
  if (stage === 'parent' || stage === 'project' || stage === 'readiness' || stage === 'url-body') {
    listener = createServer((request, response) => {
      if ((stage === 'readiness' && request.url === '/status') || (stage === 'url-body' && request.url?.startsWith('/_expo/open'))) {
        response.once('close', () => { closedResponses++; });
        response.write(stage === 'readiness' ? 'packager-status:' : '{"url":');
      } else if (request.url === '/status') response.end('packager-status:running');
      else { response.writeHead(404); response.end(); }
    });
    await new Promise<void>(resolve => listener!.listen(0, '127.0.0.1', resolve));
    port = (listener.address() as { port: number }).port;
  }
  const app = stage === 'inventory' || stage === 'none'
    ? { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }
    : { type: 'expo', root: '.', port, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' };
  await writeFile(path.join(root, '.agemu.json'), JSON.stringify({ version: 2, platform: 'ios', app, simulator: { udid: 'PHONE' } }));
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const shell = (body: string) => `#!/bin/sh
if [ "$1" = --warmup ]; then exit 0; fi
tool="\${0##*/}"
log() { printf '{"executable":"%s","args":["%s"],"pid":%s,"event":"start"}\\n' "$tool" "$*" "$$" >> ${quote(calls)}; }
log "$@"
stalled() {
  trap 'kill "$sleeper" 2>/dev/null; wait "$sleeper" 2>/dev/null; printf "{\\\"pid\\\":%s,\\\"event\\\":\\\"terminated\\\"}\\n" "$$" >> ${quote(calls)}; exit 0' TERM
  /bin/sleep ${stage === 'inventory' ? 10 : 4} &
  sleeper=$!
  wait "$sleeper"
  printf '{"pid":%s,"event":"finished"}\\n' "$$" >> ${quote(calls)}
  printf '%s' "$1"
}
${body}
`;
  const scripts: Record<string, string> = {};
  scripts.xcrun = `
if [ "$2" = list ]; then
  ${stage === 'inventory' ? `stalled ${quote(inventory)}` : `${stage === 'readiness' || stage === 'url-body' ? '/bin/sleep 0.4;' : ''} printf '%s' ${quote(inventory)}`}
fi
if [ "$4" = launchctl ]; then printf 'PID Status Label\\n123 0 UIKitApplication:com.example.app[a]\\n'; fi
`;
  scripts.xcodebuild = 'exit 1';
  const tree = JSON.stringify([{ type: 'Application', AXLabel: 'App', frame: { x: 0, y: 0, width: 400, height: 800 } }]);
  scripts.idb = `
if [ "$2" = describe-all ]; then printf '%s' ${quote(tree)}; fi
if [ "$1" = screenshot ]; then printf screen > "$2"; fi
`;
  scripts.lsof = `
case " $* " in
  *" -t "*) ${stage === 'occupant' || stage === 'cumulative' ? "stalled '4242'" : "printf '4242\\n'"} ;;
  *) ${stage === 'project' ? `stalled ${quote(`n${await realpath(root)}\n`)}` : `printf '%s' ${quote(`n${await realpath(root)}\n`)}`} ;;
esac
`;
  scripts.ps = `
case " $* " in
  *" lstart= "*) ${stage === 'identity' ? "stalled 'Mon Oct  5 12:00:00 2026 node server-child r010-token'" : "printf 'Mon Oct  5 12:00:00 2026 node server-child r010-token\\n'"} ;;
  *) ${stage === 'parent' ? `stalled '${process.pid}'` : `printf '${process.pid}\\n'`} ;;
esac
`;
  await writeFile(path.join(root, 'probe'), shell(`case "$tool" in\n${Object.entries(scripts).map(([name, body]) => `${name})\n${body}\n;;`).join('\n')}\nesac`), { mode: 0o700 });
  await Promise.all(Object.keys(scripts).map(name => symlink('probe', path.join(root, name))));
  // macOS may inspect a new executable for seconds on its first launch. Keep
  // that one-time cost outside deadlines intended to cancel a specific probe.
  await execute(path.join(root, 'probe'), ['--warmup']);
  if (owned) {
    await mkdir(path.join(root, '.agemu'));
    await writeFile(path.join(root, '.agemu', 'server.json'), JSON.stringify({ root: await realpath(root), port, pid: process.pid,
      startedAt: 'Mon Oct  5 12:00:00 2026', token: 'r010-token', command: 'expo start --go', log: path.join(root, '.agemu', 'metro.log') }));
  }
  const env = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` };
  const logs = async (): Promise<Array<{ executable?: string; args?: string[]; pid: number; event: string }>> => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, env, logs, owned, responsesClosed: () => closedResponses, dispose: async () => {
    listener?.closeAllConnections();
    if (listener) await new Promise<void>(resolve => listener!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}
async function timeout(f: Awaited<ReturnType<typeof fixture>>, argv: string[], seconds = 1) {
  const started = performance.now();
  const error = await execute(process.execPath, [cli, ...argv, `--timeout=${seconds}`], { cwd: f.root, env: f.env }).then(() => undefined, error => error);
  expect(error?.code).toBe(1);
  expect(JSON.parse(error.stdout).error.code).toBe('PROCESS_TIMEOUT');
  // Measures actual CLI/child close, not when a Promise.race happens to reject.
  expect(performance.now() - started).toBeLessThan(seconds * 1000 + 2000);
  const entries = await f.logs();
  expect(entries.filter(entry => entry.event === 'finished')).toEqual([]);
  return entries;
}
function expectCancelled(entries: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['logs']>>, executable: string) {
  const start = entries.find(entry => entry.executable === executable && entry.event === 'start')!;
  expect(start).toBeDefined();
  expect(entries).toContainEqual({ pid: start.pid, event: 'terminated' });
  expect(() => process.kill(start.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

describe('production UI preflight cancellation', () => {
  it.each([
    ['run', '--backend=xctest', '--plan-json={"version":1,"actions":[{"tap":{"identifier":"save"}}]}'],
    ['tap', '--id=save', '--backend=xctest'], ['inspect', '--backend=idb'], ['build-runner'],
  ].map(args => [args]))('cancels the real cached inventory process for ui %j', async args => {
    const f = await fixture('inventory');
    try {
      // Give the CLI time to reach inventory under concurrent native builds; the child stalls twice as long.
      // Actual cancellation at the shorter remaining budget is also measured independently below.
      const entries = await timeout(f, ['ui', ...args], 5);
      expectCancelled(entries, 'xcrun');
      expect(entries.filter(entry => entry.event === 'start')).toHaveLength(1);
    } finally { await f.dispose(); }
  }, 15000);

  it('retains one cached inventory across inspection preflight and executor selection', async () => {
    const f = await fixture('none');
    try {
      const result = JSON.parse((await execute(process.execPath, [cli, 'ui', 'inspect', '--backend=idb', '--timeout=5'], { cwd: f.root, env: f.env })).stdout);
      expect(result).toMatchObject({ ok: true, data: { udid: 'PHONE', completed: 2 } });
      expect((await f.logs()).filter(entry => entry.executable === 'xcrun' && entry.args?.[0].startsWith('simctl list'))).toHaveLength(1);
    } finally { await f.dispose(); }
  }, 15000);

  it.each(['identity', 'occupant', 'parent', 'project'] as Stage[])('cancels the real default Expo %s probe without later preflight spawns', async stage => {
    const f = await fixture(stage);
    try {
      const entries = await timeout(f, ['ui', 'launch', '--backend=xctest'], 3);
      const executable = stage === 'identity' || stage === 'parent' ? 'ps' : 'lsof';
      const last = entries.filter(entry => entry.event === 'start').at(-1)!;
      expect(last.executable, JSON.stringify(entries)).toBe(executable);
      expectCancelled(entries.filter(entry => entry.pid === last.pid), executable);
      if (f.owned) expect(JSON.parse(await readFile(path.join(f.root, '.agemu/server.json'), 'utf8')).pid).toBe(process.pid);
    } finally { await f.dispose(); }
  }, 15000);

  it('charges completed inventory and identity work against actual listener cancellation', async () => {
    const f = await fixture('cumulative');
    // Control only elapsed-budget accounting: actual subprocesses still complete or receive SIGTERM.
    // Large early budgets avoid depending on CLI startup/scheduler load to reach a specific later stage.
    let remaining = 30000;
    const limit: Deadline = { ms: 30000, remaining: () => Math.max(1, remaining), expired: () => remaining <= 0 };
    const budgets: Array<{ executable: string; args: string[]; timeoutMs?: number }> = [];
    try {
      const context = new CommandContext(parseArgs(['ui', 'launch']), f.root);
      await expect(runUiPlan(await context.config(), { json: '{"version":1,"actions":[{"launch":{}}]}' }, {
        backend: 'xctest', deadline: limit,
        resolveUdid: async (_config, run) => (await context.device(true, (args, options) => run('xcrun', ['simctl', ...args], options))).udid,
        run: async (executable, args, options) => {
          budgets.push({ executable, args, timeoutMs: options?.timeoutMs });
          try {
            const result = await runProcess(executable, args, { ...options, cwd: f.root, env: f.env });
            if (executable === 'xcrun') remaining -= 20000;
            if (executable === 'ps') remaining -= 9000;
            return result;
          } catch (error) { remaining = 0; throw error; }
        },
      })).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT' });
      expect(budgets).toEqual([
        { executable: 'xcrun', args: ['simctl', 'list', '--json'], timeoutMs: 30000 },
        { executable: 'ps', args: ['-p', String(process.pid), '-o', 'lstart=', '-o', 'command='], timeoutMs: 2000 },
        { executable: 'lsof', args: ['-nP', '-t', '-iTCP:8081', '-sTCP:LISTEN'], timeoutMs: 1000 },
      ]);
      const entries = await f.logs();
      expectCancelled(entries, 'lsof');
      expect(entries.filter(entry => entry.event === 'finished')).toEqual([]);
      expect(entries.filter(entry => entry.event === 'start').map(entry => entry.executable)).toEqual(['xcrun', 'ps', 'lsof']);
    } finally { await f.dispose(); }
  }, 15000);

  it.each(['url-body'] as Stage[])('aborts the actual Expo %s response at the UI deadline', async stage => {
    const f = await fixture(stage);
    try {
      await timeout(f, ['ui', 'launch', '--backend=xctest'], 3);
      // The remote end sees connection cancellation, including after headers were delivered.
      await expect.poll(f.responsesClosed, { timeout: 1000 }).toBe(1);
      expect((await f.logs()).filter(entry => entry.executable === 'idb' || entry.executable === 'xcodebuild')).toEqual([]);
    } finally { await f.dispose(); }
  }, 15000);
  it('aborts default readiness HTTP and propagates deadline expiry before project inspection', async () => {
    const f = await fixture('readiness');
    const probes: string[][] = [];
    try {
      await expect(server(await loadConfig(f.root), 'status', { deadline: deadline(400), run: async (_executable, args) => {
        probes.push(args);
        return { stdout: '4242', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 0 };
      } })).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT' });
      // Socket close delivery can occur on the next poll phase after request.destroy().
      await expect.poll(f.responsesClosed, { timeout: 1000 }).toBe(1);
      expect(probes).toHaveLength(1);
    } finally { await f.dispose(); }
  }, 15000);

  it('does not start any production status probe after its deadline has expired', async () => {
    const f = await fixture('occupant');
    let probes = 0;
    try {
      await expect(server(await loadConfig(f.root), 'status', { deadline: deadline(0), run: async () => {
        probes++; throw new Error('must not spawn');
      } })).rejects.toMatchObject({ code: 'PROCESS_TIMEOUT' });
      expect(probes).toBe(0);
    } finally { await f.dispose(); }
  });

});
