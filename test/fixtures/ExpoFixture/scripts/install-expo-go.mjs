// Installs the official Expo Go Simulator client for this fixture's SDK on one Simulator UDID.
// Usage: node scripts/install-expo-go.mjs <UDID>
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const udid = process.argv[2];
if (!udid) throw new Error('usage: node scripts/install-expo-go.mjs <UDID>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expo = JSON.parse(readFileSync(path.join(root, 'node_modules/expo/package.json'), 'utf8')).version;
const sdk = `${expo.split('.')[0]}.0.0`;

const response = await fetch('https://api.expo.dev/v2/versions');
if (!response.ok) throw new Error(`Expo versions API returned HTTP ${response.status}`);
const body = await response.json();
const release = (body.data ?? body).sdkVersions?.[sdk];
if (!release?.iosClientUrl) throw new Error(`Expo versions API lists no iOS client for SDK ${sdk}`);

const directory = path.join(root, '.expo-go', release.iosClientVersion);
const app = path.join(directory, 'Expo Go.app');
rmSync(directory, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
const archive = path.join(directory, 'client.tar.gz');
const download = await fetch(release.iosClientUrl);
if (!download.ok) throw new Error(`Expo Go download returned HTTP ${download.status}`);
writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
execFileSync('tar', ['xzf', archive, '-C', app]);
const bundleId = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Info.plist')], { encoding: 'utf8' }).trim();
if (bundleId !== 'host.exp.Exponent') throw new Error(`unexpected Expo Go bundle ID ${bundleId}`);
execFileSync('xcrun', ['simctl', 'install', udid, app], { stdio: 'inherit' });
console.log(JSON.stringify({ sdk, expoGo: release.iosClientVersion, url: release.iosClientUrl, udid, bundleId }));
