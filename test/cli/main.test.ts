import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
    const { stdout, stderr } = await run(process.execPath, [cli, '--help']);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout).data.help).toContain('ui run               Execute a JSON UI action plan.');
    expect(JSON.parse(stdout).data.help).toContain('app open-url         Open a URL in Simulator.');
    await expect(run(process.execPath, [cli, '--version'])).resolves.toMatchObject({
      stdout: '{"ok":true,"data":{"version":"0.1.2"}}\n',
      stderr: '',
    });
  });

  it('explains command options without requiring app configuration', async () => {
    const { stdout } = await run(process.execPath, [cli, 'logs', '--help']);
    const help = JSON.parse(stdout).data.help as string;
    expect(help).toContain('--last accepts a number followed by s, m, h, or d');
    expect(help).toContain('--level accepts default, info, debug, error, or fault');
  });

  it('requires a plan source for UI runs', async () => {
    await expect(run(process.execPath, [cli, 'ui', 'run']))
      .rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('"code":"UI_VALIDATION_FAILED"'),
        stderr: '',
      });
  });

  it('validates inline UI plans before starting the runner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'fixture' },
    }));
    try {
      await expect(run(process.execPath, [cli, 'ui', 'run', '--plan-json={"version":1,"actions":[]}'], { cwd: root }))
        .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"code":"UI_VALIDATION_FAILED"') });
      await expect(run(process.execPath, [cli, 'ui', 'run', '--plan=file.json', '--plan-json={}'], { cwd: root }))
        .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Use either --plan or --plan-json') });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes Expo Go UI launch to its installed host', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-ui-'));
    const calls = path.join(root, 'calls.txt');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'expo', root: '.', port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' }, simulator: { udid: 'PHONE' },
    }));
    await writeFile(path.join(root, 'idb'), `#!/bin/sh\necho "idb $*" >> "${calls}"\nif [ "$1" = "ui" ] && [ "$2" = "describe-all" ]; then echo '[]'; fi\n`);
    await writeFile(path.join(root, 'xcrun'), `#!/bin/sh\necho "xcrun $*" >> "${calls}"\n`);
    await chmod(path.join(root, 'idb'), 0o755);
    await chmod(path.join(root, 'xcrun'), 0o755);
    try {
      const { stdout } = await run(process.execPath, [cli, 'ui', 'run', '--backend=idb', '--plan-json={"version":1,"actions":[{"launch":{}}]}'], { cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` } });
      expect(JSON.parse(stdout).data.backend).toBe('idb');
      const invoked = await readFile(calls, 'utf8');
      expect(invoked).toContain('xcrun simctl launch PHONE host.exp.Exponent');
    } finally { await rm(root, { recursive: true, force: true }); }
  });


  it('routes Expo Go logs and diagnose through host-aware handlers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-diagnostics-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'expo', root: '.', port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' }, simulator: { udid: 'PHONE' },
    }));
    await writeFile(path.join(root, 'xcrun'), `#!/bin/sh
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"PHONE","name":"iPhone","state":"Booted","isAvailable":true}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "listapps" ]; then
  echo '{ "host.exp.Exponent" = { CFBundleIdentifier = "host.exp.Exponent"; CFBundleExecutable = Exponent; }; }'
elif [ "$1" = "simctl" ] && [ "$2" = "spawn" ]; then
  echo 'Expo host log'
fi
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    const env = { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` };
    try {
      const logs = JSON.parse((await run(process.execPath, [cli, 'logs', 'show'], { cwd: root, env })).stdout);
      expect(logs.data).toMatchObject({ bundleId: 'host.exp.Exponent', logs: ['Expo host log'] });
      const diagnosis = JSON.parse((await run(process.execPath, [cli, 'diagnose'], { cwd: root, env })).stdout);
      expect(diagnosis.data).toMatchObject({ bundleId: 'host.exp.Exponent', evidence: { host: { bundleId: 'host.exp.Exponent' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('shows normalized config without its internal root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'fixture' }, redactions: ['actual-secret'],
    }));
    try {
      const { stdout } = await run(process.execPath, [cli, 'config', 'show'], { cwd: root });
      const normalizedRoot = await realpath(root);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        data: {
          version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: path.join(normalizedRoot, 'App.xcodeproj'), scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' }, simulator: { udid: 'fixture' },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('envelopes missing process tools from a command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app' },
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

  it('routes Expo build and install through their workflow handlers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-cli-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'expo', root: '.', port: 8081, launchTarget: 'development-build', bundleId: 'com.example.expo' }, simulator: { udid: 'fixture' },
    }));
    try {
      await expect(run(process.execPath, [cli, 'build'], { cwd: root })).rejects.toMatchObject({
        code: 1, stdout: expect.stringContaining('Local Expo CLI is missing'),
      });
      await expect(run(process.execPath, [cli, 'app', 'install'], { cwd: root })).rejects.toMatchObject({
        code: 1, stdout: expect.stringContaining('APP_NOT_BUILT'),
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('envelopes a failing fixture process from a command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const executable = path.join(root, 'xcodebuild');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app' },
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
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app' },
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
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app' },
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
      version: 2 as const, platform: 'ios' as const, app: { type: 'native' as const, project: 'App.xcodeproj',
      scheme: 'App',
      configuration: 'Debug',
      bundleId: 'com.example.app' },
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
