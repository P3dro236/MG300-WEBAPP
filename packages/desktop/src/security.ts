import type { WebPreferences } from 'electron';
import { OpenExternalUrlRequestV1Schema } from '@quicktone/shared';

export function createSecureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  };
}

export function buildDesktopCspHeader(
  coreOrigin: string,
  additionalOrigins: readonly string[] = [],
): string {
  const parsed = new URL(coreOrigin);
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsOrigin = `${wsProtocol}//${parsed.host}`;

  const connectOrigins = new Set<string>(["'self'", parsed.origin, wsOrigin]);
  for (const candidate of additionalOrigins) {
    try {
      const extra = new URL(candidate);
      const extraWsProto = extra.protocol === 'https:' ? 'wss:' : 'ws:';
      connectOrigins.add(extra.origin);
      connectOrigins.add(`${extraWsProto}//${extra.host}`);
    } catch {
      // Ignore invalid additional origin
    }
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${[...connectOrigins].join(' ')}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function isAllowedInAppNavigationUrl(
  targetUrl: string,
  allowedOrigins: readonly string[],
): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(targetUrl: string): boolean {
  if (targetUrl.length > 2048) {
    return false;
  }
  const parsedValidation = OpenExternalUrlRequestV1Schema.safeParse({ url: targetUrl });
  if (!parsedValidation.success) {
    return false;
  }
  try {
    const parsed = new URL(parsedValidation.data.url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
