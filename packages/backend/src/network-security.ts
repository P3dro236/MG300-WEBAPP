import type { IncomingHttpHeaders } from 'node:http';
import { normalizeRemoteIp } from './pairing-manager.js';

export const MOBILE_SESSION_COOKIE_NAME = 'mg300_session';
export const TRUSTED_DEVICE_COOKIE_NAME = 'mg300_trusted_device';

export function isLoopbackHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export function isPrivateOrLoopbackHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    return false;
  }

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    const octets = [
      Number(ipv4Match[1]),
      Number(ipv4Match[2]),
      Number(ipv4Match[3]),
      Number(ipv4Match[4]),
    ];
    if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
      return false;
    }

    const [a, b] = octets as [number, number, number, number];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (/^(fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(hostname)) {
    return true;
  }

  return false;
}

export function isPrivateOrLoopbackIp(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }
  return isPrivateOrLoopbackHostname(normalizeRemoteIp(ip));
}

export function extractHostnameFromHostHeader(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (!trimmed || /[\s/@\\]/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('[')) {
    const endBracket = trimmed.indexOf(']');
    if (endBracket <= 1) {
      return null;
    }
    const after = trimmed.slice(endBracket + 1);
    if (after && !/^:\d+$/.test(after)) {
      return null;
    }
    return trimmed.slice(1, endBracket).toLowerCase();
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx !== -1) {
    const portPart = trimmed.slice(colonIdx + 1);
    if (!/^\d+$/.test(portPart)) {
      return null;
    }
    return trimmed.slice(0, colonIdx).toLowerCase();
  }
  return trimmed.toLowerCase();
}

export function isAllowedLanHost(
  hostHeader: string | undefined,
  allowedHosts: readonly string[] = [],
): boolean {
  if (!hostHeader || !hostHeader.trim()) {
    return false;
  }
  const trimmed = hostHeader.trim();
  if (allowedHosts.includes('*') || allowedHosts.includes(trimmed)) {
    return true;
  }
  const hostname = extractHostnameFromHostHeader(trimmed);
  if (!hostname) {
    return false;
  }
  if (allowedHosts.includes(hostname)) {
    return true;
  }
  return isPrivateOrLoopbackHostname(hostname);
}

export function isAllowedLanOrigin(
  origin: string,
  allowedOrigins: readonly string[] = [],
): boolean {
  const trimmed = origin.trim();
  if (!trimmed) {
    return false;
  }

  if (allowedOrigins.includes('*') || allowedOrigins.includes(trimmed)) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  return isPrivateOrLoopbackHostname(parsed.hostname);
}

export function parseCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === name) {
      const rawVal = part.slice(eqIdx + 1).trim();
      try {
        return decodeURIComponent(rawVal);
      } catch {
        return rawVal;
      }
    }
  }
  return null;
}

export function extractAuthTokenFromHeaders(headers: IncomingHttpHeaders): string | null {
  const customHeader = headers['x-quicktone-token'];
  if (typeof customHeader === 'string' && customHeader.trim().length > 0) {
    return customHeader.trim();
  }
  if (Array.isArray(customHeader) && customHeader[0]?.trim()) {
    return customHeader[0].trim();
  }

  const authHeader = headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    return trimmed;
  }

  return null;
}

export function extractTrustedDeviceToken(headers: IncomingHttpHeaders): string | null {
  const cookieToken = parseCookieValue(headers.cookie, TRUSTED_DEVICE_COOKIE_NAME);
  return cookieToken && cookieToken.trim().length > 0 ? cookieToken.trim() : null;
}

export function extractMobileSessionToken(headers: IncomingHttpHeaders): string | null {
  const cookieToken = parseCookieValue(headers.cookie, MOBILE_SESSION_COOKIE_NAME);
  if (cookieToken && cookieToken.trim().length > 0) {
    return cookieToken.trim();
  }

  const headerToken = headers['x-session-token'];
  if (typeof headerToken === 'string' && headerToken.trim().length > 0) {
    return headerToken.trim();
  }
  if (Array.isArray(headerToken) && headerToken[0]?.trim()) {
    return headerToken[0].trim();
  }

  const authHeader = headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
  }

  return null;
}

/**
 * Resolves the effective client IP for pairing/rate-limiting.
 * Only trusts X-Forwarded-For when the direct TCP socket peer is loopback (e.g., local Vite dev proxy or inject tests),
 * preventing remote LAN clients from spoofing X-Forwarded-For to bypass rate limits or imitate localhost.
 */
export function resolveEffectiveRemoteIp(
  socketRemoteAddress: string | undefined,
  headers: IncomingHttpHeaders,
): string {
  const directIp = normalizeRemoteIp(socketRemoteAddress);
  if (!isLoopbackHostname(directIp)) {
    return directIp;
  }

  const forwardedFor = headers['x-forwarded-for'];
  const rawForwarded = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0]
      : undefined;

  if (rawForwarded && rawForwarded.trim().length > 0) {
    return normalizeRemoteIp(rawForwarded);
  }
  return directIp;
}

export function resolveDesktopRequest(
  headers: IncomingHttpHeaders,
  socketRemoteAddress: string | undefined,
): boolean {
  const remoteIp = normalizeRemoteIp(socketRemoteAddress);
  if (!isLoopbackHostname(remoteIp)) {
    return false;
  }

  const hostName = headers.host ? extractHostnameFromHostHeader(headers.host) : null;
  if (!hostName || !isLoopbackHostname(hostName)) {
    return false;
  }

  const forwardedFor = Array.isArray(headers['x-forwarded-for'])
    ? headers['x-forwarded-for'][0]
    : headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    const firstIp = normalizeRemoteIp(forwardedFor.split(',')[0]);
    if (!isLoopbackHostname(firstIp)) {
      return false;
    }
  }

  const forwardedHost = Array.isArray(headers['x-forwarded-host'])
    ? headers['x-forwarded-host'][0]
    : headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string' && forwardedHost.trim().length > 0) {
    const fHostName = extractHostnameFromHostHeader(forwardedHost);
    if (!fHostName || !isLoopbackHostname(fHostName)) {
      return false;
    }
  }

  const originHeader = headers.origin;
  if (typeof originHeader === 'string' && originHeader.trim().length > 0) {
    try {
      const originUrl = new URL(originHeader);
      if (!isLoopbackHostname(originUrl.hostname)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}
