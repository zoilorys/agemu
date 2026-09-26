import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveExpoBundleId } from '../../src/commands/setup.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const result = (stdout: string): ProcessResult => ({ stdout, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 1 });

describe('Expo setup discovery', () => {
  it('resolves dynamic Expo config through the local CLI without generating native files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-setup-'));
    try {
      await mkdir(path.join(root, 'node_modules/expo/bin'), { recursive: true });
      await writeFile(path.join(root, 'node_modules/expo/bin/cli'), '');
      await writeFile(path.join(root, 'app.config.js'), 'module.exports = { ios: { bundleIdentifier: "com.example.dynamic" } };');
      await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.stale' } } }));
      let cwd: string | undefined;
      const bundleId = await resolveExpoBundleId(root, async (_executable, args, options) => {
        expect(args).toEqual([path.join(root, 'node_modules/expo/bin/cli'), 'config', '--json', '--type', 'public']);
        cwd = options?.cwd;
        return result(JSON.stringify({ ios: { bundleIdentifier: 'com.example.dynamic' } }));
      });
      expect(bundleId).toBe('com.example.dynamic');
      expect(cwd).toBe(root);
      await expect(access(path.join(root, 'ios'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(root, 'app.json'), 'utf8')).toContain('com.example.stale');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
