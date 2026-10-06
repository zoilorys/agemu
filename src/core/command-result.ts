import type { LoadedConfig } from '../config/config.js';
import { targetBundleId } from '../config/config.js';
export type CommandTarget = 'app' | 'device' | 'none';
export type CommandArtifacts = {
  screenshots: string[]; recordings: string[]; logs: string[]; reports: string[]; files: string[];
  transcript: string | null; backend: Record<string, unknown> | null;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => typeof value === 'string'))];

/** Add common metadata at the CLI boundary, preserving every command-specific alias and evidence field. */
export function commandResult(value: unknown, options: { key: string; target: CommandTarget; config?: LoadedConfig; capturedAt?: string }) {
  const data = record(value);
  const evidence = record(data.evidence);
  const observation = record(evidence.observation);
  const logEvidence = record(evidence.logs);
  const server = record(evidence.server);
  const logAliases = record(data.logs);
  const reports = [...(Array.isArray(data.crashes) ? data.crashes : []), ...(Array.isArray(record(evidence.crashes).crashes) ? record(evidence.crashes).crashes as unknown[] : [])];
  const logs = unique([string(logAliases.build), string(logAliases.settings), string(data.log), string(logEvidence.artifact), string(server.outputSource),
    ...(options.key.startsWith('logs ') ? [string(data.artifact)] : [])]);
  const artifacts: CommandArtifacts = {
    screenshots: unique([...strings(data.screenshots), string(data.screenshot), string(observation.screenshot)]),
    recordings: strings(data.recordings), logs, reports: unique(reports.map(report => string(record(report).file))),
    files: unique([string(data.payload), string(data.file), string(data.manifest),
      ...(!options.key.startsWith('logs ') ? [string(data.artifact)] : [])]),
    transcript: string(data.transcript), backend: data.backendArtifacts === undefined ? null : record(data.backendArtifacts),
  };
  const udid = options.target === 'none' ? null : string(data.udid) ?? string(record(data.device).udid) ?? string(record(data.simulator).udid)
    ?? string(record(data.created).udid) ?? string(data.deleted) ?? string(data.erased) ?? string(record(evidence.simulator).udid);
  const bundleId = Object.hasOwn(data, 'bundleId') ? string(data.bundleId)
    : options.target === 'app' && options.config ? targetBundleId(options.config) : null;
  return { ...data, action: string(data.action) ?? options.key.split(' ').at(-1)!, udid, bundleId,
    run: string(data.run), capturedAt: string(data.capturedAt) ?? string(data.generatedAt) ?? options.capturedAt ?? new Date().toISOString(), artifacts };
}
