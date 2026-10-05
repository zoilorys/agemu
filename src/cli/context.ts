import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type LoadedConfig } from '../config/config.js';
import { listDevices, resolveDevice, type Device, type SimctlRunner } from '../native/simctl.js';
import { requireBooted } from '../native/simctl-commands.js';
import type { ParsedArgs } from './types.js';
import { value } from './options.js';

/** One lazy context per invocation; read-only commands do not resolve a device unnecessarily. */
export class CommandContext {
  secrets: string[] = [];
  private loaded?: Promise<LoadedConfig>;
  private selected?: Promise<Device>;
  constructor(readonly parsed: ParsedArgs, readonly root = process.cwd()) {}
  config(): Promise<LoadedConfig> {
    return this.loaded ??= loadConfig(this.root).then(config => { this.secrets = config.redactions ?? []; return config; });
  }
  async optionalConfig(): Promise<LoadedConfig | undefined> {
    return existsSync(path.join(this.root, '.agemu.json')) ? this.config() : undefined;
  }
  async device(booted = false, runner?: SimctlRunner): Promise<Device> {
    const device = await (this.selected ??= this.select(runner));
    if (booted) requireBooted(device, this.secrets);
    return device;
  }
  private async select(runner?: SimctlRunner): Promise<Device> {
    const config = await this.optionalConfig();
    const explicitUdid = value(this.parsed, 'udid');
    const explicitName = value(this.parsed, 'name');
    const runtime = value(this.parsed, 'runtime');
    const selector = this.parsed.command === 'simulator'
      ? explicitUdid ? { udid: explicitUdid } : config?.simulator.udid ? { udid: config.simulator.udid }
        : explicitName ? { name: explicitName, ...(runtime ? { runtime } : {}) } : config?.simulator ?? {}
      : config?.simulator ?? {};
    return resolveDevice(await listDevices(runner), selector);
  }
  simulatorDependencies() { return { listDevices: async () => [await this.device()] }; }
  appDependencies() { return { resolveUdid: async () => (await this.device(true)).udid, ...this.simulatorDependencies() }; }
  evidenceDependencies() { return { resolveDevice: async () => this.device() }; }
}
