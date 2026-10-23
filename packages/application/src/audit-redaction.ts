/** The same boundary protects new persistence and exports of historic rows. */
export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:password|passphrase|credential|authorization|privatekey|apikey|token|secret)/i.test(key.replace(/[^a-z0-9]/gi, '')) && typeof item !== 'boolean'
      ? '[REDACTED]' : redactAuditValue(item)]));
  if (typeof value !== 'string') return value;
  try {
    const structured: unknown = JSON.parse(value);
    if (structured && typeof structured === 'object') return JSON.stringify(redactAuditValue(structured));
  } catch { /* Plain audit prose. */ }
  if (/\b(?:password|passphrase|credential|private[-_ ]?key|api[-_ ]?key|token|secret)\s*[:=]/i.test(value)) return '[REDACTED]';
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})/.test(value)) return '[REDACTED]';
  return value.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:password|token|api[_-]?key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
}
