import { redact } from '../core/redact.js';

const normalize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Redact before normalization/truncation so stored names agree with public evidence paths. */
export function uiArtifactStem(name: unknown, fallback: string, secrets: string[] = []): string {
  const raw = typeof name === 'string' && name ? name : fallback;
  // Normalized spellings also conceal names that already replaced spaces/punctuation with underscores.
  const normalizedSecrets = secrets.filter(Boolean).map(normalize);
  const stem = normalize(redact(normalize(redact(raw, secrets)), normalizedSecrets)).slice(0, 80);
  const conceal = (value: string) => {
    // A secret may itself occur in the replacement marker. Removing it keeps later output redaction stable.
    let previous: string;
    do {
      previous = value;
      for (const secret of secrets.filter(Boolean)) value = value.replaceAll(secret, '');
    } while (value !== previous);
    return value;
  };
  return conceal(stem) || conceal(normalize(redact(fallback, secrets)).slice(0, 80));
}
