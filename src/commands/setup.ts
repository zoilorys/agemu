import { readdir, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { CliError } from '../core/errors.js';
import type { DebugConfig } from '../config/config.js';
import { listDevices, type Device } from '../native/simctl.js';
import { runProcess } from '../process/run-process.js';

const ignored = new Set(['.git', 'node_modules', '.build', '.agemu', 'Pods', 'DerivedData', 'build']);

async function findSources(root: string, directory = root, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const sources: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.name.endsWith('.xcworkspace') || entry.name.endsWith('.xcodeproj')) sources.push(path.relative(root, full));
    else sources.push(...await findSources(root, full, depth + 1));
  }
  return sources.sort();
}

async function checked(args: string[]): Promise<string> {
  const result = await runProcess('xcodebuild', args, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new CliError('PROCESS_FAILED', result.stderr.trim() || 'xcodebuild failed');
  return result.stdout;
}

function schemes(json: string, kind: 'project' | 'workspace'): string[] {
  try {
    const parsed = JSON.parse(json) as Record<string, { schemes?: unknown }>;
    const values = parsed[kind]?.schemes;
    if (Array.isArray(values)) return values.filter((value): value is string => typeof value === 'string');
  } catch { /* Report the same actionable error below. */ }
  throw new CliError('PROCESS_FAILED', 'xcodebuild did not return a scheme list');
}

async function choose<T>(label: string, choices: T[], describe: (choice: T) => string, interactive: boolean): Promise<T> {
  if (choices.length === 0) throw new CliError('CONFIG_INVALID', `No ${label} found`);
  if (choices.length === 1) return choices[0];
  if (!interactive || !process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CliError('CONFIG_INVALID', `Multiple ${label} found. Run agemu setup in a terminal`, {
      choices: choices.map(describe),
    });
  }
  process.stderr.write(`Select ${label}:\n${choices.map((choice, index) => `  ${index + 1}. ${describe(choice)}`).join('\n')}\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = await prompt.question(`Choice [1-${choices.length}]: `);
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1];
      process.stderr.write('Enter a listed number.\n');
    }
  } finally { prompt.close(); }
}

export async function setup(root = process.cwd(), interactive = true): Promise<{ file: string; config: DebugConfig }> {
  const file = path.join(root, '.agemu.json');
  try {
    await access(file);
    throw new CliError('CONFIG_INVALID', '.agemu.json already exists; edit it directly to change your setup');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const sources = await findSources(root);
  const source = await choose('Xcode project or workspace', sources.filter((item) => !item.endsWith('project.xcworkspace')), (item) => item, interactive);
  const kind = source.endsWith('.xcworkspace') ? 'workspace' : 'project';
  const sourceArgs = [`-${kind}`, path.join(root, source)];
  const scheme = await choose('scheme', schemes(await checked([...sourceArgs, '-list', '-json']), kind), (item) => item, interactive);
  const devices = await listDevices();
  const device = await choose<Device>('simulator', devices, (item) => `${item.name} (${item.runtime}, ${item.state})`, interactive);
  const settings = await checked([...sourceArgs, '-scheme', scheme, '-configuration', 'Debug', '-destination', `platform=iOS Simulator,id=${device.udid}`, '-showBuildSettings']);
  const bundleIds = [...new Set([...settings.matchAll(/^\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(\S+)\s*$/gm)].map((match) => match[1]).filter((id) => !id.includes('$') && !id.endsWith('.tests') && !id.endsWith('.Tests')))];
  const bundleId = await choose('bundle ID', bundleIds, (item) => item, interactive);
  const config: DebugConfig = { version: 1, [kind]: source, scheme, configuration: 'Debug', bundleId, simulator: { udid: device.udid } };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  return { file, config };
}
