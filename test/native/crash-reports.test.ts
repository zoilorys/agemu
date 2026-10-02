import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCrashReports, parseIpsReport, summarizeCrash } from '../../src/native/crash-reports.js';

type Header = Record<string, unknown>;
const header = (overrides: Header = {}): Header => ({
  app_name: 'App', timestamp: '2026-09-29 02:24:06.00 +0100', bug_type: '309', incident_id: 'INCIDENT-1', bundleID: 'com.example.app', ...overrides,
});
const body = {
  procName: 'App',
  exception: { type: 'EXC_BREAKPOINT', signal: 'SIGTRAP', codes: '0x1' },
  termination: { indicator: 'Trace/BPT trap: 5', namespace: 'SIGNAL', code: 5 },
  asi: { 'libswiftCore.dylib': ['App/AppDelegate.swift:44: Fatal error: boom'], other: { nested: 'second line' } },
  faultingThread: 1,
  threads: [
    { frames: [{ imageIndex: 0, imageOffset: 1, symbol: 'idle' }] },
    { frames: [
      { imageIndex: 1, imageOffset: 4096, symbol: '_assertionFailure' },
      { imageIndex: 0, imageOffset: 200, sourceFile: 'AppDelegate.swift', sourceLine: 46 },
      { imageIndex: 9, imageOffset: 5 },
    ] },
  ],
  usedImages: [{ name: 'App', path: '/App.app/App' }, { name: 'libswiftCore.dylib', path: '/usr/lib/swift/libswiftCore.dylib' }],
};
const report = (head: Header, content: unknown = body) => `${JSON.stringify(head)}\n${JSON.stringify(content)}`;

describe('crash report parsing', () => {
  it('summarizes the faulting thread, exception, termination, and asi message', () => {
    expect(summarizeCrash('App-1.ips', parseIpsReport(report(header())))).toEqual({
      file: 'App-1.ips', incidentId: 'INCIDENT-1', timestamp: '2026-09-29T01:24:06.000Z', bundleId: 'com.example.app', process: 'App',
      exceptionType: 'EXC_BREAKPOINT', signal: 'SIGTRAP', termination: 'Trace/BPT trap: 5',
      message: 'App/AppDelegate.swift:44: Fatal error: boom\nsecond line',
      frames: [
        { image: 'libswiftCore.dylib', symbol: '_assertionFailure', offset: 4096, sourceFile: null, sourceLine: null },
        { image: 'App', symbol: null, offset: 200, sourceFile: 'AppDelegate.swift', sourceLine: 46 },
        { image: null, symbol: null, offset: 5, sourceFile: null, sourceLine: null },
      ],
    });
  });

  it('keeps the header when the body is malformed and falls back to mtime for an unparsable timestamp', () => {
    const parsed = parseIpsReport(`${JSON.stringify(header({ timestamp: 'yesterday' }))}\n{not json`);
    expect(parsed.body).toBeUndefined();
    const summary = summarizeCrash('x.ips', parsed, new Date('2026-09-30T10:00:00Z'));
    expect(summary).toMatchObject({ timestamp: '2026-09-30T10:00:00.000Z', process: 'App', message: null, frames: [] });
  });

  it('caps the frames at 15 and the message at 2000 characters', () => {
    const long = { ...body, asi: { lib: ['x'.repeat(3_000)] }, faultingThread: 0,
      threads: [{ frames: Array.from({ length: 20 }, (_, index) => ({ imageIndex: 0, imageOffset: index })) }] };
    const summary = summarizeCrash('x.ips', parseIpsReport(report(header(), long)));
    expect(summary.frames).toHaveLength(15);
    expect(summary.message).toHaveLength(2_000);
  });
});

describe('crash report discovery', () => {
  it('returns only recent crashes of the configured app, newest first, honoring the limit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agemu-crashes-'));
    try {
      const files: Record<string, string> = {
        'older.ips': report(header({ incident_id: 'older', timestamp: '2026-09-30 10:00:00.00 +0000' })),
        'newest.ips': report(header({ incident_id: 'newest', timestamp: '2026-09-30 11:30:00.00 +0000' })),
        'middle.ips': report(header({ incident_id: 'middle', timestamp: '2026-09-30 11:00:00.00 +0000' })),
        'by-executable.ips': report(header({ incident_id: 'by-executable', bundleID: undefined, timestamp: '2026-09-30 10:30:00.00 +0000' })),
        'other-app.ips': report(header({ bundleID: 'com.other.app', timestamp: '2026-09-30 11:40:00.00 +0000' })),
        'same-executable-other-bundle.ips': report(header({ bundleID: 'com.other.app', app_name: 'App', timestamp: '2026-09-30 11:40:00.00 +0000' })),
        'too-old.ips': report(header({ timestamp: '2026-09-29 11:00:00.00 +0000' })),
        'hang.ips': report(header({ bug_type: '298', timestamp: '2026-09-30 11:45:00.00 +0000' })),
        'malformed.ips': 'not json at all',
        'notes.txt': report(header({ timestamp: '2026-09-30 11:50:00.00 +0000' })),
      };
      for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, name), contents);
      const query = { directory, since: new Date('2026-09-30T09:00:00Z'), bundleId: 'com.example.app', executableName: 'App' };

      const all = await findCrashReports({ ...query, limit: 10 });
      expect(all.crashes.map((crash) => crash.summary.incidentId)).toEqual(['newest', 'middle', 'by-executable', 'older']);
      expect(all.skipped).toBe(1);
      expect(all.crashes[0].path).toBe(path.join(directory, 'newest.ips'));

      const limited = await findCrashReports({ ...query, limit: 2 });
      expect(limited.crashes.map((crash) => crash.summary.incidentId)).toEqual(['newest', 'middle']);

      const bundleOnly = await findCrashReports({ ...query, executableName: undefined, limit: 10 });
      expect(bundleOnly.crashes.map((crash) => crash.summary.incidentId)).not.toContain('by-executable');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('excludes a report modified before the window even when its timestamp is unparsable', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agemu-crashes-'));
    try {
      const file = path.join(directory, 'stale.ips');
      await writeFile(file, report(header({ timestamp: 'unparsable' })));
      await utimes(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
      const found = await findCrashReports({ directory, since: new Date('2026-09-30T00:00:00Z'), bundleId: 'com.example.app', limit: 10 });
      expect(found).toEqual({ crashes: [], skipped: 0 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('returns nothing when the reports directory is missing', async () => {
    const found = await findCrashReports({ directory: path.join(tmpdir(), 'agemu-missing-crash-dir', String(Date.now())), since: new Date(0), bundleId: 'com.example.app', limit: 10 });
    expect(found).toEqual({ crashes: [], skipped: 0 });
  });
});
