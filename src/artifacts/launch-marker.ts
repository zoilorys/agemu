import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type LaunchMarker = { at: string; udid: string; bundleId: string; source: string };

const markerFile = (root: string) => path.join(root, '.agemu', 'launch.json');

/** Records the latest agemu-initiated launch; written just before the launch is issued. */
export async function writeLaunchMarker(root: string, marker: { at: Date | string; udid: string; bundleId: string; source: string }): Promise<void> {
  const file = markerFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  const value: LaunchMarker = { ...marker, at: typeof marker.at === 'string' ? marker.at : marker.at.toISOString() };
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** The latest launch marker, or undefined when it is missing or invalid. */
export async function readLaunchMarker(root: string): Promise<LaunchMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(markerFile(root), 'utf8')) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return undefined;
    const { at, udid, bundleId, source } = value;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || typeof udid !== 'string' || typeof bundleId !== 'string' || typeof source !== 'string') return undefined;
    return { at, udid, bundleId, source };
  } catch { return undefined; }
}
