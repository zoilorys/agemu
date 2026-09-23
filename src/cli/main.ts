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

const args = process.argv.slice(2);
const packageVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const pretty = args.includes('--pretty');
const debug = args.includes('--debug');
const command = args.find((arg) => !arg.startsWith('--'));
const option = (name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const requiredString = (name: string): string => {
  const value = option(name);
  if (value === undefined || value.length === 0 || (args.includes(`--${name}`) && value.startsWith('--'))) {
    throw new CliError('UI_VALIDATION_FAILED', `--${name} requires a non-empty value`);
  }
  return value;
};
if (args.includes('--help')) {
  writeResult({ ok: true, data: { help: helpFor(command) } }, pretty);
}
else if (args.includes('--version')) {
  writeResult({ ok: true, data: { version: packageVersion } }, pretty);
} else if (!command) {
  writeResult(errorResult(new CliError('COMMAND_INVALID', 'A command is required'), debug), pretty);
  process.exitCode = 1;
} else try {
  let data: unknown;
  if (command === 'setup') {
    data = await setup();
  } else if (command === 'config' && args.includes('show')) {
    const config = await loadConfig();
    const { root: _, redactions: __, ...safe } = config;
    data = safe;
  } else if (command === 'simulator' && args.includes('list')) {
    data = { devices: await listDevices() };
  } else if (command === 'simulator' && (args.includes('boot') || args.includes('shutdown'))) {
    const config = await loadConfig();
    const explicitUdid = args.find((arg) => arg.startsWith('--udid='))?.slice('--udid='.length);
    const explicitName = args.find((arg) => arg.startsWith('--name='))?.slice('--name='.length);
    const explicitRuntime = args.find((arg) => arg.startsWith('--runtime='))?.slice('--runtime='.length);
    const selector = explicitUdid
      ? { udid: explicitUdid }
      : config.simulator.udid
        ? { udid: config.simulator.udid }
        : explicitName
          ? { name: explicitName, ...(explicitRuntime ? { runtime: explicitRuntime } : {}) }
          : config.simulator;
    const device = resolveDevice(await listDevices(), selector);
    const action = args.includes('boot') ? 'boot' : 'shutdown';
    const controlled = action === 'boot' ? await bootDevice(device) : await shutdownDevice(device);
    data = { action, device: controlled };
  } else if (command === 'observe') {
    data = await observe(await loadConfig());
  } else if (command === 'ui') {
    const plan = args.includes('run') ? path.resolve(requiredString('plan')) : undefined;
    const config = await loadConfig();
    if (args.includes('build-runner')) data = await buildUiRunner(config, {}, true);
    else if (plan) data = await runUiPlan(config, plan);
    else throw new CliError('COMMAND_INVALID', 'ui requires build-runner or run --plan=<file>');
  } else if (command === 'build') {
    const config = await loadConfig();
    data = await buildApp(config);
  } else if (command === 'app') {
    const config = await loadConfig();
    const action = (['install', 'launch', 'terminate', 'restart', 'open-url'] as AppAction[]).find((name) => args.includes(name));
    if (!action) throw new Error('app requires install, launch, terminate, or restart');
    data = await controlApp(config, action, {
      arguments: args.filter((arg) => arg.startsWith('--arg=')).map((arg) => arg.slice('--arg='.length)),
      environment: args.filter((arg) => arg.startsWith('--env=')).map((arg) => arg.slice('--env='.length)),
      url: args.find((arg) => arg.startsWith('--url='))?.slice('--url='.length),
    });
  } else if (command === 'logs') {
    const config = await loadConfig();
    if (!args.includes('show')) throw new CliError('COMMAND_INVALID', 'logs requires show');
    data = await showLogs(config, {
      last: option('last'), level: option('level'), limit: option('limit') === undefined ? undefined : Number(option('limit')),
    });
  } else if (command === 'diagnose') {
    const config = await loadConfig();
    data = await diagnose(config, {
      last: option('last'), level: option('level'), limit: option('limit') === undefined ? undefined : Number(option('limit')),
    });
  } else if (command === 'doctor') {
    data = await doctor();
  } else throw new CliError('COMMAND_INVALID', `Unknown command: ${command}`);
  writeResult({ ok: true, data }, pretty);
} catch (error) { writeResult(errorResult(error, debug), pretty); process.exitCode = 1; }
