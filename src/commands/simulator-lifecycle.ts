import { CliError } from '../core/errors.js';
import { listDevices as defaultListDevices, shutdownDevice, simctl, type Device } from '../native/simctl.js';
import { requireYes, runSimctl, type SimctlDeps } from '../native/simctl-commands.js';

const invalid = (message: string) => new CliError('COMMAND_INVALID', message);
const devicesOf = (deps: SimctlDeps) => (deps.listDevices ?? (() => defaultListDevices(deps.runner ?? simctl)))();

type DeviceType = { name: string; identifier: string };
type Runtime = { name?: string; identifier: string; version?: string; isAvailable: boolean };

async function listJson(kind: 'devicetypes' | 'runtimes', secrets: string[], deps: SimctlDeps): Promise<unknown[]> {
  const { stdout } = await runSimctl(['list', kind, '--json'], secrets, deps);
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new CliError('PROCESS_FAILED', `simctl returned invalid ${kind} JSON`); }
  const entries = (parsed as Record<string, unknown> | null)?.[kind];
  if (!Array.isArray(entries)) throw new CliError('PROCESS_FAILED', `simctl returned invalid ${kind} JSON`);
  return entries.filter((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { identifier?: unknown }).identifier === 'string');
}

const isIosRuntime = (runtime: Runtime) => runtime.isAvailable && /SimRuntime\.iOS-/.test(runtime.identifier);

export type CreateOptions = { name?: string; deviceType?: string; runtime?: string };

export async function createSimulator(options: CreateOptions, secrets: string[], deps: SimctlDeps = {}) {
  if (!options.name) throw invalid('create requires --name');
  if (!options.deviceType) throw invalid('create requires --device-type');
  const wanted = options.deviceType;
  const types = (await listJson('devicetypes', secrets, deps) as DeviceType[]).filter((type) => typeof type.name === 'string');
  const type = types.find((candidate) => candidate.name === wanted || candidate.identifier === wanted);
  if (!type) {
    const close = types.filter((candidate) => candidate.name.toLowerCase().includes(wanted.toLowerCase())).slice(0, 10).map((candidate) => candidate.name);
    throw new CliError('COMMAND_INVALID', `Unknown device type: ${wanted}${close.length ? `. Close matches: ${close.join(', ')}` : ''}`, { closeMatches: close });
  }
  const args = ['create', options.name, type.identifier];
  if (options.runtime !== undefined) {
    const wantedRuntime = options.runtime;
    const runtimes = (await listJson('runtimes', secrets, deps) as Runtime[]).filter(isIosRuntime);
    const runtime = runtimes.find((candidate) => [candidate.identifier, candidate.name, candidate.version].includes(wantedRuntime));
    if (!runtime) {
      const available = runtimes.map((candidate) => candidate.name ?? candidate.identifier);
      throw invalid(`Unknown or unavailable iOS runtime: ${wantedRuntime}. Available: ${available.join(', ') || 'none'}`);
    }
    args.push(runtime.identifier);
  }
  const udid = (await runSimctl(args, secrets, deps)).stdout.trim();
  const device = (await devicesOf(deps)).find((candidate) => candidate.udid === udid);
  if (!device) throw new CliError('PROCESS_FAILED', `Created Simulator ${udid} is not listed as an available iOS device`, { udid });
  return { created: device };
}

export async function deleteSimulator(udid: string | undefined, yes: boolean, secrets: string[], deps: SimctlDeps = {}, configuredUdid?: string) {
  if (!udid) throw invalid('delete requires --udid; it never infers the device');
  const device = (await devicesOf(deps)).find((candidate) => candidate.udid === udid);
  if (!device) throw new CliError('SIMULATOR_NOT_FOUND', `No available Simulator has UDID ${udid}`, { udid });
  requireYes(yes, `This permanently deletes Simulator ${device.name} (${udid}) and all its data`);
  if (device.state !== 'Shutdown') await shutdownDevice(device, deps.runner ?? simctl);
  await runSimctl(['delete', udid], secrets, deps);
  return { deleted: udid, ...(configuredUdid === udid ? { warning: 'This was the configured Simulator' } : {}) };
}

export async function eraseSimulator(device: Device, yes: boolean, secrets: string[], deps: SimctlDeps = {}) {
  requireYes(yes, `This erases all content and settings of Simulator ${device.name} (${device.udid})`);
  const shutDown = device.state !== 'Shutdown';
  if (shutDown) await shutdownDevice(device, deps.runner ?? simctl);
  await runSimctl(['erase', device.udid], secrets, deps);
  return { erased: device.udid, udid: device.udid, shutDown };
}
