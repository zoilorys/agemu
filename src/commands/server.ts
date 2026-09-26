import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import path from 'node:path';
import { type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { runProcess } from '../process/run-process.js';

type State = { root: string; port: number; pid: number; startedAt: string; token: string; command: string; log: string };
type Action = 'start' | 'status' | 'stop';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statePath = (root: string) => path.join(root, '.agemu', 'server.json');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function processIdentity(pid: number): Promise<{ command: string; startedAt: string } | undefined> {
  try {
    const result = await runProcess('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { timeoutMs: 2000 });
    const line = result.stdout.trim();
    const match = line.match(/^(.{24})\s+(.+)$/);
    return result.exitCode === 0 && match ? { startedAt: match[1].trim(), command: match[2] } : undefined;
  } catch { return undefined; }
}
async function occupant(port: number): Promise<number | undefined> {
  try {
    const result = await runProcess('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 2000 });
    const pids = [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
    return pids.length === 1 ? pids[0] : pids.length > 1 ? -1 : undefined;
  } catch { return undefined; }
}
async function childOf(pid: number, parent: number): Promise<boolean> {
  try { const result = await runProcess('ps', ['-p', String(pid), '-o', 'ppid='], { timeoutMs: 2000 }); return Number(result.stdout.trim()) === parent; }
  catch { return false; }
}
async function projectOf(pid: number): Promise<string | undefined> {
  try {
    const result = await runProcess('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeoutMs: 2000 });
    return result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
  } catch { return undefined; }
}
async function ready(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const request = get(`http://127.0.0.1:${port}/status`, { timeout: 800 }, response => {
      let body = '';
      response.on('data', chunk => { body = (body + chunk.toString()).slice(-128); });
      response.on('end', () => resolve(response.statusCode === 200 && body.trim() === 'packager-status:running'));
    });
    request.once('error', () => resolve(false));
    request.once('timeout', () => { request.destroy(); resolve(false); });
  });
}
async function owned(state: State): Promise<boolean> {
  if (!alive(state.pid)) return false;
  const identity = await processIdentity(state.pid);
  return Boolean(identity && identity.startedAt === state.startedAt && identity.command.includes(state.token) && identity.command.includes('server-child'));
}
async function readState(file: string): Promise<State | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as State; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new CliError('CONFIG_INVALID', 'Invalid Metro server state'); }
}
async function removeState(file: string, state: State): Promise<void> {
  const current = await readState(file);
  if (current?.token === state.token) await rm(file, { force: true });
}
export async function server(config: LoadedConfig, action: Action) {
  if (config.app.type !== 'react-native') throw new CliError('WORKFLOW_UNSUPPORTED', 'server requires a react-native app');
  const app = config.app;
  const root = await realpath(app.root).catch(() => { throw new CliError('CONFIG_INVALID', 'React Native app root does not exist'); });
  const file = statePath(config.root);
  let state = await readState(file);
  if (state && !(await owned(state))) { await removeState(file, state); state = undefined; }
  if (state && (state.root !== root || state.port !== app.port)) {
    if (action === 'stop' && state.root === root) {
      process.kill(state.pid, 'SIGTERM');
      for (let i = 0; i < 30 && alive(state.pid); i++) await sleep(100);
      if (alive(state.pid)) throw new CliError('PROCESS_FAILED', 'Metro did not stop after SIGTERM');
      await removeState(file, state);
      return { stopped: true, port: state.port };
    }
    throw new CliError('PROCESS_FAILED', `An agemu-owned Metro server is still running for ${state.root} on port ${state.port}; stop it before changing the project or port`);
  }
  const portPid = await occupant(app.port);
  const isReady = portPid !== undefined && await ready(app.port);
  const ownPort = Boolean(state && portPid !== undefined && (portPid === state.pid || await childOf(portPid, state.pid)));
  const matchingExternal = Boolean(portPid && portPid > 0 && !ownPort && isReady && await projectOf(portPid) === root);
  if (action === 'status') return { running: isReady && (ownPort || matchingExternal), owned: ownPort, port: app.port, ...(portPid !== undefined && !ownPort && !matchingExternal ? { collision: true } : {}), ...(ownPort && state ? { pid: state.pid, log: path.relative(config.root, state.log) } : {}) };
  if (action === 'stop') {
    if (!state || !ownPort) return { stopped: false, reason: portPid === undefined ? 'no server' : 'server is not owned by agemu' };
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 30 && alive(state.pid); i++) await sleep(100);
    if (alive(state.pid)) throw new CliError('PROCESS_FAILED', 'Metro did not stop after SIGTERM');
    await removeState(file, state);
    return { stopped: true, port: app.port };
  }
  if (portPid !== undefined) {
    if (ownPort && isReady) return { running: true, owned: true, reused: true, port: app.port, pid: state!.pid };
    if (matchingExternal) return { running: true, owned: false, reused: true, port: app.port };
    throw new CliError('PROCESS_FAILED', `Port ${app.port} is occupied by a server whose project identity cannot be verified`);
  }
  if (state) throw new CliError('PROCESS_FAILED', `An agemu-owned Metro supervisor is running without a ready listener on port ${app.port}; stop it before starting another`);
  const cli = path.join(root, 'node_modules', 'react-native', 'cli.js');
  try { await access(cli); } catch { throw new CliError('TOOL_NOT_FOUND', 'Local React Native CLI is missing; install project dependencies'); }
  const directory = path.join(config.root, '.agemu');
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const log = path.join(directory, 'metro.log');
  const secretsFile = path.join(directory, `server-redactions-${token}.json`);
  await writeFile(secretsFile, JSON.stringify(config.redactions ?? []), { mode: 0o600, flag: 'wx' });
  let supervisor = new URL('../process/server-child.js', import.meta.url).pathname;
  try { await access(supervisor); } catch { supervisor = path.resolve(path.dirname(supervisor), '../../dist/process/server-child.js'); }
  const child = spawn(process.execPath, [supervisor, token, root, String(app.port), cli, log, secretsFile], { cwd: root, detached: true, stdio: 'ignore' });
  if (!child.pid) throw new CliError('PROCESS_FAILED', 'Unable to spawn Metro');
  child.unref();
  let identity: Awaited<ReturnType<typeof processIdentity>>;
  for (let i = 0; i < 20 && !identity; i++) { await sleep(50); identity = await processIdentity(child.pid); }
  if (!identity || !identity.command.includes(token)) throw new CliError('PROCESS_FAILED', 'Metro supervisor exited during startup');
  state = { root, port: app.port, pid: child.pid, startedAt: identity.startedAt, token, command: `react-native start --port ${app.port}`, log };
  const temporary = `${file}.${token}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  for (let i = 0; i < 300; i++) {
    if (!(await owned(state))) { await removeState(file, state); throw new CliError('PROCESS_FAILED', 'Metro exited before readiness', { log: path.relative(config.root, log) }); }
    const listener = await occupant(app.port);
    if (listener !== undefined && (listener === state.pid || await childOf(listener, state.pid)) && await ready(app.port)) return { running: true, owned: true, reused: false, port: app.port, pid: state.pid, log: path.relative(config.root, log) };
    if (listener !== undefined && listener !== state.pid && !(await childOf(listener, state.pid))) break;
    await sleep(100);
  }
  if (await owned(state)) process.kill(state.pid, 'SIGTERM');
  await removeState(file, state);
  throw new CliError('PROCESS_FAILED', redact(`Metro did not become ready on port ${app.port}; inspect ${log}`, config.redactions));
}
