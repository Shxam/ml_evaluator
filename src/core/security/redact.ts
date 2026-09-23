/**
 * Security and credential redaction utility.
 * Ensures API keys, tokens, and authorization headers are never
 * logged, persisted, or displayed in stdout/stderr/error messages.
 */

export function redactSecrets(input: string): string {
  if (!input || typeof input !== 'string') {
    return input;
  }

  let sanitized = input;

  // Redact specific EVOLINK_API_KEY if present in environment
  const apiKey = process.env.EVOLINK_API_KEY;
  if (apiKey && apiKey.length >= 4) {
    sanitized = sanitized.split(apiKey).join('[REDACTED]');
  }

  // Redact Bearer tokens: Bearer <token>
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]');

  // Redact secret keys matching common patterns: sk-...
  sanitized = sanitized.replace(/sk-[A-Za-z0-9_\-]{8,}/gi, '[REDACTED]');

  return sanitized;
}

export function sanitizeError(err: unknown): Error {
  if (err instanceof Error) {
    const cleanMessage = redactSecrets(err.message);
    const cleanError = new Error(cleanMessage);
    cleanError.name = err.name;
    if (err.stack) {
      cleanError.stack = redactSecrets(err.stack);
    }
    return cleanError;
  }
  return new Error(redactSecrets(String(err)));
}
