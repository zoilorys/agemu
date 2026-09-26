import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { redact } from '../core/redact.js';

const [, , token, root, port, cli, log, secretsFile] = process.argv;
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
const append = (chunk: Buffer) => {
  raw += chunk.toString();
  if (raw.length > limit + 2 * longestSecret) raw = stripPartialSecretStart(raw.slice(-(limit + longestSecret)));
  const safe = redact(raw, secrets).slice(0, -(longestSecret - 1) || undefined);
  writeFileSync(log, safe.slice(-limit), { mode: 0o600 });
};
const child = spawn(process.execPath, [cli, 'start', ...(cli.includes('/expo/') ? ['--dev-client'] : []), '--port', port], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', append);
child.stderr.on('data', append);
child.on('error', error => { append(Buffer.from(error.message)); process.exitCode = 1; });
child.on('exit', code => { process.exit(code ?? 1); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); });
