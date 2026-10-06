import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { requireBooted, runSimctl, selectedDevice, type SimctlDeps } from '../native/simctl-commands.js';

export type PrivacyAction = 'grant' | 'revoke' | 'reset';
export const privacyServices = [
  'all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add', 'photos',
  'media-library', 'microphone', 'motion', 'reminders', 'siri',
] as const;

export async function privacy(
  config: LoadedConfig, action: PrivacyAction, options: { service?: string; allApps?: boolean }, deps: SimctlDeps = {},
) {
  const service = options.service;
  if (!service) throw new CliError('COMMAND_INVALID', `--service is required; valid services: ${privacyServices.join(', ')}`);
  if (!(privacyServices as readonly string[]).includes(service)) {
    throw new CliError('COMMAND_INVALID', `Unknown service "${service}"; valid services: ${privacyServices.join(', ')}`);
  }
  const device = await selectedDevice(config, deps);
  requireBooted(device);
  const bundleId = options.allApps ? null : targetBundleId(config);
  await runSimctl(['privacy', device.udid, action, service, ...(bundleId ? [bundleId] : [])], config.redactions ?? [], deps);
  return { action, service, udid: device.udid, bundleId, note: 'The app may have been terminated by this change' };
}
