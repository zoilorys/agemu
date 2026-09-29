#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { errorResult, writeResult } from '../core/output.js';
import { CliError } from '../core/errors.js';
import { loadConfig } from '../config/config.js';
import { doctor } from '../doctor/doctor.js';
import { bootDevice, listDevices, resolveDevice, shutdownDevice } from '../native/simctl.js';
import { buildApp } from '../commands/build.js';
import { controlApp, type AppAction } from '../commands/app.js';
import { diagnose, observe, showLogs } from '../commands/diagnostics.js';
import { buildUiRunner, runUiPlan } from '../commands/ui.js';
import { helpFor } from './help.js';
import { setup } from '../commands/setup.js';
import { server } from '../commands/server.js';
import { parseArgs, value, values, type ParsedArgs } from './args.js';

const args = process.argv.slice(2);
const packageVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
// Output style must be known even when parsing fails.
let pretty = args.includes('--pretty');
let debug = args.includes('--debug');

const limitOption = (parsed: ParsedArgs): number | undefined => {
  const limit = value(parsed, 'limit');
  if (limit === undefined) return undefined;
  if (!/^\d+$/.test(limit)) throw new CliError('COMMAND_INVALID', '--limit must be an integer from 0 to 10000');
  return Number(limit);
};

const nonEmpty = (parsed: ParsedArgs, name: string, code: 'COMMAND_INVALID' | 'UI_VALIDATION_FAILED'): string | undefined => {
  const given = value(parsed, name);
  if (given !== undefined && given.length === 0) throw new CliError(code, `--${name} requires a non-empty value`);
  return given;
};

try {
  const parsed = parseArgs(args);
  ({ pretty, debug } = parsed.globals);
  const { command, subcommand } = parsed;
  if (parsed.globals.help) {
    writeResult({ ok: true, data: { help: helpFor(command) } }, pretty);
  } else if (parsed.globals.version) {
    writeResult({ ok: true, data: { version: packageVersion } }, pretty);
  } else if (!command) {
    throw new CliError('COMMAND_INVALID', 'A command is required');
  } else {
    let data: unknown;
    if (command === 'setup') {
      data = await setup(process.cwd(), true, parsed.flags.has('expo-go'), { udid: nonEmpty(parsed, 'udid', 'COMMAND_INVALID') });
    } else if (command === 'config') {
      const config = await loadConfig();
      const { root: _, redactions: __, ...safe } = config;
      data = safe;
    } else if (command === 'simulator' && subcommand === 'list') {
      data = { devices: await listDevices() };
    } else if (command === 'simulator') {
      const explicitUdid = nonEmpty(parsed, 'udid', 'COMMAND_INVALID');
      const explicitName = nonEmpty(parsed, 'name', 'COMMAND_INVALID');
      const explicitRuntime = nonEmpty(parsed, 'runtime', 'COMMAND_INVALID');
      if (explicitRuntime !== undefined && explicitName === undefined) throw new CliError('COMMAND_INVALID', '--runtime requires --name');
      const config = await loadConfig();
      const selector = explicitUdid
        ? { udid: explicitUdid }
        : config.simulator.udid
          ? { udid: config.simulator.udid }
          : explicitName
            ? { name: explicitName, ...(explicitRuntime ? { runtime: explicitRuntime } : {}) }
            : config.simulator;
      const device = resolveDevice(await listDevices(), selector);
      const action = subcommand === 'boot' ? 'boot' : 'shutdown';
      const controlled = action === 'boot' ? await bootDevice(device) : await shutdownDevice(device);
      data = { action, device: controlled };
    } else if (command === 'observe') {
      data = await observe(await loadConfig());
    } else if (command === 'ui' && subcommand === 'build-runner') {
      data = await buildUiRunner(await loadConfig(), {}, true);
    } else if (command === 'ui') {
      const plan = nonEmpty(parsed, 'plan', 'UI_VALIDATION_FAILED');
      const planJson = nonEmpty(parsed, 'plan-json', 'UI_VALIDATION_FAILED');
      if (plan !== undefined && planJson !== undefined) throw new CliError('UI_VALIDATION_FAILED', 'Use either --plan or --plan-json');
      if (plan === undefined && planJson === undefined) throw new CliError('UI_VALIDATION_FAILED', 'ui run requires --plan or --plan-json');
      const backend = value(parsed, 'backend');
      if (backend !== undefined && !['auto', 'idb', 'xctest'].includes(backend)) {
        throw new CliError('UI_VALIDATION_FAILED', 'UI backend must be auto, idb, or xctest');
      }
      const source = planJson !== undefined ? { json: planJson } : { file: path.resolve(plan!) };
      data = await runUiPlan(await loadConfig(), source, { backend: backend as 'auto' | 'idb' | 'xctest' | undefined });
    } else if (command === 'build') {
      data = await buildApp(await loadConfig());
    } else if (command === 'server') {
      data = await server(await loadConfig(), subcommand as 'start' | 'status' | 'stop');
    } else if (command === 'app') {
      data = await controlApp(await loadConfig(), subcommand as AppAction, {
        arguments: values(parsed, 'arg'),
        environment: values(parsed, 'env'),
        url: value(parsed, 'url'),
      });
    } else if (command === 'logs') {
      const options = { last: value(parsed, 'last'), level: value(parsed, 'level'), limit: limitOption(parsed) };
      data = await showLogs(await loadConfig(), options);
    } else if (command === 'diagnose') {
      const options = { last: value(parsed, 'last'), level: value(parsed, 'level'), limit: limitOption(parsed) };
      data = await diagnose(await loadConfig(), options);
    } else if (command === 'doctor') {
      data = await doctor();
    } else throw new CliError('COMMAND_INVALID', `Unknown command: ${command}`);
    writeResult({ ok: true, data }, pretty);
  }
} catch (error) { writeResult(errorResult(error, debug), pretty); process.exitCode = 1; }
