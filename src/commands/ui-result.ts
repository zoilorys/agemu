import { redactValue } from '../artifacts/runs.js';
import { redact } from '../core/redact.js';
import { CliError, type ErrorCode } from '../core/errors.js';
import type { Inspection } from './ui-elements.js';

export type FailedAction = { index: number; kind: string; message: string };
export type UiEvidence = { completed: number; screenshots: string[]; recordings: string[]; inspections: Inspection[] };
export type UiRunResult = Record<string, unknown> & UiEvidence & {
  run: string; udid: string; backend: 'idb' | 'xctest'; bundleId: string; actions: number; transcript: string;
  runnerResult: { completed: number; bundleId: string; inspections: Inspection[] };
  backendArtifacts: Record<string, unknown>;
};
export type UiFailureDetails = Record<string, unknown> & UiEvidence & { failedAction: FailedAction | null; transcript: string | null };

/** One public shape; backend aliases remain available for older clients. Redact at the output boundary. */
export function uiResult(base: Pick<UiRunResult, 'run' | 'udid' | 'backend' | 'bundleId' | 'actions' | 'transcript'>,
  evidence: UiEvidence, backendArtifacts: Record<string, unknown> = {}): UiRunResult {
  return { ...base, ...evidence, backendArtifacts, ...backendArtifacts,
    runnerResult: { completed: evidence.completed, bundleId: base.bundleId, inspections: evidence.inspections } };
}

export function uiFailure(code: ErrorCode, message: string, evidence: Partial<UiFailureDetails> = {}): CliError {
  return new CliError(code, message, { failedAction: null, completed: 0, screenshots: [], recordings: [], inspections: [],
    transcript: null, ...evidence });
}

export function actionKind(action: unknown): string {
  return typeof action === 'object' && action !== null && !Array.isArray(action) ? Object.keys(action)[0] ?? 'unknown' : 'unknown';
}
export function failureMessage(failed: FailedAction): string {
  return `UI action ${failed.index} (${failed.kind}) failed: ${failed.message}`;
}

/** Encoded runner markers contain UI text too; plain substring redaction cannot protect them. */
export function uiTranscript(text: string, secrets: string[]): string {
  const markers = text.replace(/AGEMU_(RESULT|INSPECTION|FAILURE|LAUNCH):([A-Za-z0-9+/=]+)/g, (marker, kind: string, encoded: string) => {
    try {
      const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown;
      return `AGEMU_${kind}:${Buffer.from(JSON.stringify(redactValue(value, secrets))).toString('base64')}`;
    } catch { return `AGEMU_${kind}:[INVALID_MARKER]`; }
  });
  return redact(markers, secrets);
}
