const PRIVATE_IPV4_RE =
  /\b(?:(?:192\.168|169\.254)\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

const REDACTED_KEYS = new Set([
  'authorization',
  'x-quicktone-token',
  'x-session-token',
  'cookie',
  'set-cookie',
  'accesstoken',
  'refreshtoken',
  'token',
  'tokenhash',
  'geminiapikey',
  'gemini_api_key',
  'apikey',
  'api_key',
  'secret',
  'password',
  'pairingcode',
  'pairing_code',
]);

export function sanitizeLogText(raw: string): string {
  return raw
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b(AIza[0-9A-Za-z_-]{16,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]')
    .replace(
      /("(?:accessToken|refreshToken|token|tokenHash|geminiApiKey|apiKey|secret|password|pairingCode|Authorization|X-QuickTone-Token|X-Session-Token|Cookie|Set-Cookie)"\s*:\s*")([^"]*)(")/gi,
      '$1[REDACTED]$3',
    )
    .replace(
      /\b(GEMINI_API_KEY|QUICKTONE_AUTH_TOKEN|X-QuickTone-Token|X-Session-Token|Authorization)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/([A-Za-z]:\\\\Users\\\\)([^\\"\r\n]+)/gi, '$1REDACTED')
    .replace(/([A-Za-z]:[\\/]Users[\\/])([^\\/"\r\n]+)/gi, '$1REDACTED')
    .replace(/::ffff:/gi, '')
    .replace(/(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe80):[0-9a-f:]*(?![0-9a-f:])/gi, '[REDACTED_IPV6]')
    .replace(PRIVATE_IPV4_RE, '192.0.2.10');
}

export function sanitizeDiagnosticPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[TRUNCATED]';
  }
  if (typeof value === 'string') {
    return sanitizeLogText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticPayload(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(key.trim().toLowerCase())) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = sanitizeDiagnosticPayload(entry, depth + 1);
    }
  }
  return out;
}
