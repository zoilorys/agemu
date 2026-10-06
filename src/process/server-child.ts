import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { redact } from '../core/redact.js';

const [, , token, root, port, cli, log, secretsFile, expoMode] = process.argv;
if (!token || !root || !port || !cli || !log || !secretsFile) process.exit(2);
const secrets = JSON.parse(readFileSync(secretsFile, 'utf8')) as string[];
unlinkSync(secretsFile);
const longestSecret = Math.max(1, ...secrets.map(secret => secret.length));
const limit = 128 * 1024;
let raw = '';
function stripPartialSecretStart(value: string): string {
  let discard = 0;
  for (const secret of secrets.filter(Boolean)) {
    for (let length = 1; length < secret.length; length++) {
      if (value.startsWith(secret.slice(-length))) discard = Math.max(discard, length);
    }
  }
  return value.slice(discard);
}
const append = (chunk: string) => {
  raw += chunk;
  if (raw.length > limit + 2 * longestSecret) raw = stripPartialSecretStart(raw.slice(-(limit + longestSecret)));
  const safe = redact(raw, secrets).slice(0, -(longestSecret - 1) || undefined);
  writeFileSync(log, safe.slice(-limit), { mode: 0o600 });
};
// The caller's NODE_ENV describes the caller (e.g. "test" under Vitest), not this dev server; React Native's dev middleware refuses to start with NODE_ENV=test.
const { NODE_ENV: _callerNodeEnv, ...env } = process.env;
const child = spawn(process.execPath, [cli, 'start', ...(expoMode ? [`--${expoMode}`] : []), '--port', port], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.setEncoding('utf8').on('data', append);
child.stderr.setEncoding('utf8').on('data', append);
child.on('error', error => { append(error.message); process.exitCode = 1; });
child.on('close', code => {
  // All output is drained: finish the withheld suffix without exposing a chunk-split secret.
  writeFileSync(log, redact(raw, secrets).slice(-limit), { mode: 0o600 });
  process.exit(code ?? 1);
});
process.on('SIGTERM', () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); });
