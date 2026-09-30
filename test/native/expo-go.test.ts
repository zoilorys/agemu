import { describe, expect, it } from 'vitest';
import { installedExpoGoHosts, installedExpoGoHost } from '../../src/native/expo-go.js';
import type { ProcessResult } from '../../src/process/run-process.js';

const output = `{
    "host.exp.Exponent" = {
        CFBundleIdentifier = "host.exp.Exponent";
        CFBundleDisplayName = "Expo Go";
        CFBundleExecutable = Exponent;
    };
    "com.vendor.preview" = {
        CFBundleIdentifier = "com.vendor.preview";
        CFBundleDisplayName = "Expo Go";
        CFBundleExecutable = Preview;
    };
    "com.other.app" = {
        CFBundleIdentifier = "com.other.app";
        CFBundleDisplayName = Other;
        CFBundleExecutable = Other;
    };
}`;
const runner = async (): Promise<ProcessResult> => ({ stdout: output, stderr: '', exitCode: 0, signal: null, startedAt: '', durationMs: 0 });

describe('Expo Go host discovery', () => {
  it('finds named host variants and resolves the selected executable', async () => {
    expect(await installedExpoGoHosts('PHONE', runner)).toEqual(['com.vendor.preview', 'host.exp.Exponent']);
    expect(await installedExpoGoHost('PHONE', 'com.vendor.preview', runner)).toMatchObject({ executableName: 'Preview' });
    await expect(installedExpoGoHost('PHONE', 'com.missing', runner)).rejects.toThrow(/not installed/);
  });
});
