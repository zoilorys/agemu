import { execFile } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));

describe('agemu CLI', () => {
  it('returns a stable JSON error and nonzero status for an unknown command', async () => {
    await expect(run(process.execPath, [cli, 'not-a-command']))
      .rejects.toMatchObject({
        code: 1,
        stdout: '{"ok":false,"error":{"code":"COMMAND_INVALID","message":"Unknown command: not-a-command"}}\n',
        stderr: '',
      });
  });

  it('returns JSON for help and version metadata', async () => {
    await expect(run(process.execPath, [cli, '--help'])).resolves.toMatchObject({
      stdout: '{"ok":true,"data":{"help":"agemu [--pretty] [--debug] <command>"}}\n',
      stderr: '',
    });
    await expect(run(process.execPath, [cli, '--version'])).resolves.toMatchObject({
      stdout: '{"ok":true,"data":{"version":"0.1.1"}}\n',
      stderr: '',
    });
  });

  it('requires a plan file for UI runs', async () => {
    await expect(run(process.execPath, [cli, 'ui', 'run']))
      .rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('"code":"UI_VALIDATION_FAILED"'),
        stderr: '',
      });
  });

  it('shows normalized config without its internal root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 1, project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app', simulator: { udid: 'fixture' }, redactions: ['actual-secret'],
    }));
    try {
      const { stdout } = await run(process.execPath, [cli, 'config', 'show'], { cwd: root });
      const normalizedRoot = await realpath(root);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        data: {
          version: 1, project: path.join(normalizedRoot, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app', simulator: { udid: 'fixture' },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('envelopes missing process tools from a command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 1,
      project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app',
      simulator: { udid: 'fixture' },
    }));
    try {
      await expect(run(process.execPath, [cli, 'build'], { cwd: root, env: { PATH: root } }))
        .rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining('"code":"BUILD_FAILED"'),
          stderr: '',
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('envelopes a failing fixture process from a command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const executable = path.join(root, 'xcodebuild');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 1,
      project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app',
      simulator: { udid: 'fixture' },
    }));
    await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write("fixture failure"); process.exit(23);\n`);
    await chmod(executable, 0o755);
    try {
      await expect(run(process.execPath, [cli, 'build'], { cwd: root, env: { PATH: root } }))
        .rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining('"code":"BUILD_FAILED"'),
          stderr: '',
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses a configured UDID before an explicit name selector', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const executable = path.join(root, 'xcrun');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 1,
      project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app',
      simulator: { udid: 'CONFIGURED' },
    }));
    const devices = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'CONFIGURED', name: 'Configured Phone', state: 'Shutdown', isAvailable: true },
          { udid: 'EXPLICIT-NAME', name: 'Named Phone', state: 'Shutdown', isAvailable: true },
        ],
      },
    };
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(devices))});\n`);
    await chmod(executable, 0o755);
    try {
      const { stdout } = await run(process.execPath, [cli, 'simulator', 'shutdown', '--name=Named Phone', '--runtime=iOS-18-0'], {
        cwd: root,
        env: { PATH: root },
      });
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: { action: 'shutdown', device: { udid: 'CONFIGURED' } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses an explicit UDID before the configured UDID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const executable = path.join(root, 'xcrun');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 1,
      project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app',
      simulator: { udid: 'CONFIGURED' },
    }));
    const devices = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'CONFIGURED', name: 'Configured Phone', state: 'Shutdown', isAvailable: true },
          { udid: 'EXPLICIT', name: 'Explicit Phone', state: 'Shutdown', isAvailable: true },
        ],
      },
    };
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(devices))});\n`);
    await chmod(executable, 0o755);
    try {
      const { stdout } = await run(process.execPath, [cli, 'simulator', 'shutdown', '--udid=EXPLICIT'], {
        cwd: root,
        env: { PATH: root },
      });
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: { action: 'shutdown', device: { udid: 'EXPLICIT' } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses an explicit name-runtime pair before the configured pair', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const executable = path.join(root, 'xcrun');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 1,
      project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app',
      simulator: { name: 'Configured Phone', runtime: 'iOS-18-0' },
    }));
    const devices = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'CONFIGURED-NAME', name: 'Configured Phone', state: 'Shutdown', isAvailable: true },
          { udid: 'EXPLICIT-NAME', name: 'Named Phone', state: 'Shutdown', isAvailable: true },
        ],
      },
    };
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(devices))});\n`);
    await chmod(executable, 0o755);
    try {
      const { stdout } = await run(process.execPath, [cli, 'simulator', 'shutdown', '--name=Named Phone', '--runtime=iOS-18-0'], {
        cwd: root,
        env: { PATH: root },
      });
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: { action: 'shutdown', device: { udid: 'EXPLICIT-NAME' } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
