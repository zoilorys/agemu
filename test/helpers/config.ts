import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Write a project's agemu config to .agemu/config.json under root. */
export async function writeConfig(root: string, content: string): Promise<void> {
  await mkdir(path.join(root, '.agemu'), { recursive: true });
  await writeFile(path.join(root, '.agemu', 'config.json'), content);
}
