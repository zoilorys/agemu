import path from 'node:path';
import { nativeApp, type LoadedConfig } from '../config/config.js';

export type BuildProduct = { appPath: string; bundleId: string; executableName: string; target: string };

export function buildArguments(config: LoadedConfig, udid: string, action: 'build' | 'settings'): string[] {
  const source = nativeApp(config).workspace
    ? ['-workspace', nativeApp(config).workspace!]
    : ['-project', nativeApp(config).project!];
  return [
    ...source,
    '-scheme', nativeApp(config).scheme,
    '-configuration', nativeApp(config).configuration,
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', path.join(config.root, '.agemu', 'DerivedData'),
    ...(action === 'build' ? ['build'] : ['-showBuildSettings']),
  ];
}

export function parseBuildProducts(output: string): BuildProduct[] {
  const products: BuildProduct[] = [];
  let target = '';
  let settings: Record<string, string> = {};
  const add = () => {
    const directory = settings.TARGET_BUILD_DIR;
    const wrapper = settings.WRAPPER_NAME;
    const bundleId = settings.PRODUCT_BUNDLE_IDENTIFIER;
    const executableName = settings.EXECUTABLE_NAME;
    if (target && directory && wrapper && bundleId && executableName) {
      products.push({ target, appPath: path.join(directory, wrapper), bundleId, executableName });
    }
    settings = {};
  };

  for (const line of output.split(/\r?\n/)) {
    const heading = line.match(/^Build settings for action .* and target (.+):$/);
    if (heading) {
      add();
      target = heading[1];
      continue;
    }
    const setting = line.match(/^\s+([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (setting) settings[setting[1]] = setting[2].trim();
  }
  add();
  return products;
}

export function selectBuildProduct(output: string, bundleId: string): BuildProduct {
  const matches = parseBuildProducts(output).filter((product) => product.bundleId === bundleId && product.appPath.endsWith('.app'));
  if (matches.length !== 1) {
    throw new Error(`Expected one app product for ${bundleId}, found ${matches.length}`);
  }
  return matches[0];
}
