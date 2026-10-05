import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAppState } from '../../src/core/app-state.js';

describe('cached app state boundary', () => {
  it('keeps usable product paths intact but redacts read failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-state-secret-'));
    const file = path.join(root, 'state.json');
    try {
      const state = { appPath: '/products/secret-value/App.app', bundleId: 'com.example.app', executableName: 'App', udid: 'PHONE', configuration: 'Debug', updatedAt: '2026-10-05T12:00:00Z' };
      await writeFile(file, JSON.stringify(state));
      expect((await readAppState(file, ['secret-value'])).appPath).toBe(state.appPath);
      expect(await readFile(file, 'utf8')).toContain('secret-value');
      await expect(readAppState(path.join(root, 'secret-value-missing.json'), ['secret-value']))
        .rejects.toMatchObject({ code: 'APP_NOT_BUILT', message: expect.not.stringContaining('secret-value') });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['null', '[]', '{}', '{"appPath":42}', '{invalid'])('rejects unusable persisted state %s', async (contents) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-state-invalid-'));
    try {
      const file = path.join(root, 'state.json');
      await writeFile(file, contents);
      await expect(readAppState(file)).rejects.toMatchObject({ code: 'APP_NOT_BUILT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
