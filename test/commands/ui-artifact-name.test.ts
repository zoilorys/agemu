import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runUiPlan, type UiDependencies } from '../../src/commands/ui.js';
import { createRecordingSession } from '../../src/commands/video-recording.js';
import { redactValue } from '../../src/artifacts/runs.js';
import type { LoadedConfig } from '../../src/config/config.js';
import { CliError } from '../../src/core/errors.js';
import { deadline, type ProcessResult } from '../../src/process/run-process.js';

const result = (stdout = '', exitCode = 0): ProcessResult => ({ stdout, stderr: '', exitCode,
  signal: null, startedAt: new Date().toISOString(), durationMs: 1 });
const marker = (kind: string, payload: unknown) => `AGEMU_${kind}:${Buffer.from(JSON.stringify(payload)).toString('base64')}\n`;
const tree = [{ type: 'Application', AXLabel: 'Fixture', frame: { x: 0, y: 0, width: 100, height: 100 } },
  { type: 'StaticText', AXLabel: 'private', AXValue: 'private', frame: { x: 10, y: 10, width: 30, height: 20 } }];

describe('stored UI artifact names survive public redaction', () => {
  it('keeps default names and secrets inside the redaction marker usable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-artifact-marker-'));
    const secrets = ['REDACTED', 'video'];
    const session = createRecordingSession('PHONE', root, root, async (_udid, file) => {
      await writeFile(file, 'video fixture');
      return { stop: async () => undefined };
    }, deadline(5_000), secrets);
    try {
      await session.start(); await session.stop();
      await session.start('REDACTED'); await session.stop();
      const publicPaths = redactValue(session.recordings, secrets);
      expect(new Set(publicPaths).size).toBe(2);
      for (const file of publicPaths) {
        expect(await readFile(path.join(root, file), 'utf8')).toBe('video fixture');
        expect(file).not.toMatch(/REDACTED|video/);
      }
    } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { backend: 'idb' as const, fail: false }, { backend: 'idb' as const, fail: true },
    { backend: 'xctest' as const, fail: false }, { backend: 'xctest' as const, fail: true },
  ])('keeps paths usable on $backend (partial failure: $fail)', async ({ backend, fail }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-artifact-names-'));
    try {
      const runnerDirectory = path.join(root, '.agemu', 'RunnerDerivedData');
      await mkdir(runnerDirectory, { recursive: true });
      await writeFile(path.join(runnerDirectory, 'Runner.xctestrun'), 'fixture');
      const config: LoadedConfig = { root, version: 2, platform: 'ios', simulator: { udid: 'PHONE' },
        redactions: ['private', 'secret phrase', 'REDACTED'], app: { type: 'native', project: 'Fixture.xcodeproj',
          scheme: 'Fixture', configuration: 'Debug', bundleId: 'dev.fixture' } };
      const longName = `${'x'.repeat(75)}secret phrase`;
      const actions = [{ assertText: { label: 'private', equals: 'private' } }, { screenshot: { name: 'private' } },
        { startVideoRecording: { name: 'private' } }, { stopVideoRecording: {} },
        { screenshot: { name: 'secret_phrase' } }, { startVideoRecording: { name: 'secret_phrase' } },
        { stopVideoRecording: {} }, { screenshot: { name: longName } }, { screenshot: { name: 'REDACTED' } },
        ...(fail ? [{ assertExists: { label: 'Missing' } }] : [])];
      const failedAction = { index: 9, kind: 'assertExists', message: 'element does not exist: Missing' };
      const rawAttachments = [[1, 'agemu-1-private_X.png'], [4, 'agemu-4-secret_phrase_X.png'],
        [7, `agemu-7-${'x'.repeat(75)}secre_X.png`], [8, 'agemu-8-REDACTED_X.png']] as const;
      const dependencies: UiDependencies = {
        backend,
        startRecording: async (_udid, file) => {
          await writeFile(file, 'video fixture');
          return { stop: async () => undefined };
        },
        run: async (executable, args) => {
          if (executable === 'idb' && args[1] === 'describe-all') return result(JSON.stringify(tree));
          if (executable === 'idb' && args[0] === 'screenshot') { await writeFile(args[1], 'screenshot fixture'); return result(); }
          if (executable === 'plutil' && args[1] === 'json') return result(JSON.stringify({ AgentRunner: { TestBundlePath: 'Runner.xctest' } }));
          if (executable === 'xcodebuild') {
            const manifest = JSON.parse(await readFile(args[args.indexOf('-xctestrun') + 1], 'utf8'));
            const environment = manifest.AgentRunner.EnvironmentVariables;
            const submitted = JSON.parse(Buffer.from(environment.AGEMU_PLAN_BASE64, 'base64').toString('utf8'));
            // Assertions and attachment names must reach the native runner unchanged.
            expect(submitted.actions).toEqual(actions);
            const origin = `http://127.0.0.1:${environment.AGEMU_VIDEO_PORT}`;
            for (const name of ['private', 'secret_phrase']) {
              expect((await fetch(`${origin}/start?name=${name}`, { method: 'POST' })).status).toBe(200);
              expect((await fetch(`${origin}/stop`, { method: 'POST' })).status).toBe(200);
            }
            await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
            return fail ? result('AGEMU_ACTION:9\n' + marker('FAILURE', failedAction), 65)
              : result(marker('RESULT', { completed: actions.length, bundleId: 'dev.fixture', inspections: [] }));
          }
          if (args[0] === 'xcresulttool') {
            const exported = args[args.indexOf('--output-path') + 1];
            await mkdir(exported, { recursive: true });
            const attachments = await Promise.all(rawAttachments.map(async ([index, name]) => {
              const file = `${index}.png`;
              await writeFile(path.join(exported, file), 'screenshot fixture');
              return { exportedFileName: file, suggestedHumanReadableName: name as string };
            }));
            if (fail) {
              await writeFile(path.join(exported, 'failure.png'), 'screenshot fixture');
              attachments.push({ exportedFileName: 'failure.png', suggestedHumanReadableName: 'agemu-failure_X.png' });
            }
            await writeFile(path.join(exported, 'manifest.json'), JSON.stringify([{ attachments }]));
          }
          return result();
        },
      };
      const outcome = await runUiPlan(config, { json: JSON.stringify({ version: 1, actions }) }, dependencies)
        .catch((error: unknown) => error);
      if (fail) expect(outcome).toMatchObject({ code: 'UI_DELIVERY_FAILED', details: { completed: 9, failedAction } });
      else expect(outcome).toMatchObject({ backend, completed: 9 });
      const evidence = outcome instanceof CliError ? outcome.details! : outcome as { screenshots: string[]; recordings: string[] };
      if (fail) expect(evidence).toHaveProperty('failureScreenshot');
      const screenshots = evidence.screenshots as string[];
      const recordings = evidence.recordings as string[];
      expect(screenshots).toHaveLength(4);
      expect(recordings).toHaveLength(2);
      expect(screenshots.map(file => path.basename(file).split('-')[0])).toEqual(['1', '4', '7', '8']);
      expect(recordings.map(file => path.basename(file).split('-')[0])).toEqual(['1', '2']);
      const paths = [...screenshots, ...recordings,
        ...('failureScreenshot' in evidence ? [evidence.failureScreenshot as string] : [])];
      expect(new Set(paths).size).toBe(paths.length);
      for (const file of paths) {
        expect(await readFile(path.join(root, file), 'utf8')).toMatch(/fixture$/);
        expect(file).not.toMatch(/private|secret[ _]phrase|REDACTED/);
      }
      expect(path.basename(screenshots[2]!)).not.toContain('secre');
      const runDirectory = path.dirname(path.join(root, recordings[0]!));
      const storedNames = [...await readdir(runDirectory), ...await readdir(path.join(runDirectory, 'screenshots'))];
      expect(storedNames.join('\n')).not.toMatch(/private|secret[ _]phrase|REDACTED/);
      expect(JSON.stringify(outcome)).not.toMatch(/private|secret[ _]phrase|REDACTED/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
