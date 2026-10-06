import type { LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { requireBooted, runSimctl, selectedDevice, type SimctlDeps } from '../native/simctl-commands.js';

export type LocationAction = 'set' | 'clear' | 'list' | 'run';

const coordinatePattern = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const expected = 'Expected --coordinate=LAT,LON without spaces (latitude -90 to 90, longitude -180 to 180), for example 37.3349,-122.0090';

function validCoordinate(input: string | undefined): string {
  if (!input) throw new CliError('COMMAND_INVALID', `--coordinate is required. ${expected}`);
  const match = coordinatePattern.exec(input);
  if (!match) throw new CliError('COMMAND_INVALID', `Invalid coordinate "${input}". ${expected}`);
  if (Math.abs(Number(match[1])) > 90 || Math.abs(Number(match[2])) > 180) {
    throw new CliError('COMMAND_INVALID', `Coordinate "${input}" is out of range. ${expected}`);
  }
  return input;
}

// simctl prints a "Name   Description" table with an "=====" separator; names may contain spaces.
// Without a Description header, each non-empty line is one name.
export function parseScenarios(stdout: string): string[] {
  const lines = stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  const offset = lines.length > 0 ? lines[0].search(/\bDescription\b/) : -1;
  if (offset < 0) return lines.map((line) => line.trim());
  return lines.slice(1).filter((line) => !/^=+$/.test(line.trim()))
    .map((line) => line.slice(0, offset).trim()).filter(Boolean);
}

export async function location(
  config: LoadedConfig, action: LocationAction, options: { coordinate?: string; scenario?: string }, deps: SimctlDeps = {},
) {
  const coordinate = action === 'set' ? validCoordinate(options.coordinate) : undefined;
  if (action === 'run' && !options.scenario) throw new CliError('COMMAND_INVALID', '--scenario is required; see agemu location list');
  const device = await selectedDevice(config, deps);
  requireBooted(device);
  const secrets = config.redactions ?? [];
  const scenarios = async () => parseScenarios((await runSimctl(['location', device.udid, 'list'], secrets, deps)).stdout);

  if (action === 'list') return { udid: device.udid, scenarios: await scenarios() };
  if (action === 'clear') {
    await runSimctl(['location', device.udid, 'clear'], secrets, deps);
    return { action, udid: device.udid };
  }
  if (action === 'set') {
    await runSimctl(['location', device.udid, 'set', coordinate!], secrets, deps);
    return { action, udid: device.udid, coordinate };
  }
  const scenario = options.scenario!;
  const available = await scenarios();
  if (!available.includes(scenario)) {
    throw new CliError('COMMAND_INVALID', `Unknown scenario "${scenario}"; available scenarios: ${available.join(', ')}`, { scenarios: available });
  }
  await runSimctl(['location', device.udid, 'run', scenario], secrets, deps);
  return { action, udid: device.udid, scenario };
}
