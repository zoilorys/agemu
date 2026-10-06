import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRun } from '../artifacts/runs.js';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { requireBooted, runSimctl, selectedDevice, type SimctlDeps } from '../native/simctl-commands.js';

export const maxPushBytes = 4096;

const invalid = (message: string) => new CliError('COMMAND_INVALID', message);

export async function push(config: LoadedConfig, options: { payload?: string; payloadJson?: string }, deps: SimctlDeps = {}) {
  if ((options.payload === undefined) === (options.payloadJson === undefined)) throw invalid('push requires exactly one of --payload or --payload-json');
  let text: string;
  if (options.payloadJson !== undefined) text = options.payloadJson;
  else {
    try { text = await readFile(path.resolve(options.payload!), 'utf8'); }
    catch (error) { throw invalid(`Unable to read payload file: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw invalid(`Payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(parsed)) throw invalid('Payload must be a JSON object');
  if (!isObject(parsed.aps)) throw invalid('Payload must contain an "aps" object');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxPushBytes) throw invalid(`Payload is ${bytes} bytes; the limit is ${maxPushBytes}`);

  const device = await selectedDevice(config, deps);
  requireBooted(device);
  const bundleId = targetBundleId(config);
  const run = await createRun(config.root);
  // The device must receive the real payload, so this file is not redacted.
  const file = path.join(run.directory, 'push.json');
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  await runSimctl(['push', device.udid, bundleId, file], config.redactions ?? [], deps);
  return { udid: device.udid, bundleId, run: run.relativeDirectory, payload: path.relative(config.root, file), bytes };
}
