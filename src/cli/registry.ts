import { existsSync } from 'node:fs';
import path from 'node:path';
import { recordCommand } from '../artifacts/runs.js';
import { targetBundleId } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { commandResult, type CommandTarget } from '../core/command-result.js';
import { parseCaptureDuration, parseUntil } from '../core/log-options.js';
import { doctor } from '../doctor/doctor.js';
import { bootDevice, listDevices, shutdownDevice } from '../native/simctl.js';
import { requireYes } from '../native/simctl-commands.js';
import { buildApp } from '../commands/build.js';
import { controlApp, reloadApp, requireUninstallable, type AppAction } from '../commands/app.js';
import { appStatus, listInstalledApps } from '../commands/app-status.js';
import { clipboard, type ClipboardAction } from '../commands/clipboard.js';
import { privacy, type PrivacyAction } from '../commands/privacy.js';
import { push } from '../commands/push.js';
import { location, type LocationAction } from '../commands/location.js';
import { addMedia, simulatorUi, statusBar } from '../commands/simulator-settings.js';
import { createSimulator, deleteSimulator, eraseSimulator } from '../commands/simulator-lifecycle.js';
import { diagnose, observe, showLogs, streamLogs } from '../commands/diagnostics.js';
import { captureJsLogs } from '../commands/js-logs.js';
import { buildUiRunner, inspectScreen, runUiPlan, validatePlan, actionDefinitions, type UiPlan, type UiActionKind, type UiDependencies } from '../commands/ui.js';
import { portableRegexDescription } from '../commands/ui-regex.js';
import { clean } from '../commands/clean.js';
import { listCrashes } from '../commands/crashes.js';
import { setup } from '../commands/setup.js';
import { server } from '../commands/server.js';
import { CommandContext } from './context.js';
import { cleanOptions, launchEnvironment, numberOption, timeoutOption, validateFlags, value, values } from './options.js';
import type { FlagSpec, ParsedArgs } from './types.js';

export const runtimes = ['native', 'react-native', 'expo-development-build', 'expo-go'] as const;
export type Runtime = typeof runtimes[number];
const built = runtimes.filter(runtime => runtime !== 'expo-go');
const javascript = runtimes.filter(runtime => runtime !== 'native');
export type CommandDefinition = {
  key: string; description: string; flags: Record<string, FlagSpec>;
  configuration: 'required' | 'optional' | 'none'; recording: 'boundary' | 'handler' | 'none';
  target: CommandTarget; runtimes: readonly Runtime[]; destructive?: boolean;
  prepare?: (parsed: ParsedArgs) => UiPlan | void;
  handler: (context: CommandContext, parsed: ParsedArgs, prepared?: UiPlan | void) => Promise<unknown>;
};
const single: FlagSpec = { kind: 'value' };
const boolean: FlagSpec = { kind: 'boolean' };
const repeat: FlagSpec = { kind: 'repeat' };
const nonEmpty: FlagSpec = { ...single, nonEmpty: true };
const selector = { udid: nonEmpty, name: nonEmpty, runtime: nonEmpty };
const backend: FlagSpec = { ...single, choices: ['auto', 'idb', 'xctest'], errorCode: 'UI_VALIDATION_FAILED', message: 'UI backend must be auto, idb, or xctest' };
const timeout = (defaultSeconds: number): FlagSpec => ({ ...single, integer: { min: 1, max: 86400, default: defaultSeconds, unit: 'seconds' }, message: '--timeout must be whole seconds from 1 to 86400' });
const limit = (min: number, max: number, defaultValue: number): FlagSpec => ({ ...single, integer: { min, max, default: defaultValue } });
const logOptions = { last: single, since: single, level: { ...single, choices: ['default', 'info', 'debug', 'error', 'fault'], message: '--level must be default, info, debug, error, or fault' } satisfies FlagSpec, limit: limit(0, 10000, 100) };
const launchOptions = { arg: repeat, env: repeat };
const uiOptions = { backend, timeout: timeout(900) };
function definition(key: string, description: string, flags: Record<string, FlagSpec>, handler: CommandDefinition['handler'], overrides: Partial<Omit<CommandDefinition, 'key' | 'description' | 'flags' | 'handler'>> = {}): CommandDefinition {
  return { key, description, flags, handler, configuration: 'required', recording: 'boundary', target: 'app', runtimes, ...overrides };
}
const independent = { configuration: 'none', recording: 'none', target: 'none' } as const;
function validateSelector(parsed: ParsedArgs) {
  if (value(parsed, 'runtime') !== undefined && value(parsed, 'name') === undefined) throw new CliError('COMMAND_INVALID', '--runtime requires --name');
}
const logs = (parsed: ParsedArgs) => ({ last: value(parsed, 'last'), since: value(parsed, 'since'), level: value(parsed, 'level'), limit: numberOption(parsed, 'limit') });
function validateLogs(parsed: ParsedArgs) {
  if (value(parsed, 'last') !== undefined && value(parsed, 'since') !== undefined) throw new CliError('COMMAND_INVALID', 'Use either --since or --last');
}
function validateCapture(parsed: ParsedArgs) { parseCaptureDuration(value(parsed, 'duration')); parseUntil(value(parsed, 'until')); }
const uiDependencies = (context: CommandContext, parsed: ParsedArgs) => ({
  resolveUdid: async (_config: unknown, run: NonNullable<UiDependencies['run']>) =>
    (await context.device(true, (args, options) => run('xcrun', ['simctl', ...args], options))).udid,
  backend: value(parsed, 'backend') as 'auto' | 'idb' | 'xctest' | undefined, timeoutMs: timeoutOption(parsed),
});

const baseDefinitions: CommandDefinition[] = [
  definition('setup', 'Create .agemu.json for this project.', { 'expo-go': boolean, udid: nonEmpty, port: { ...single, integer: { min: 1, max: 65535, default: 8081 } } },
    (context, parsed) => setup(context.root, true, parsed.flags.has('expo-go'), { udid: value(parsed, 'udid'), port: numberOption(parsed, 'port') }), independent),
  definition('config show', 'Show the resolved app configuration.', {}, async context => { const { root: _, redactions: __, ...safe } = await context.config(); return safe; }, { target: 'none', recording: 'none' }),
  definition('simulator list', 'List available simulators.', {}, async () => ({ devices: await listDevices() }), independent),
  ...(['boot', 'shutdown'] as const).map(action => definition(`simulator ${action}`, action === 'boot' ? 'Boot the selected simulator.' : 'Shut down the selected simulator.', selector,
    async context => ({ action, device: await (action === 'boot' ? bootDevice : shutdownDevice)(await context.device()) }), { target: 'device', prepare: validateSelector })),
  definition('simulator ui', 'Read or set appearance, content size, and contrast.', { ...selector, appearance: single, 'content-size': single, 'increase-contrast': single },
    async (context, parsed) => simulatorUi(await context.device(), { appearance: value(parsed, 'appearance'), contentSize: value(parsed, 'content-size'), increaseContrast: value(parsed, 'increase-contrast') }, context.secrets), { target: 'device', prepare: validateSelector }),
  definition('simulator status-bar', 'Override or clear the status bar.', { ...selector, clear: boolean, preset: single, time: single, 'data-network': single, 'wifi-mode': single, 'wifi-bars': single, 'cellular-mode': single, 'cellular-bars': single, 'operator-name': single, 'battery-state': single, 'battery-level': single },
    async (context, parsed) => statusBar(await context.device(), { clear: parsed.flags.has('clear'), preset: value(parsed, 'preset'), time: value(parsed, 'time'), dataNetwork: value(parsed, 'data-network'), wifiMode: value(parsed, 'wifi-mode'), wifiBars: value(parsed, 'wifi-bars'), cellularMode: value(parsed, 'cellular-mode'), cellularBars: value(parsed, 'cellular-bars'), operatorName: value(parsed, 'operator-name'), batteryState: value(parsed, 'battery-state'), batteryLevel: value(parsed, 'battery-level') }, context.secrets), { target: 'device', prepare: validateSelector }),
  definition('simulator add-media', 'Import photos, videos, or contacts.', { ...selector, file: repeat }, async (context, parsed) => addMedia(await context.device(), values(parsed, 'file'), context.secrets), { target: 'device', prepare: validateSelector }),
  definition('simulator create', 'Create a Simulator.', { name: nonEmpty, 'device-type': single, runtime: single }, async (_context, parsed) => createSimulator({ name: value(parsed, 'name'), deviceType: value(parsed, 'device-type'), runtime: value(parsed, 'runtime') }, []), { ...independent, target: 'device' }),
  definition('simulator delete', 'Delete a Simulator and all its data (requires --yes).', { udid: nonEmpty, yes: boolean }, async (context, parsed) => {
    const config = await context.config().catch(() => undefined);
    return deleteSimulator(value(parsed, 'udid'), parsed.flags.has('yes'), context.secrets, {}, config?.simulator.udid);
  }, { configuration: 'optional', target: 'device', destructive: true }),
  definition('simulator erase', 'Erase Simulator content and settings (requires --yes).', { ...selector, yes: boolean }, async (context, parsed) => {
    requireYes(parsed.flags.has('yes'), 'This erases all Simulator content and settings');
    return eraseSimulator(await context.device(), true, context.secrets);
  }, { configuration: 'optional', target: 'device', destructive: true, prepare: parsed => {
    validateSelector(parsed);
    if (!existsSync(path.join(process.cwd(), '.agemu.json')) && !value(parsed, 'udid')) throw new CliError('COMMAND_INVALID', 'simulator erase without .agemu.json requires --udid');
  } }),
  definition('build', 'Build the configured iOS app.', { timeout: timeout(1800) }, async (context, parsed) => buildApp(await context.config(), { timeoutMs: timeoutOption(parsed), resolveUdid: async () => (await context.config()).simulator.udid ?? (await context.device()).udid }), { runtimes: built }),
  ...(['start', 'status', 'stop'] as const).map(action => definition(`server ${action}`, action === 'start' ? "Start or reuse this project's Metro or Expo server." : action === 'status' ? 'Inspect server readiness and ownership.' : 'Stop an agemu-owned server.', {}, async context => server(await context.config(), action), { runtimes: javascript, target: 'none' })),
  ...(['install', 'launch', 'terminate', 'restart', 'open-url', 'uninstall'] as AppAction[]).map(action => definition(`app ${action}`, ({ install: 'Install the built app.', launch: 'Launch the configured app.', terminate: 'Stop the configured app.', restart: 'Stop and relaunch the app.', 'open-url': 'Open a URL in Simulator.', uninstall: 'Remove the app and its data (requires --yes).' })[action],
    action === 'launch' || action === 'restart' ? launchOptions : action === 'open-url' ? { url: { ...nonEmpty, required: true } } : action === 'uninstall' ? { yes: boolean } : {},
    async (context, parsed) => {
      const config = await context.config();
      if (action === 'uninstall') {
        requireUninstallable(config);
        requireYes(parsed.flags.has('yes'), `This removes ${targetBundleId(config)} and its data from Simulator ${config.simulator.udid ?? config.simulator.name}`);
      }
      return controlApp(config, action, { arguments: values(parsed, 'arg'), environment: values(parsed, 'env'), url: value(parsed, 'url') }, context.appDependencies());
    }, { ...(action === 'uninstall' ? { destructive: true } : {}), ...(action === 'install' || action === 'uninstall' ? { runtimes: built } : {}), prepare: parsed => { launchEnvironment(parsed); } })),
  definition('app status', 'Report running app/PID and unavailable foreground state.', {}, async context => appStatus(await context.config(), context.simulatorDependencies())),
  definition('app reload', 'Request a reload from the verified project Metro server.', {}, async context => reloadApp(await context.config(), context.simulatorDependencies()), { runtimes: javascript }),
  definition('app list', 'List installed apps on the selected Simulator.', {}, async context => listInstalledApps(await context.config(), context.simulatorDependencies()), { target: 'device' }),
  ...(['read', 'write'] as ClipboardAction[]).map(action => definition(`clipboard ${action}`, action === 'read' ? 'Read Simulator clipboard text.' : 'Write exact Simulator clipboard text.', action === 'write' ? { text: { ...single, required: true } } : {},
    async (context, parsed) => clipboard(await context.config(), action, { text: value(parsed, 'text') }, context.simulatorDependencies()), { target: 'device' })),
  ...(['grant', 'revoke', 'reset'] as PrivacyAction[]).map(action => definition(`privacy ${action}`, `${action[0].toUpperCase()}${action.slice(1)} the app permission.`, { service: nonEmpty, ...(action === 'reset' ? { 'all-apps': boolean } : {}) }, async (context, parsed) => privacy(await context.config(), action, { service: value(parsed, 'service'), allApps: parsed.flags.has('all-apps') }, context.simulatorDependencies()))),
  definition('push', 'Send a simulated remote notification to the app.', { payload: single, 'payload-json': single }, async (context, parsed) => push(await context.config(), { payload: value(parsed, 'payload'), payloadJson: value(parsed, 'payload-json') }, context.simulatorDependencies())),
  ...(['set', 'clear', 'list', 'run'] as LocationAction[]).map(action => definition(`location ${action}`, `${action[0].toUpperCase()}${action.slice(1)} the simulated location.`, action === 'set' ? { coordinate: nonEmpty } : action === 'run' ? { scenario: nonEmpty } : {}, async (context, parsed) => location(await context.config(), action, { coordinate: value(parsed, 'coordinate'), scenario: value(parsed, 'scenario') }, context.simulatorDependencies()), { target: 'device', ...(action === 'list' ? { recording: 'none' } : {}) })),
  definition('observe', 'Capture a simulator screenshot.', {}, async context => observe(await context.config(), context.evidenceDependencies()), { recording: 'handler' }),
  definition('logs show', 'Read recent app logs.', logOptions, async (context, parsed) => showLogs(await context.config(), logs(parsed), context.evidenceDependencies()), { recording: 'handler', prepare: validateLogs }),
  definition('logs stream', 'Capture live app logs for a bounded time.', { duration: single, until: single, level: logOptions.level, limit: logOptions.limit }, async (context, parsed) => streamLogs(await context.config(), { duration: value(parsed, 'duration'), until: value(parsed, 'until'), level: value(parsed, 'level'), limit: numberOption(parsed, 'limit') }, context.evidenceDependencies()), { recording: 'handler', prepare: validateCapture }),
  definition('logs js', 'Capture JavaScript console messages for a bounded time.', { duration: single, until: single, limit: logOptions.limit }, async (context, parsed) => captureJsLogs(await context.config(), { duration: value(parsed, 'duration'), until: value(parsed, 'until'), limit: numberOption(parsed, 'limit') }), { recording: 'handler', runtimes: javascript, prepare: validateCapture }),
  definition('diagnose', 'Collect debugging evidence.', logOptions, async (context, parsed) => diagnose(await context.config(), logs(parsed), context.evidenceDependencies()), { recording: 'handler', prepare: validateLogs }),
  definition('crashes list', 'List recent app crash reports.', { since: single, limit: limit(1, 100, 10) }, async (context, parsed) => listCrashes(await context.config(), { since: value(parsed, 'since'), limit: numberOption(parsed, 'limit') }, context.evidenceDependencies())),
  definition('ui build-runner', 'Build the XCTest UI runner.', { timeout: timeout(900) }, async (context, parsed) => buildUiRunner(await context.config(), { timeoutMs: timeoutOption(parsed), resolveUdid: async (_config, run) => (await context.device(false, (args, options) => run('xcrun', ['simctl', ...args], options))).udid }, true), { target: 'device' }),
  definition('ui run', 'Execute a JSON UI action plan.', { plan: { ...single, nonEmpty: true, errorCode: 'UI_VALIDATION_FAILED' }, 'plan-json': { ...single, nonEmpty: true, errorCode: 'UI_VALIDATION_FAILED' }, ...uiOptions }, async (context, parsed) => runUiPlan(await context.config(), value(parsed, 'plan-json') !== undefined ? { json: value(parsed, 'plan-json')! } : { file: path.resolve(value(parsed, 'plan')!) }, uiDependencies(context, parsed)), { prepare: parsed => {
    const plan = value(parsed, 'plan'), json = value(parsed, 'plan-json');
    if (plan !== undefined && json !== undefined) throw new CliError('UI_VALIDATION_FAILED', 'Use either --plan or --plan-json');
    if (plan === undefined && json === undefined) throw new CliError('UI_VALIDATION_FAILED', 'ui run requires --plan or --plan-json');
    if (json !== undefined) { let decoded: unknown; try { decoded = JSON.parse(json); } catch { throw new CliError('UI_VALIDATION_FAILED', 'Cannot parse UI plan JSON'); } validatePlan(decoded); }
  } }),
  definition('ui inspect', "Read the current screen's elements.", { ...uiOptions, all: boolean }, async (context, parsed) => inspectScreen(await context.config(), { ...uiDependencies(context, parsed), all: parsed.flags.has('all') }, uiDependencies(context, parsed))),
  definition('doctor', 'Check setup and dependencies.', {}, async () => doctor(), independent),
  definition('clean', 'Delete agemu runs or derived data.', { runs: boolean, 'derived-data': boolean, 'older-than': single, 'dry-run': boolean }, async (context, parsed) => clean(await context.config(), cleanOptions(parsed)), { target: 'none', prepare: parsed => { cleanOptions(parsed); } }),
];

const shortcutKinds: Partial<Record<UiActionKind, string>> = {
  launch: 'launch', terminate: 'terminate', tap: 'tap', type: 'type', clear: 'clear', wait: 'wait', longPress: 'long-press', swipe: 'swipe',
  assertVisible: 'assert-visible', assertExists: 'assert-exists', assertNotVisible: 'assert-not-visible', assertValue: 'assert-value', assertText: 'assert-text',
  screenshot: 'screenshot', pressKey: 'press-key', pressButton: 'press-button', openUrl: 'open-url',
};
const actionFlag = (field: string) => ({ identifier: 'id', labelContains: 'label-contains', timeout: 'wait-timeout' } as Record<string, string>)[field] ?? field;
const numericFields = new Set(['x', 'y', 'index', 'duration', 'timeout', 'count']);
function shortcutPlan(kind: UiActionKind, parsed: ParsedArgs): UiPlan {
  const input: Record<string, unknown> = {};
  for (const field of actionDefinitions[kind].fields) {
    const given = value(parsed, actionFlag(field));
    if (given === undefined) continue;
    if (numericFields.has(field)) input[field] = given.trim() === '' ? NaN : Number(given);
    else if (field === 'confirm') input[field] = parsed.flags.has('confirm');
    else if (field === 'from' || field === 'to') {
      const parts = given.split(',');
      input[field] = { x: parts.length === 2 && parts[0].trim() !== '' ? Number(parts[0]) : NaN, y: parts.length === 2 && parts[1].trim() !== '' ? Number(parts[1]) : NaN };
    } else input[field] = given;
  }
  if (kind === 'launch') {
    if (parsed.flags.has('arg')) input.arguments = values(parsed, 'arg');
    if (parsed.flags.has('env')) input.environment = launchEnvironment(parsed);
  }
  return validatePlan({ version: 1, actions: [{ [kind]: input }] });
}
const shortcuts = Object.entries(shortcutKinds).map(([kind, name]) => {
  const action = kind as UiActionKind;
  const flags = Object.fromEntries(actionDefinitions[action].fields.filter(field => field !== 'arguments' && field !== 'environment')
    .map(field => [actionFlag(field), field === 'confirm' ? boolean : single]));
  return definition(`ui ${name}`, `Run one ${kind} action using the UI plan validator.`, { ...flags, ...(action === 'launch' ? launchOptions : {}), ...uiOptions },
    async (context, parsed, prepared) => runUiPlan(await context.config(), { json: JSON.stringify(prepared) }, uiDependencies(context, parsed)), { prepare: parsed => shortcutPlan(action, parsed) });
});
const discoveryFlags = { runtime: { ...single, choices: runtimes } satisfies FlagSpec };
export const commandDefinitions: readonly CommandDefinition[] = [
  ...baseDefinitions, ...shortcuts,
  definition('commands', 'Discover commands, options, bounds, and runtime support.', discoveryFlags, async (context, parsed) => commandDiscovery(context, parsed), { configuration: 'none', target: 'none', recording: 'none' }),
  definition('capabilities', 'Discover UI semantics and backend limitations.', discoveryFlags, async (context, parsed) => capabilityDiscovery(context, parsed), { configuration: 'none', target: 'none', recording: 'none' }),
];
export const commandRegistry = new Map(commandDefinitions.map(definition => [definition.key, definition]));
const runtimeOf = (config: Awaited<ReturnType<CommandContext['optionalConfig']>>): Runtime | null => !config ? null : config.app.type === 'expo' ? config.app.launchTarget === 'expo-go' ? 'expo-go' : 'expo-development-build' : config.app.type;
async function commandDiscovery(context: CommandContext, parsed: ParsedArgs) {
  const config = await context.optionalConfig().catch(() => undefined);
  const runtime = value(parsed, 'runtime') as Runtime | undefined ?? runtimeOf(config);
  return { runtime, configurationAvailability: { available: config !== undefined, reason: config ? null : 'No readable app configuration; static discovery remains available' }, commands: commandDefinitions.map(({ key, description, flags, configuration, recording, target, runtimes: supported, destructive }) => ({
    command: key, description, options: flags, configuration, recording, target, destructive: destructive ?? false,
    runtimeAvailability: Object.fromEntries(runtimes.map(runtime => [runtime, supported.includes(runtime)])),
    availability: { scope: 'runtime-support', available: runtime === null ? null : supported.includes(runtime), reason: runtime === null ? 'Runtime is unconfigured; pass --runtime or configure this project' : supported.includes(runtime) ? null : `Unsupported for ${runtime}` },
  })) };
}
async function capabilityDiscovery(context: CommandContext, parsed: ParsedArgs) {
  return { ...(await commandDiscovery(context, parsed)), platform: 'ios',
    host: { available: process.platform === 'darwin', reason: process.platform === 'darwin' ? null : 'iOS Simulator requires macOS and Xcode' },
    ui: { actions: actionDefinitions, planVersion: 1, shortcuts: Object.fromEntries(Object.entries(shortcutKinds).map(([action, name]) => [action, `ui ${name}`])),
      selection: 'auto uses idb when available and compatible, otherwise XCTest',
      toolAvailability: { idb: null, xctest: null, reason: 'Not probed by discovery; doctor checks installed prerequisites' },
      semantics: { visible: 'nonempty on-screen geometry', hittable: 'separate from visibility', openUrlConfirmDefault: false, regex: portableRegexDescription },
      backends: {
        idb: { actions: Object.keys(actionDefinitions).filter(key => actionDefinitions[key as UiActionKind].backends.includes('idb')), depth: null, foregroundIdentity: null, inspectionScope: 'foreground-tree', targetlessDirectionalSwipe: false, videoRecording: true,
          limitations: ['Depth and reliable foreground identity are unavailable', 'Directional swipe needs a target or explicit from/to coordinates'] },
        xctest: { actions: Object.keys(actionDefinitions).filter(key => actionDefinitions[key as UiActionKind].backends.includes('xctest')), depth: true, foregroundIdentity: null, inspectionScope: 'configured-app', targetlessDirectionalSwipe: true, videoRecording: true, limitations: ['Reliable foreground identity is unavailable'] },
      } },
    appStatus: { running: 'exact UIKit service PID evidence', foreground: null, limitation: 'simctl cannot reliably expose foreground state' },
  };
}

export async function executeCommand(definition: CommandDefinition, context: CommandContext, parsed: ParsedArgs) {
  validateFlags(parsed, definition.flags);
  const prepared = definition.prepare?.(parsed);
  const config = definition.configuration === 'required' ? await context.config()
    : definition.configuration === 'optional' ? await context.optionalConfig().catch(error => { if (definition.key === 'simulator delete') return undefined; throw error; }) : undefined;
  const operation = () => definition.handler(context, parsed, prepared);
  const result = definition.recording === 'boundary' && config ? await recordCommand(config, definition.key, operation) : await operation();
  return commandResult(result, { key: definition.key, target: definition.target, config });
}
