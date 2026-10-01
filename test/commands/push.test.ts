import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { push } from '../../src/commands/push.js';
import type { LoadedConfig } from '../../src/config/config.js';
import type { ProcessResult } from '../../src/process/run-process.js';
import { parseArgs } from '../../src/cli/args.js';

let root: string;
const configFor = (directory: string): LoadedConfig => ({
  version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: '/repo/App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
  simulator: { udid: 'PHONE' }, redactions: ['top-secret'], root: directory,
});
const ok = (): ProcessResult => ({ stdout: '', stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 0 });
const device = (state: string) => async () => [{ udid: 'PHONE', name: 'Phone', runtime: 'iOS-18-0', state, isAvailable: true }];

function fake(responses: ProcessResult[] = [], state = 'Booted') {
  const calls: string[][] = [];
  return { calls, deps: { listDevices: device(state), runner: async (args: string[]) => { calls.push(args); return responses.shift() ?? ok(); } } };
}

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'agemu-push-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('push validation', () => {
  const exact = '{"aps":{"alert":"'; // 17 bytes of framing plus 2 closing characters
  const sized = (bytes: number) => `${exact}${'a'.repeat(bytes - exact.length - 3)}"}}`;

  it.each([
    ['no source', {}],
    ['both sources', { payload: '/x.json', payloadJson: '{"aps":{}}' }],
    ['invalid JSON', { payloadJson: '{"aps":' }],
    ['empty JSON', { payloadJson: '' }],
    ['array', { payloadJson: '[{"aps":{}}]' }],
    ['null', { payloadJson: 'null' }],
    ['missing aps', { payloadJson: '{"alert":"hi"}' }],
    ['non-object aps', { payloadJson: '{"aps":"hi"}' }],
    ['array aps', { payloadJson: '{"aps":[]}' }],
    ['unreadable file', { payload: '/definitely/not/here.json' }],
    ['4097 bytes', { payloadJson: sized(4097) }],
    ['multi-byte characters over the limit', { payloadJson: `{"aps":{"alert":"${'é'.repeat(2040)}"}}` }],
  ])('rejects %s before any simctl call or run directory', async (_name, options) => {
    const fixture = fake();
    await expect(push(configFor(root), options, fixture.deps)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    expect(fixture.calls).toEqual([]);
    await expect(stat(path.join(root, '.agemu'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a payload of exactly 4096 bytes', async () => {
    const fixture = fake();
    const text = sized(4096);
    expect(Buffer.byteLength(text)).toBe(4096);
    await expect(push(configFor(root), { payloadJson: text }, fixture.deps)).resolves.toMatchObject({ bytes: 4096 });
  });

  it('refuses a Shutdown Simulator without invoking simctl', async () => {
    const fixture = fake([], 'Shutdown');
    await expect(push(configFor(root), { payloadJson: '{"aps":{}}' }, fixture.deps)).rejects.toMatchObject({ code: 'SIMULATOR_NOT_BOOTED' });
    expect(fixture.calls).toEqual([]);
  });
});

describe('push delivery', () => {
  it('passes the saved unredacted payload file to simctl for inline JSON', async () => {
    const fixture = fake();
    const input = '{"aps":{"alert":"top-secret"}}';
    const result = await push(configFor(root), { payloadJson: input }, fixture.deps);
    const file = path.join(root, result.payload);
    expect(fixture.calls).toEqual([['push', 'PHONE', 'com.example.app', file]]);
    expect(result).toMatchObject({ udid: 'PHONE', bundleId: 'com.example.app', bytes: input.length });
    expect(path.dirname(result.payload)).toBe(result.run);
    expect(path.basename(result.payload)).toBe('push.json');
    expect(await readFile(file, 'utf8')).toBe(input);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('reads a payload file and saves identical content into the run', async () => {
    const source = path.join(root, 'in.json');
    const input = '{\n  "aps": { "alert": "hi" },\n  "custom": 1\n}\n';
    await writeFile(source, input);
    const fixture = fake();
    const result = await push(configFor(root), { payload: source }, fixture.deps);
    expect(await readFile(path.join(root, result.payload), 'utf8')).toBe(input);
    expect(fixture.calls[0].slice(0, 3)).toEqual(['push', 'PHONE', 'com.example.app']);
  });

  it('reports simctl failures redacted', async () => {
    const fixture = fake([{ ...ok(), stderr: 'bad top-secret', exitCode: 2 }]);
    await expect(push(configFor(root), { payloadJson: '{"aps":{}}' }, fixture.deps)).rejects.toMatchObject({
      code: 'PROCESS_FAILED', message: 'bad [REDACTED]',
    });
  });
});

describe('push argument parsing', () => {
  it('accepts either source and rejects repeats and unknown options', () => {
    expect(parseArgs(['push', '--payload=a.json']).flags.get('payload')).toEqual(['a.json']);
    expect(parseArgs(['push', '--payload-json', '{"aps":{}}']).flags.get('payload-json')).toEqual(['{"aps":{}}']);
    expect(() => parseArgs(['push', '--payload=a', '--payload=b'])).toThrow(/once/);
    expect(() => parseArgs(['push', '--yes'])).toThrow(/Unknown option --yes/);
  });
});
