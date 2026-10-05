import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import path from 'node:path';
import { type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { runProcess, type Deadline } from '../process/run-process.js';

type State = { root: string; port: number; pid: number; startedAt: string; token: string; command: string; log: string };
type Action = 'start' | 'status' | 'stop';
export type ServerResult = {
  running?: boolean; owned?: boolean; port?: number; pid?: number; log?: string;
  collision?: boolean; reused?: boolean; stopped?: boolean; reason?: string;
};
export type ServerDependencies = { processIdentity?: typeof processIdentity; run?: typeof runProcess; deadline?: Deadline };
type StatusProbes = { run: typeof runProcess; deadline?: Deadline };
function statusTimeout(limit: Deadline) { return new CliError('PROCESS_TIMEOUT', `Server status exceeded ${limit.ms / 1000} s`, { timeoutSeconds: limit.ms / 1000 }); }
function checkStatusDeadline(probes?: StatusProbes): void { if (probes?.deadline?.expired()) throw statusTimeout(probes.deadline); }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statePath = (root: string) => path.join(root, '.agemu', 'server.json');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function processOutput(executable: string, args: string[], probes?: StatusProbes): Promise<string | undefined> {
  try {
    checkStatusDeadline(probes);
    const result = await (probes?.run ?? runProcess)(executable, args, { timeoutMs: Math.min(2000, probes?.deadline?.remaining() ?? 2000) });
    checkStatusDeadline(probes);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch (error) {
    if (probes?.deadline && error instanceof CliError && error.code === 'PROCESS_TIMEOUT') {
      const { result: _, ...details } = error.details ?? {};
      throw new CliError(error.code, error.message, details);
    }
    checkStatusDeadline(probes);
    return undefined;
  }
}
async function processIdentity(pid: number, probes?: StatusProbes): Promise<{ command: string; startedAt: string } | undefined> {
  const output = await processOutput('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], probes);
  const match = output?.match(/^(.{24})\s+(.+)$/);
  return match ? { startedAt: match[1].trim(), command: match[2] } : undefined;
}
async function occupant(port: number, probes?: StatusProbes): Promise<number | undefined> {
  const output = await processOutput('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], probes);
  const pids = [...new Set((output ?? '').split(/\s+/).filter(Boolean).map(Number))];
  return pids.length === 1 && Number.isSafeInteger(pids[0]) && pids[0] > 0 ? pids[0] : pids.length > 0 ? -1 : undefined;
}
async function childOf(pid: number, parent: number, probes?: StatusProbes): Promise<boolean> {
  return Number(await processOutput('ps', ['-p', String(pid), '-o', 'ppid='], probes)) === parent;
}
async function projectOf(pid: number, probes?: StatusProbes): Promise<string | undefined> {
  return (await processOutput('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], probes))?.split('\n').find(line => line.startsWith('n'))?.slice(1);
}
async function ready(port: number, probes?: StatusProbes): Promise<boolean> {
  checkStatusDeadline(probes);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value: boolean, error?: CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); request.destroy();
      if (error) reject(error); else resolve(value);
    };
    const request = get(`http://127.0.0.1:${port}/status`, response => {
      let body = '';
      response.on('data', chunk => { body = (body + chunk.toString()).slice(-128); });
      response.once('end', () => {
        if (probes?.deadline?.expired()) settle(false, statusTimeout(probes.deadline));
        else settle(response.statusCode === 200 && body.trim() === 'packager-status:running');
      });
      response.once('error', () => settle(false));
    });
    const timer = setTimeout(() => settle(false, probes?.deadline?.expired() ? statusTimeout(probes.deadline) : undefined), Math.min(800, probes?.deadline?.remaining() ?? 800));
    request.once('error', () => settle(false));
  });
}
async function owned(state: State, inspect: typeof processIdentity = processIdentity): Promise<boolean> {
  if (!alive(state.pid)) return false;
  const identity = await inspect(state.pid);
  if (!identity) throw new CliError('PROCESS_FAILED', 'Cannot inspect the running server supervisor; check ps permissions and retry');
  return identity.startedAt === state.startedAt && identity.command.includes(state.token) && identity.command.includes('server-child');
}
async function readState(file: string): Promise<State | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid state');
    const state = value as State;
    if (!['root', 'startedAt', 'token', 'command', 'log'].every(key => typeof (value as Record<string, unknown>)[key] === 'string' && (value as Record<string, string>)[key].length > 0)
      || !Number.isSafeInteger(state.pid) || state.pid <= 0 || !Number.isSafeInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error('invalid state');
    return state;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new CliError('CONFIG_INVALID', 'Invalid Metro server state'); }
}
async function removeState(file: string, state: State): Promise<void> {
  const current = await readState(file);
  if (current?.token === state.token) await rm(file, { force: true });
}
async function stopOwned(file: string, state: State, inspect: typeof processIdentity) {
  // Recheck immediately before signalling: the PID may have changed during listener inspection.
  if (!(await owned(state, inspect))) {
    await removeState(file, state);
    return { stopped: false, reason: 'server is not owned by agemu' };
  }
  try { process.kill(state.pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  for (let i = 0; i < 30 && alive(state.pid); i++) await sleep(100);
  if (alive(state.pid)) throw new CliError('PROCESS_FAILED', 'Metro did not stop after SIGTERM');
  await removeState(file, state);
  return { stopped: true, port: state.port };
}
export async function server(config: LoadedConfig, action: Action, dependencies: ServerDependencies = {}): Promise<ServerResult> {
  // Only status accepts a caller deadline; start/stop retain their existing ownership and lifecycle budgets.
  const probes = action === 'status' ? { run: dependencies.run ?? runProcess, deadline: dependencies.deadline } : undefined;
  checkStatusDeadline(probes);
  const inspect = dependencies.processIdentity ?? ((pid: number) => processIdentity(pid, probes));
  if (config.app.type !== 'react-native' && config.app.type !== 'expo') throw new CliError('WORKFLOW_UNSUPPORTED', 'server requires a React Native or Expo app');
  const app = config.app;
  const root = await realpath(app.root).catch(() => { throw new CliError('CONFIG_INVALID', 'React Native app root does not exist'); });
  const file = statePath(config.root);
  let state = await readState(file);
  if (state && !(await owned(state, inspect))) { await removeState(file, state); state = undefined; }
  if (state && action !== 'stop' && (state.command.startsWith('expo ') !== (app.type === 'expo') || (app.type === 'expo' && state.command.includes('--go') !== (app.launchTarget === 'expo-go')))) throw new CliError('PROCESS_FAILED', 'A different agemu-owned project server is running; stop it before switching workflow');
  if (state && (state.root !== root || state.port !== app.port)) {
    if (action === 'stop' && state.root === root) {
      return stopOwned(file, state, inspect);
    }
    throw new CliError('PROCESS_FAILED', `An agemu-owned Metro server is still running for ${state.root} on port ${state.port}; stop it before changing the project or port`);
  }
  const portPid = await occupant(app.port, probes);
  const isReady = portPid !== undefined && await ready(app.port, probes);
  const ownPort = Boolean(state && portPid !== undefined && (portPid === state.pid || await childOf(portPid, state.pid, probes)));
  const matchingExternal = Boolean(portPid && portPid > 0 && !ownPort && isReady && await projectOf(portPid, probes) === root);
  checkStatusDeadline(probes);
  if (action === 'status') return { running: isReady && (ownPort || matchingExternal), owned: ownPort, port: app.port, ...(portPid !== undefined && !ownPort && !matchingExternal ? { collision: true } : {}), ...(ownPort && state ? { pid: state.pid, log: path.relative(config.root, state.log) } : {}) };
  if (action === 'stop') {
    if (!state) return { stopped: false, reason: portPid === undefined ? 'no server' : 'server is not owned by agemu' };
    return stopOwned(file, state, inspect);
  }
  if (portPid !== undefined) {
    if (ownPort && isReady) return { running: true, owned: true, reused: true, port: app.port, pid: state!.pid };
    if (matchingExternal) return { running: true, owned: false, reused: true, port: app.port };
    throw new CliError('PROCESS_FAILED', `Port ${app.port} is occupied by a server whose project identity cannot be verified`);
  }
  if (state) throw new CliError('PROCESS_FAILED', `An agemu-owned Metro supervisor is running without a ready listener on port ${app.port}; stop it before starting another`);
  const cli = app.type === 'expo' ? path.join(root, 'node_modules', 'expo', 'bin', 'cli') : path.join(root, 'node_modules', 'react-native', 'cli.js');
  try { await access(cli); } catch { throw new CliError('TOOL_NOT_FOUND', 'Local project CLI is missing; install project dependencies'); }
  const directory = path.join(config.root, '.agemu');
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const log = path.join(directory, 'metro.log');
  const secretsFile = path.join(directory, `server-redactions-${token}.json`);
  await writeFile(secretsFile, JSON.stringify(config.redactions ?? []), { mode: 0o600, flag: 'wx' });
  let supervisor = new URL('../process/server-child.js', import.meta.url).pathname;
  try { await access(supervisor); } catch { supervisor = path.resolve(path.dirname(supervisor), '../../dist/process/server-child.js'); }
  const child = spawn(process.execPath, [supervisor, token, root, String(app.port), cli, log, secretsFile, ...(app.type === 'expo' ? [app.launchTarget === 'expo-go' ? 'go' : 'dev-client'] : [])], { cwd: root, detached: true, stdio: 'ignore' });
  if (!child.pid) throw new CliError('PROCESS_FAILED', 'Unable to spawn Metro');
  child.unref();
  let identity: Awaited<ReturnType<typeof processIdentity>>;
  for (let i = 0; i < 20 && !identity; i++) { await sleep(50); identity = await processIdentity(child.pid); }
  if (!identity || !identity.command.includes(token)) throw new CliError('PROCESS_FAILED', 'Metro supervisor exited during startup');
  state = { root, port: app.port, pid: child.pid, startedAt: identity.startedAt, token, command: app.type === 'expo' ? `expo start --${app.launchTarget === 'expo-go' ? 'go' : 'dev-client'} --port ${app.port}` : `react-native start --port ${app.port}`, log };
  const temporary = `${file}.${token}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  for (let i = 0; i < 300; i++) {
    if (!(await owned(state, inspect))) { await removeState(file, state); throw new CliError('PROCESS_FAILED', 'Metro exited before readiness', { log: path.relative(config.root, log) }); }
    const listener = await occupant(app.port);
    if (listener !== undefined && (listener === state.pid || await childOf(listener, state.pid)) && await ready(app.port)) return { running: true, owned: true, reused: false, port: app.port, pid: state.pid, log: path.relative(config.root, log) };
    if (listener !== undefined && listener !== state.pid && !(await childOf(listener, state.pid))) break;
    await sleep(100);
  }
  if (await owned(state, inspect)) process.kill(state.pid, 'SIGTERM');
  await removeState(file, state);
  throw new CliError('PROCESS_FAILED', redact(`Metro did not become ready on port ${app.port}; inspect ${log}`, config.redactions));
}
