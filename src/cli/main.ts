#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { errorResult, writeResult, type Result } from '../core/output.js';
import { redact } from '../core/redact.js';
import { CliError } from '../core/errors.js';
import { loadConfig, targetBundleId, type LoadedConfig } from '../config/config.js';
import { appendEvent, redactValue } from '../artifacts/runs.js';
import { doctor } from '../doctor/doctor.js';
import { bootDevice, listDevices, resolveDevice, shutdownDevice } from '../native/simctl.js';
import { buildApp } from '../commands/build.js';
import { controlApp, requireUninstallable, type AppAction } from '../commands/app.js';
import { requireYes } from '../native/simctl-commands.js';
import { privacy, type PrivacyAction } from '../commands/privacy.js';
import { push } from '../commands/push.js';
import { location, type LocationAction } from '../commands/location.js';
import { simulatorUi, statusBar } from '../commands/simulator-settings.js';
import { diagnose, observe, showLogs } from '../commands/diagnostics.js';
import { buildUiRunner, runUiPlan } from '../commands/ui.js';
import { clean } from '../commands/clean.js';
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

const timeoutOption = (parsed: ParsedArgs): number | undefined => {
  const seconds = value(parsed, 'timeout');
  if (seconds === undefined) return undefined;
  if (!/^\d+$/.test(seconds) || Number(seconds) < 1 || Number(seconds) > 86_400) {
    throw new CliError('COMMAND_INVALID', '--timeout must be whole seconds from 1 to 86400');
  }
  return Number(seconds) * 1000;
};

const nonEmpty =(parsed: ParsedArgs, name: string, code: 'COMMAND_INVALID' | 'UI_VALIDATION_FAILED'): string | undefined => {
  const given = value(parsed, name);
  if (given !== undefined && given.length === 0) throw new CliError(code, `--${name} requires a non-empty value`);
  return given;
};

// Commands whose invocations are recorded here; observe, logs show, and diagnose record their own events.
const recorded = new Set([
  'build', 'app install', 'app launch', 'app terminate', 'app restart', 'app open-url', 'app uninstall',
  'privacy grant', 'privacy revoke', 'privacy reset', 'push',
  'location set', 'location clear', 'location run',
  'server start', 'server status', 'server stop', 'simulator boot', 'simulator shutdown', 'simulator ui', 'simulator status-bar', 'ui build-runner', 'ui run', 'clean',
]);
const durationUnits: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const summaryKeys = ['run', 'udid', 'bundleId', 'backend', 'action'];

const summarize = (result: unknown): Record<string, unknown> => {
  if (!result || typeof result !== 'object') return {};
  const source = result as Record<string, unknown>;
  return Object.fromEntries(summaryKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
};

// Redactions of the loaded config; the envelope writer applies them as a safety net.
let secrets: string[] = [];
const configured = async (): Promise<LoadedConfig> => {
  const config = await loadConfig();
  secrets = config.redactions ?? [];
  return config;
};
const emit = (result: Result<unknown>): void => {
  if (!secrets.length) return writeResult(result, pretty);
  if (result.ok) return writeResult({ ok: true, data: redactValue(result.data, secrets) }, pretty);
  const { code, message, details, stack } = result.error;
  writeResult({ ok: false, error: {
    code,
    message: redact(message, secrets),
    ...(details ? { details: redactValue(details, secrets) } : {}),
    ...(stack ? { stack: redact(stack, secrets) } : {}),
  } }, pretty);
};

const safeAppend = async (config: LoadedConfig, event: Record<string, unknown>): Promise<void> => {
  try { await appendEvent(config.root, event, config.redactions ?? []); } catch { /* Recording never alters the command outcome. */ }
};

const withConfig = async (key: string, handler: (config: LoadedConfig) => Promise<unknown>): Promise<unknown> => {
  const config = await configured();
  if (!recorded.has(key)) return handler(config);
  const startedAt = new Date();
  const at = startedAt.toISOString();
  let result: unknown;
  try {
    result = await handler(config);
  } catch (error) {
    const normalized = errorResult(error, false);
    const { code, message, details } = normalized.ok ? { code: 'PROCESS_FAILED', message: '', details: undefined } : normalized.error;
    const { result: _, ...kept } = details ?? {};
    await safeAppend(config, {
      at, command: key, status: 'error', durationMs: Date.now() - startedAt.getTime(), error: { code, message },
      ...(details ? { details: kept } : {}),
    });
    throw error;
  }
  await safeAppend(config, { at, command: key, status: 'ok', durationMs: Date.now() - startedAt.getTime(), summary: summarize(result) });
  return result;
};

try {
  const parsed = parseArgs(args);
  ({ pretty, debug } = parsed.globals);
  const { command, subcommand } = parsed;
  const key = subcommand ? `${command} ${subcommand}` : command ?? '';
  if (parsed.globals.help) {
    writeResult({ ok: true, data: { help: helpFor(command) } }, pretty);
  } else if (parsed.globals.version) {
    writeResult({ ok: true, data: { version: packageVersion } }, pretty);
  } else if (!command) {
    throw new CliError('COMMAND_INVALID', 'A command is required');
  } else {
    let data: unknown;
    if (command === 'setup') {
      const portText = value(parsed, 'port');
      if (portText !== undefined && (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535)) {
        throw new CliError('COMMAND_INVALID', '--port must be an integer from 1 to 65535');
      }
      const port = portText === undefined ? undefined : Number(portText);
      data = await setup(process.cwd(), true, parsed.flags.has('expo-go'), { udid: nonEmpty(parsed, 'udid', 'COMMAND_INVALID'), port });
    } else if (command === 'config') {
      const config = await configured();
      const { root: _, redactions: __, ...safe } = config;
      data = safe;
    } else if (command === 'simulator' && subcommand === 'list') {
      data = { devices: await listDevices() };
    } else if (command === 'simulator') {
      const explicitUdid = nonEmpty(parsed, 'udid', 'COMMAND_INVALID');
      const explicitName = nonEmpty(parsed, 'name', 'COMMAND_INVALID');
      const explicitRuntime = nonEmpty(parsed, 'runtime', 'COMMAND_INVALID');
      if (explicitRuntime !== undefined && explicitName === undefined) throw new CliError('COMMAND_INVALID', '--runtime requires --name');
      data = await withConfig(key, async (config) => {
        const selector = explicitUdid
          ? { udid: explicitUdid }
          : config.simulator.udid
            ? { udid: config.simulator.udid }
            : explicitName
              ? { name: explicitName, ...(explicitRuntime ? { runtime: explicitRuntime } : {}) }
              : config.simulator;
        const device = resolveDevice(await listDevices(), selector);
        const secretValues = config.redactions ?? [];
        if (subcommand === 'ui') {
          return simulatorUi(device, {
            appearance: value(parsed, 'appearance'), contentSize: value(parsed, 'content-size'), increaseContrast: value(parsed, 'increase-contrast'),
          }, secretValues);
        }
        if (subcommand === 'status-bar') {
          return statusBar(device, {
            clear: parsed.flags.has('clear'), preset: value(parsed, 'preset'), time: value(parsed, 'time'),
            dataNetwork: value(parsed, 'data-network'), wifiMode: value(parsed, 'wifi-mode'), wifiBars: value(parsed, 'wifi-bars'),
            cellularMode: value(parsed, 'cellular-mode'), cellularBars: value(parsed, 'cellular-bars'), operatorName: value(parsed, 'operator-name'),
            batteryState: value(parsed, 'battery-state'), batteryLevel: value(parsed, 'battery-level'),
          }, secretValues);
        }
        const action = subcommand === 'boot' ? 'boot' : 'shutdown';
        const controlled = action === 'boot' ? await bootDevice(device) : await shutdownDevice(device);
        return { action, device: controlled };
      });
    } else if (command === 'observe') {
      data = await withConfig(key, (config) => observe(config));
    } else if (command === 'ui' && subcommand === 'build-runner') {
      const timeoutMs = timeoutOption(parsed);
      data = await withConfig(key, (config) => buildUiRunner(config, { timeoutMs }, true));
    } else if (command === 'ui') {
      const plan = nonEmpty(parsed, 'plan', 'UI_VALIDATION_FAILED');
      const planJson = nonEmpty(parsed, 'plan-json', 'UI_VALIDATION_FAILED');
      if (plan !== undefined && planJson !== undefined) throw new CliError('UI_VALIDATION_FAILED', 'Use either --plan or --plan-json');
      if (plan === undefined && planJson === undefined) throw new CliError('UI_VALIDATION_FAILED', 'ui run requires --plan or --plan-json');
      const backend = value(parsed, 'backend');
      if (backend !== undefined && !['auto', 'idb', 'xctest'].includes(backend)) {
        throw new CliError('UI_VALIDATION_FAILED', 'UI backend must be auto, idb, or xctest');
      }
      const timeoutMs = timeoutOption(parsed);
      const source = planJson !== undefined ? { json: planJson } : { file: path.resolve(plan!) };
      data = await withConfig(key, (config) => runUiPlan(config, source, { backend: backend as 'auto' | 'idb' | 'xctest' | undefined, timeoutMs }));
    } else if (command === 'build') {
      const timeoutMs = timeoutOption(parsed);
      data = await withConfig(key, (config) => buildApp(config, { timeoutMs }));
    } else if (command === 'server') {
      data = await withConfig(key, (config) => server(config, subcommand as 'start' | 'status' | 'stop'));
    } else if (command === 'app' && subcommand === 'uninstall') {
      data = await withConfig(key, async (config) => {
        requireUninstallable(config);
        requireYes(parsed.flags.has('yes'), `This removes ${targetBundleId(config)} and its data from Simulator ${config.simulator.udid ?? config.simulator.name}`);
        return controlApp(config, 'uninstall');
      });
    } else if (command === 'app') {
      data = await withConfig(key, (config) => controlApp(config, subcommand as AppAction, {
        arguments: values(parsed, 'arg'),
        environment: values(parsed, 'env'),
        url: value(parsed, 'url'),
      }));
    } else if (command === 'privacy') {
      const service = nonEmpty(parsed, 'service', 'COMMAND_INVALID');
      data = await withConfig(key, (config) => privacy(config, subcommand as PrivacyAction, { service, allApps: parsed.flags.has('all-apps') }));
    } else if (command === 'push') {
      const payload = value(parsed, 'payload');
      const payloadJson = value(parsed, 'payload-json');
      data = await withConfig(key, (config) => push(config, { payload, payloadJson }));
    } else if (command === 'location') {
      const coordinate = nonEmpty(parsed, 'coordinate', 'COMMAND_INVALID');
      const scenario = nonEmpty(parsed, 'scenario', 'COMMAND_INVALID');
      data = await withConfig(key, (config) => location(config, subcommand as LocationAction, { coordinate, scenario }));
    } else if (command === 'logs') {
      const options = { last: value(parsed, 'last'), level: value(parsed, 'level'), limit: limitOption(parsed) };
      data = await showLogs(await configured(), options);
    } else if (command === 'diagnose') {
      const options = { last: value(parsed, 'last'), level: value(parsed, 'level'), limit: limitOption(parsed) };
      data = await diagnose(await configured(), options);
    } else if (command === 'clean') {
      const runs = parsed.flags.has('runs');
      const derivedData = parsed.flags.has('derived-data');
      if (!runs && !derivedData) throw new CliError('COMMAND_INVALID', 'clean requires --runs, --derived-data, or both');
      const olderThan = value(parsed, 'older-than');
      let olderThanMs: number | undefined;
      if (olderThan !== undefined) {
        if (!runs) throw new CliError('COMMAND_INVALID', '--older-than requires --runs');
        const match = /^(\d+)([smhd])$/.exec(olderThan);
        if (!match) throw new CliError('COMMAND_INVALID', '--older-than must be a number followed by s, m, h, or d (for example, 7d)');
        olderThanMs = Number(match[1]) * durationUnits[match[2]];
      }
      data = await withConfig(key, (config) => clean(config, { runs, derivedData, olderThanMs, dryRun: parsed.flags.has('dry-run') }));
    } else if (command === 'doctor') {
      data = await doctor();
    } else throw new CliError('COMMAND_INVALID', `Unknown command: ${command}`);
    emit({ ok: true, data });
  }
} catch (error) { emit(errorResult(error, debug)); process.exitCode = 1; }
