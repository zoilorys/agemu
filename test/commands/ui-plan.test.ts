import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { idbCompatible } from '../../src/commands/idb-ui.js';
import { runUiPlan } from '../../src/commands/ui.js';
import { validatePlan } from '../../src/commands/ui-plan.js';
import { portableRegexSource } from '../../src/commands/ui-regex.js';
import type { LoadedConfig } from '../../src/config/config.js';

const config = (root: string): LoadedConfig => ({ root, version: 2, platform: 'ios',
  app: { type: 'native', project: 'Fixture.xcodeproj', scheme: 'Fixture', configuration: 'Debug', bundleId: 'dev.fixture' }, simulator: { udid: 'PHONE' } });

// These patterns exercised genuine JS/ICU differences; test against Foundation's actual ICU engine.
const regexCases: [string, string, boolean][] = [
  ['^Item \\d+$', 'Item 24', true],
  ['^Item \\d+$', 'Item ٢٤', false],
  ['^Item \\d+$', 'Item 24\n', false],
  ['^\\w+$', 'café', false],
  ['^\\s$', '\u00a0', false],
  ['^\\s$', '\v', true],
  ['^.$', '😀', true],
  ['^.$', '\u0085', true],
  ['^.$', '\u2028', false],
  ['foo.*', 'foomatic', true],
  ['(?:Save|Open) [A-Z]{2,4}', 'Open ABC', true],
  ['^a+?b?$', 'aaab', true],
  ['^price\\.[0-9]+\\$$', 'price.12$', true],
  ['^[^a-z]+$', '😀24', true],
];

describe('portable UI regex behavior', () => {
  it.each(regexCases)('%s on %j yields %s', (pattern, value, expected) => {
    expect(new RegExp(portableRegexSource(pattern), 'u').test(value)).toBe(expected);
  });

  it.runIf(process.platform === 'darwin')('matches the same edge cases in Foundation ICU', () => {
    const cases = regexCases.map(([pattern, value]) => ({ pattern: portableRegexSource(pattern), value }));
    const swift = `import Foundation
struct Input: Decodable { let pattern: String; let value: String }
let input = try JSONDecoder().decode([Input].self, from: FileHandle.standardInput.readDataToEndOfFile())
let output = try input.map { item in
    let regex = try NSRegularExpression(pattern: item.pattern)
    return regex.firstMatch(in: item.value, range: NSRange(item.value.startIndex..., in: item.value)) != nil
}
print(String(data: try JSONEncoder().encode(output), encoding: .utf8)!)
`;
    // swift reads source from -e, leaving stdin available for the test cases.
    const output = execFileSync('swift', ['-e', swift], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(output)).toEqual(regexCases.map(([, , expected]) => expected));
  }, 35_000);
});

describe('UI validation boundary', () => {
  it.each([
    { longPress: { identifier: 'go', x: 1, y: 2 } },
    { longPress: { identifier: 'go', x: 1 } },
    ...['(?<=x)y', '(x)\\1', '\\p{L}', '[a&&b]', '[[]', '[]', '[^]', 'a{16777216}'].map(matches => ({ assertText: { label: 'status', matches } })),
  ])('rejects ambiguous/dialect-specific actions before side effects: %j', async action => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-plan-'));
    let calls = 0;
    try {
      await expect(runUiPlan(config(root), { json: JSON.stringify({ version: 1, actions: [action] }) }, {
        run: async () => { calls += 1; throw new Error('Unexpected process'); },
      })).rejects.toMatchObject({ code: 'UI_VALIDATION_FAILED' });
      expect(calls).toBe(0);
      await expect(stat(path.join(root, '.agemu'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('delivers the portable expression to XCTest while preserving the submitted assertion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-ui-regex-'));
    const directory = path.join(root, '.agemu', 'RunnerDerivedData');
    let delivered: { actions: { assertText: { matches: string; compiledMatches: string } }[] } | undefined;
    const result = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', durationMs: 1 });
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'Runner.xctestrun'), 'fixture');
      await runUiPlan(config(root), { json: JSON.stringify({ version: 1, actions: [{ assertText: { label: 'Item', matches: '^Item \\d+$' } }] }) }, {
        backend: 'xctest',
        run: async (executable, args) => {
          if (executable === 'plutil' && args.includes('json')) return result(JSON.stringify([{ TestBundlePath: 'runner' }]));
          if (executable === 'plutil' && args.includes('xml1')) {
            const manifest = JSON.parse(await readFile(args.at(-1)!, 'utf8'));
            delivered = JSON.parse(Buffer.from(manifest[0].EnvironmentVariables.AGEMU_PLAN_BASE64, 'base64').toString('utf8'));
          }
          if (executable === 'xcodebuild') return result(`AGEMU_RESULT:${Buffer.from(JSON.stringify({ completed: 1, bundleId: 'dev.fixture', inspections: [] })).toString('base64')}`);
          return result();
        },
      });
      const assertion = delivered!.actions[0].assertText;
      expect(assertion.matches).toBe('^Item \\d+$');
      expect(new RegExp(assertion.compiledMatches, 'u').test('Item 24')).toBe(true);
      expect(new RegExp(assertion.compiledMatches, 'u').test('Item ٢٤')).toBe(false);
      expect(new RegExp(assertion.compiledMatches, 'u').test('Item 24\n')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves a targetless directional swipe for XCTest and excludes only that limitation from idb', () => {
    const plan = validatePlan({ version: 1, actions: [{ swipe: { direction: 'up' } }] });
    expect(idbCompatible(plan)).toBe(false);
    expect(idbCompatible(validatePlan({ version: 1, actions: [{ swipe: { direction: 'up', label: 'results' } }] }))).toBe(true);
    expect(idbCompatible(validatePlan({ version: 1, actions: [{ swipe: { from: { x: 0, y: 20 }, to: { x: 0, y: 0 } } }] }))).toBe(true);
  });

  it('rejects prototype action names with a validation error', () => {
    expect(() => validatePlan(JSON.parse('{"version":1,"actions":[{"__proto__":{}}]}'))).toThrow('unknown action __proto__');
  });
});
