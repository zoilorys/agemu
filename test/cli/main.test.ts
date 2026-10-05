import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const simulatorDevices = (udid: string, state = 'Booted') => ({ devices: {
  'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid, name: 'Phone', state, isAvailable: true }],
} });

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
      stdout: '{"ok":true,"data":{"version":"0.2.0"}}\n',
      stderr: '',
    });
  });

  it('explains command options without requiring app configuration', async () => {
    const { stdout } = await run(process.execPath, [cli, 'logs', '--help']);
    const help = JSON.parse(stdout).data.help as string;
    expect(help).toContain('--last accepts a number followed by s, m, h, or d');
    expect(help).toContain('--level accepts default, info, debug, error, or fault');
  });

  it.each([
    ['build', '--timeout=0'], ['build', '--timeout=-1'], ['build', '--timeout=1.5'], ['build', '--timeout=86401'],
    ['ui build-runner', '--timeout=abc'], ['ui run', '--timeout=0'],
  ])('rejects %s %s before loading configuration', async (command, flag) => {
    await expect(run(process.execPath, [cli, ...command.split(' '), flag, ...(command === 'ui run' ? ['--plan-json={}'] : [])]))
      .rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('"code":"COMMAND_INVALID","message":"--timeout must be whole seconds from 1 to 86400"'),
      });
  });

  it.each([
    [['--bogus'], 'COMMAND_INVALID', 'Unknown option --bogus for ui inspect'],
    [['--all=yes'], 'COMMAND_INVALID', '--all does not take a value'],
    [['--backend=fast'], 'UI_VALIDATION_FAILED', 'UI backend must be auto, idb, or xctest'],
    [['--timeout=0'], 'COMMAND_INVALID', '--timeout must be whole seconds from 1 to 86400'],
  ])('rejects ui inspect %j before loading configuration', async (flags, code, message) => {
    await expect(run(process.execPath, [cli, 'ui', 'inspect', ...flags]))
      .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(`"code":"${code}","message":"${message}"`) });
  });

  it('documents timeout defaults in command help', async () => {
    expect(JSON.parse((await run(process.execPath, [cli, 'build', '--help'])).stdout).data.help).toContain('default 1800 s');
    const ui = JSON.parse((await run(process.execPath, [cli, 'ui', '--help'])).stdout).data.help as string;
    expect(ui).toContain('--timeout defaults to 900 s');
    expect(ui).toContain('including a runner build (default 900 s');
  });

  it.each([
    [['clean'], 'clean requires --runs, --derived-data, or both'],
    [['clean', '--derived-data', '--older-than=1d'], '--older-than requires --runs'],
    [['clean', '--runs', '--older-than=1w'], '--older-than must be a number followed by s, m, h, or d'],
  ])('rejects %j before loading configuration', async (argv, message) => {
    await expect(run(process.execPath, [cli, ...argv]))
      .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(`"code":"COMMAND_INVALID","message":"${message}`) });
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

  it('routes Expo Go UI launch to its installed host and verified project URL', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-expo-ui-'));
    const resolvedRoot = await realpath(root);
    const calls = path.join(root, 'calls.txt');
    const { createServer } = await import('node:http');
    const project = createServer((request, response) => {
      if (request.url === '/status') response.end('packager-status:running');
      else if (request.url?.startsWith('/_expo/open?')) response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ url: `exp://127.0.0.1:${port}` }));
      else response.writeHead(404).end();
    });
    await new Promise<void>(resolve => project.listen(0, '127.0.0.1', resolve));
    const port = (project.address() as { port: number }).port;
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'expo', root: '.', port, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' }, simulator: { udid: 'PHONE' },
    }));
    await writeFile(path.join(root, 'idb'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'idb ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'ui' && process.argv[3] === 'describe-all') process.stdout.write('[]');
`);
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'xcrun ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(simulatorDevices('PHONE')))});
`);
    // The isolated process fixture supplies the external listener's project identity.
    await writeFile(path.join(root, 'lsof'), `#!${process.execPath}
process.stdout.write(process.argv.includes('-Fn') ? ${JSON.stringify('n'+resolvedRoot+'\n')} : ${JSON.stringify(String(process.pid))});
`);
    await Promise.all(['idb', 'xcrun', 'lsof'].map(name => chmod(path.join(root, name), 0o755)));
    try {
      const { stdout } = await run(process.execPath, [cli, 'ui', 'run', '--backend=idb', '--plan-json={"version":1,"actions":[{"launch":{}}]}'], { cwd: root, env: { ...process.env, PATH: root } });
      expect(JSON.parse(stdout).data).toMatchObject({ backend: 'idb', bundleId: 'host.exp.Exponent', actions: 1, completed: 1 });
      const invoked = await readFile(calls, 'utf8');
      expect(invoked).toContain('xcrun simctl launch PHONE host.exp.Exponent');
      expect(invoked).toContain(`xcrun simctl openurl PHONE exp://127.0.0.1:${port}`);
    } finally {
      project.closeAllConnections();
      await new Promise<void>(resolve => project.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
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
      expect(JSON.parse(stdout).data).not.toHaveProperty('root');
      expect(JSON.parse(stdout).data).not.toHaveProperty('redactions');
      expect(JSON.parse(stdout).data).toMatchObject({ action: 'show', udid: null, bundleId: null, run: null });
      expect(JSON.parse(stdout)).toMatchObject({
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
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(simulatorDevices('fixture')))});
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    const env = { PATH: root };
    try {
      await expect(run(process.execPath, [cli, 'build'], { cwd: root, env })).rejects.toMatchObject({
        code: 1, stdout: expect.stringContaining('Local Expo CLI is missing'),
      });
      await expect(run(process.execPath, [cli, 'app', 'install'], { cwd: root, env })).rejects.toMatchObject({
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

  it('records a failed build as a redacted error event that diagnose reports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { udid: 'fixture' }, redactions: ['xcodebuild'],
    }));
    await writeFile(path.join(root, 'xcodebuild'), `#!${process.execPath}\nprocess.exit(65);\n`);
    await chmod(path.join(root, 'xcodebuild'), 0o755);
    try {
      await expect(run(process.execPath, [cli, 'build'], { cwd: root, env: { PATH: root } }))
        .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"code":"BUILD_FAILED"') });
      const lines = (await readFile(path.join(root, '.agemu', 'events.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event).toMatchObject({ command: 'build', status: 'error', error: { code: 'BUILD_FAILED', message: '[REDACTED] failed' }, details: { exitCode: 65 } });
      expect(typeof event.durationMs).toBe('number');
      expect(lines[0]).not.toContain('xcodebuild');
      const diagnosis = JSON.parse((await run(process.execPath, [cli, 'diagnose'], { cwd: root, env: { PATH: root } })).stdout);
      expect(diagnosis.data.evidence.recentErrors).toContainEqual(expect.objectContaining({ command: 'build', error: expect.objectContaining({ code: 'BUILD_FAILED' }) }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records a successful app launch once and does not double-record observe', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { udid: 'PHONE' },
    }));
    const devices = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'PHONE', name: 'Phone', state: 'Booted', isAvailable: true }] } };
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(devices))});
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    const events = async () => (await readFile(path.join(root, '.agemu', 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    try {
      expect(JSON.parse((await run(process.execPath, [cli, 'app', 'launch'], { cwd: root, env: { PATH: root } })).stdout).ok).toBe(true);
      expect(await events()).toEqual([expect.objectContaining({ command: 'app launch', status: 'ok', summary: { udid: 'PHONE', bundleId: 'com.example.app', action: 'launch' } })]);
      expect(JSON.parse((await run(process.execPath, [cli, 'observe'], { cwd: root, env: { PATH: root } })).stdout).ok).toBe(true);
      const after = await events();
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ command: 'observe', status: 'ok' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts configured secrets from success and --debug failure envelopes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const failFlag = path.join(root, 'fail');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.secret-app.x' },
      simulator: { udid: 'PHONE' }, redactions: ['secret-app'],
    }));
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(simulatorDevices('PHONE')))});
if (process.argv[3] === 'launch') {
  process.stderr.write('launch denied for secret-app');
  if (require('node:fs').existsSync(${JSON.stringify(failFlag)})) process.exit(1);
}
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    try {
      const success = await run(process.execPath, [cli, 'app', 'launch'], { cwd: root, env: { PATH: root } });
      expect(success.stdout).not.toContain('secret-app');
      expect(JSON.parse(success.stdout)).toMatchObject({ ok: true, data: { action: 'launch', udid: 'PHONE', bundleId: 'com.[REDACTED].x' } });
      await writeFile(failFlag, '');
      const failure = await run(process.execPath, [cli, 'app', 'launch', '--debug'], { cwd: root, env: { PATH: root } })
        .then(() => undefined, (error: { code: number; stdout: string }) => error);
      expect(failure?.code).toBe(1);
      const envelope = JSON.parse(failure!.stdout);
      expect(envelope.error.stack).toEqual(expect.any(String));
      expect(failure!.stdout).not.toContain('secret-app');
      expect(failure!.stdout).toContain('[REDACTED]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts an unredacted handler error message and its --debug stack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { udid: 'PHONE' }, redactions: ['secret-app'],
    }));
    try {
      const failure = await run(process.execPath, [cli, 'ui', 'run', `--plan=${path.join(root, 'secret-app-plan.json')}`, '--debug'], { cwd: root, env: { PATH: root } })
        .then(() => undefined, (error: { code: number; stdout: string }) => error);
      expect(failure?.code).toBe(1);
      const { error } = JSON.parse(failure!.stdout);
      expect(error.code).toBe('UI_VALIDATION_FAILED');
      expect(error.stack).toEqual(expect.any(String));
      expect(failure!.stdout).not.toContain('secret-app');
      expect(error.message).toContain('[REDACTED]');
      expect(error.stack).toContain('[REDACTED]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a successful command successful when its event cannot be recorded', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { udid: 'PHONE' },
    }));
    await mkdir(path.join(root, '.agemu', 'events.jsonl'), { recursive: true });
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(simulatorDevices('PHONE')))});
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    try {
      const { stdout, stderr } = await run(process.execPath, [cli, 'app', 'terminate'], { cwd: root, env: { PATH: root } });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { action: 'terminate', udid: 'PHONE', bundleId: 'com.example.app' } });
      expect(stderr).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a stopped configured Simulator without attempting an app launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-stopped-app-'));
    const calls = path.join(root, 'calls.txt');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { udid: 'PHONE' },
    }));
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(simulatorDevices('PHONE', 'Shutdown')))});
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    try {
      const failure = await run(process.execPath, [cli, 'app', 'launch'], { cwd: root, env: { PATH: root } })
        .then(() => undefined, (error: { code: number; stdout: string; stderr: string }) => error);
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toBe('');
      expect(JSON.parse(failure!.stdout).error).toMatchObject({ code: 'SIMULATOR_NOT_BOOTED', details: { udid: 'PHONE', state: 'Shutdown' } });
      expect(await readFile(calls, 'utf8')).not.toContain('simctl launch');
      await expect(readFile(path.join(root, '.agemu', 'launch.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
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

  it('selects the named Simulator from space-separated name and runtime options', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const executable = path.join(root, 'xcrun');
    const calls = path.join(root, 'calls.txt');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { name: 'Configured Phone', runtime: 'iOS-18-0' },
    }));
    const devices = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'CONFIGURED-NAME', name: 'Configured Phone', state: 'Booted', isAvailable: true },
          { udid: 'EXPLICIT-NAME', name: 'Named Phone', state: 'Booted', isAvailable: true },
        ],
      },
    };
    await writeFile(executable, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(devices))});
`);
    await chmod(executable, 0o755);
    try {
      const { stdout } = await run(process.execPath, [cli, 'simulator', 'shutdown', '--name', 'Named Phone', '--runtime', 'iOS-18-0'], {
        cwd: root,
        env: { PATH: root },
      });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { action: 'shutdown', device: { udid: 'EXPLICIT-NAME' } } });
      const invoked = await readFile(calls, 'utf8');
      expect(invoked).toContain('simctl shutdown EXPLICIT-NAME');
      expect(invoked).not.toContain('CONFIGURED-NAME');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty --udid without shutting down any Simulator', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const calls = path.join(root, 'calls.txt');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { udid: 'CONFIGURED' },
    }));
    const devices = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'CONFIGURED', name: 'Configured Phone', state: 'Booted', isAvailable: true }] } };
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(devices))});
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    try {
      await expect(run(process.execPath, [cli, 'simulator', 'shutdown', '--udid='], { cwd: root, env: { PATH: root } }))
        .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"code":"COMMAND_INVALID"') });
      expect(await readFile(calls, 'utf8').catch(() => '')).not.toContain('simctl shutdown');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [['logs', 'show', '--limit='], 'COMMAND_INVALID'],
    [['logs', 'show', '--limit=abc'], 'COMMAND_INVALID'],
    [['simulator', 'shutdown', '--runtime=iOS-18-0'], 'COMMAND_INVALID'],
    [['setup', '--udid='], 'COMMAND_INVALID'],
    [['setup', '--port=0'], 'COMMAND_INVALID'],
    [['setup', '--port=65536'], 'COMMAND_INVALID'],
    [['setup', '--port=abc'], 'COMMAND_INVALID'],
    [['ui', 'run', '--plan-json={}', '--backend=bogus'], 'UI_VALIDATION_FAILED'],
  ])('rejects invalid option values for %j', async (argv, code) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    try {
      await expect(run(process.execPath, [cli, ...argv], { cwd: root, env: { PATH: root } }))
        .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(`"code":"${code}"`) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs no simctl command for app uninstall without --yes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const calls = path.join(root, 'calls.txt');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'native', project: 'App.xcodeproj', scheme: 'App', configuration: 'Debug', bundleId: 'com.example.app' },
      simulator: { udid: 'PHONE' },
    }));
    const devices = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'PHONE', name: 'Phone', state: 'Booted', isAvailable: true }] } };
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(devices))});
`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    const invoked = () => readFile(calls, 'utf8').catch(() => '');
    try {
      const failure = await run(process.execPath, [cli, 'app', 'uninstall'], { cwd: root, env: { PATH: root } })
        .then(() => undefined, (error: { code: number; stdout: string }) => error);
      expect(failure?.code).toBe(1);
      expect(JSON.parse(failure!.stdout).error).toMatchObject({ code: 'COMMAND_INVALID', message: expect.stringContaining('com.example.app') });
      expect(await invoked()).toBe('');
      const { stdout } = await run(process.execPath, [cli, 'app', 'uninstall', '--yes'], { cwd: root, env: { PATH: root } });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { action: 'uninstall', udid: 'PHONE', bundleId: 'com.example.app' } });
      expect(await invoked()).toContain('simctl uninstall PHONE com.example.app');
      const events = (await readFile(path.join(root, '.agemu', 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(events.map((event) => [event.command, event.status])).toEqual([['app uninstall', 'error'], ['app uninstall', 'ok']]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses app uninstall for Expo Go before the --yes guard and runs no simctl command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agemu-cli-test-'));
    const calls = path.join(root, 'calls.txt');
    await writeFile(path.join(root, '.agemu.json'), JSON.stringify({
      version: 2, platform: 'ios', app: { type: 'expo', root: '.', port: 8081, launchTarget: 'expo-go', hostBundleId: 'host.exp.Exponent' }, simulator: { udid: 'PHONE' },
    }));
    await writeFile(path.join(root, 'xcrun'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\n`);
    await chmod(path.join(root, 'xcrun'), 0o755);
    try {
      const failure = await run(process.execPath, [cli, 'app', 'uninstall'], { cwd: root, env: { PATH: root } })
        .then(() => undefined, (error: { code: number; stdout: string }) => error);
      expect(failure?.code).toBe(1);
      expect(JSON.parse(failure!.stdout).error.code).toBe('WORKFLOW_UNSUPPORTED');
      expect(await readFile(calls, 'utf8').catch(() => '')).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists every app subcommand when none is given', async () => {
    const result = await run(process.execPath, [cli, 'app']).then(() => undefined, (error: { code: number; stdout: string }) => error);
    expect(result?.code).toBe(1);
    const output = JSON.parse(result!.stdout);
    expect(output.error.code).toBe('COMMAND_INVALID');
    for (const name of ['install', 'launch', 'terminate', 'restart', 'open-url']) expect(output.error.message).toContain(name);
  });
});
