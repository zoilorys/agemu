import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeLaunchMarker } from '../../src/artifacts/launch-marker.js';
import { listCrashes } from '../../src/commands/crashes.js';
import type { LoadedConfig } from '../../src/config/config.js';

const now = new Date('2026-09-30T12:00:00Z');
const configFor = (root: string): LoadedConfig => ({
  version: 2, platform: 'ios', app: { type: 'native', project: `${root}/App.xcodeproj`, scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
  simulator: { udid: 'PHONE' }, redactions: ['secret-value'], root,
});
const crash = (incident: string, timestamp: string) => `${JSON.stringify({ app_name: 'App', timestamp, bug_type: '309', incident_id: incident, bundleID: 'com.example.app' })}\n${JSON.stringify({
  procName: 'App', asi: { 'libswiftCore.dylib': ['Fatal error: token secret-value leaked'] },
})}`;

describe('crashes list command', () => {
  it('copies each matching report with redactions and returns redacted summaries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-crashes-cmd-'));
    const reports = path.join(root, 'reports');
    await mkdir(reports);
    await writeFile(path.join(reports, 'App-recent.ips'), crash('recent', '2026-09-30 11:00:00.00 +0000'));
    await writeFile(path.join(reports, 'App-old.ips'), crash('old', '2026-09-29 11:00:00.00 +0000'));
    try {
      const result = await listCrashes(configFor(root), { sinceMs: 3_600_000 * 2 }, { directory: reports, now: () => now, readState: async () => { throw new Error('not built'); } });
      expect(result).toMatchObject({ bundleId: 'com.example.app', since: '2026-09-30T10:00:00.000Z', skipped: 0 });
      expect(result.crashes).toHaveLength(1);
      const [summary] = result.crashes;
      expect(summary).toMatchObject({ source: 'App-recent.ips', incidentId: 'recent', message: 'Fatal error: token [REDACTED] leaked' });
      expect(summary.file).toBe(path.join(result.run, 'crashes', 'App-recent.ips'));
      const copy = path.join(root, summary.file);
      const copied = await readFile(copy, 'utf8');
      expect(copied).toContain('token [REDACTED] leaked');
      expect(copied).not.toContain('secret-value');
      expect((await stat(copy)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(result)).not.toContain('secret-value');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns only crashes after the latest agemu launch with since=launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-crashes-launch-'));
    const reports = path.join(root, 'reports');
    await mkdir(reports);
    await writeFile(path.join(reports, 'App-before.ips'), crash('before', '2026-09-30 11:29:59.00 +0000'));
    await writeFile(path.join(reports, 'App-after.ips'), crash('after', '2026-09-30 11:30:05.00 +0000'));
    try {
      await writeLaunchMarker(root, { at: new Date('2026-09-30T11:30:00Z'), udid: 'PHONE', bundleId: 'com.example.app', source: 'app launch' });
      const result = await listCrashes(configFor(root), { since: 'launch' }, {
        directory: reports, now: () => now, readState: async () => { throw new Error('not built'); },
        resolveDevice: async () => ({ udid: 'PHONE', name: 'iPhone', runtime: 'iOS-18-0', state: 'Booted', isAvailable: true }),
      });
      expect(result.since).toBe('2026-09-30T11:30:00.000Z');
      expect(result.crashes.map((item) => item.incidentId)).toEqual(['after']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([0, 101])('rejects limit %i', async (limit) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-crashes-cmd-'));
    try {
      await expect(listCrashes(configFor(root), { limit }, { directory: root })).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
