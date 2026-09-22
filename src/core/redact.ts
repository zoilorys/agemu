const replacement = '[REDACTED]';

export function redact(value: string, secrets: string[] = []): string {
  return secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, replacement), value);
}
