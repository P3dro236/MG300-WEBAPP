import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PairingChallengeInfo,
  PairingSessionInfo,
  PairingSessionStatus,
  PendingPairingRequest,
  TrustedDeviceInfo,
} from '@quicktone/shared';

export type PairingRevokeReason = 'revoked' | 'superseded' | 'expired' | 'logout';

export interface PairingManagerOptions {
  challengeTtlMs?: number;
  pendingRequestTtlMs?: number;
  sessionTtlMs?: number;
  sessionIdleTtlMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxAttempts?: number;
  trustedDevicesPath?: string | null;
  trustedDeviceTtlMs?: number;
}

export class PairingError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly timestamp: string;
  public readonly retryAfterSeconds?: number;

  constructor(
    code: string,
    statusCode: number,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.statusCode = statusCode;
    this.timestamp = new Date().toISOString();
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

interface InternalChallenge {
  challengeId: string;
  pairingCode: string;
  codeHash: string;
  pairingUrl: string;
  expiresAt: string;
  expiresAtMs: number;
  consumed: boolean;
}

interface InternalPendingRequest {
  requestId: string;
  deviceName: string;
  remoteIp: string;
  verificationCode: string;
  claimSecretHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  pendingToken: string | null;
  pendingTrustToken: string | null;
  sessionId: string | null;
}

interface InternalSession {
  sessionId: string;
  trustedDeviceId: string | null;
  tokenHash: string;
  deviceName: string;
  remoteIp: string;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  lastActivityAt: string;
  lastActivityAtMs: number;
}

interface InternalTrustedDevice {
  deviceId: string;
  deviceName: string;
  remoteIp: string;
  tokenHash: string;
  createdAt: string;
  lastConnectedAt: string;
  expiresAtMs: number;
}

export interface PairingDesktopSnapshot {
  activeSession: PairingSessionInfo | null;
  pendingRequests: PendingPairingRequest[];
  activeChallenge: PairingChallengeInfo | null;
  trustedDevices: TrustedDeviceInfo[];
}

export type PairingPollResult =
  | { status: 'pending'; verificationCode: string; expiresAt: string }
  | { status: 'rejected' }
  | { status: 'expired' }
  | { status: 'approved'; sessionToken: string; trustToken: string; session: PairingSessionInfo }
  | { status: 'claimed'; session: PairingSessionInfo | null };

export interface SessionValidationResult {
  valid: boolean;
  status: Exclude<PairingSessionStatus, 'desktop'>;
  session: PairingSessionInfo | null;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) {
    return false;
  }
  const aBuf = Buffer.from(aHex, 'hex');
  const bBuf = Buffer.from(bHex, 'hex');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function normalizeRemoteIp(ip: string | undefined): string {
  if (!ip) {
    return '127.0.0.1';
  }
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  return trimmed;
}

function sanitizeDeviceName(raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!cleaned) {
    return 'Celular LAN';
  }
  return cleaned.slice(0, 60);
}

function toSessionInfo(session: InternalSession): PairingSessionInfo {
  return {
    sessionId: session.sessionId,
    deviceName: session.deviceName,
    remoteIp: session.remoteIp,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastActivityAt: session.lastActivityAt,
  };
}

function toPendingRequestInfo(req: InternalPendingRequest): PendingPairingRequest {
  return {
    requestId: req.requestId,
    deviceName: req.deviceName,
    remoteIp: req.remoteIp,
    verificationCode: req.verificationCode,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
  };
}

function toChallengeInfo(challenge: InternalChallenge): PairingChallengeInfo {
  return {
    challengeId: challenge.challengeId,
    pairingCode: challenge.pairingCode,
    pairingUrl: challenge.pairingUrl,
    expiresAt: challenge.expiresAt,
  };
}

export class PairingManager {
  private readonly challengeTtlMs: number;
  private readonly pendingRequestTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateLimitMaxAttempts: number;
  private readonly trustedDevicesPath: string | null;
  private readonly trustedDeviceTtlMs: number;

  private activeChallenge: InternalChallenge | null = null;
  private activeSession: InternalSession | null = null;
  private readonly pendingRequests = new Map<string, InternalPendingRequest>();
  private readonly trustedDevices = new Map<string, InternalTrustedDevice>();
  private readonly failedAttemptsByIp = new Map<string, number[]>();
  private readonly terminatedTokenReasons = new Map<string, PairingRevokeReason>();

  private readonly updateListeners = new Set<(snapshot: PairingDesktopSnapshot) => void>();
  private readonly revokeListeners = new Set<
    (sessionId: string, reason: PairingRevokeReason) => void
  >();

  constructor(options: PairingManagerOptions = {}) {
    this.challengeTtlMs = options.challengeTtlMs ?? 120_000;
    this.pendingRequestTtlMs = options.pendingRequestTtlMs ?? 90_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 4 * 60 * 60 * 1000;
    this.sessionIdleTtlMs = options.sessionIdleTtlMs ?? 60 * 60 * 1000;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
    this.rateLimitMaxAttempts = options.rateLimitMaxAttempts ?? 5;
    this.trustedDevicesPath = options.trustedDevicesPath ?? null;
    this.trustedDeviceTtlMs = options.trustedDeviceTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.loadTrustedDevices();
  }

  public onUpdate(listener: (snapshot: PairingDesktopSnapshot) => void): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  public onSessionRevoked(
    listener: (sessionId: string, reason: PairingRevokeReason) => void,
  ): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }

  public createChallenge(baseUrl: string): PairingChallengeInfo {
    this.pruneExpired();
    const now = Date.now();
    const challengeId = crypto.randomUUID();
    const pairingCode = crypto.randomBytes(12).toString('base64url');
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const pairingUrl = `${cleanBase}/?pair=${encodeURIComponent(pairingCode)}`;
    const expiresAt = new Date(now + this.challengeTtlMs).toISOString();

    this.activeChallenge = {
      challengeId,
      pairingCode,
      codeHash: sha256Hex(pairingCode),
      pairingUrl,
      expiresAt,
      expiresAtMs: now + this.challengeTtlMs,
      consumed: false,
    };

    const info = toChallengeInfo(this.activeChallenge);
    this.emitUpdate();
    return info;
  }

  public submitPairingRequest(params: {
    pairingCode: string;
    remoteIp?: string;
    deviceName?: string;
  }): {
    requestId: string;
    claimSecret: string;
    verificationCode: string;
    expiresAt: string;
  } {
    this.pruneExpired();
    const ip = normalizeRemoteIp(params.remoteIp);
    const now = Date.now();

    const attempts = (this.failedAttemptsByIp.get(ip) ?? []).filter(
      (ts) => now - ts < this.rateLimitWindowMs,
    );
    if (attempts.length >= this.rateLimitMaxAttempts) {
      const oldest = attempts[0]!;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + this.rateLimitWindowMs - now) / 1000),
      );
      throw new PairingError(
        'RATE_LIMITED',
        429,
        `Muitas tentativas de pareamento. Aguarde ${retryAfterSeconds}s e gere um novo QR Code no computador.`,
        retryAfterSeconds,
      );
    }

    const challenge = this.activeChallenge;
    const candidateHash = sha256Hex(params.pairingCode.trim());
    const challengeValid =
      challenge !== null &&
      !challenge.consumed &&
      now <= challenge.expiresAtMs &&
      timingSafeEqualHex(candidateHash, challenge.codeHash);

    if (!challengeValid) {
      attempts.push(now);
      this.failedAttemptsByIp.set(ip, attempts);
      throw new PairingError(
        'INVALID_PAIRING_CODE',
        401,
        'Código de pareamento inválido ou expirado. Escaneie um novo QR Code no computador.',
      );
    }

    // Single-use challenge: consume immediately so it cannot be replayed
    challenge.consumed = true;
    this.activeChallenge = null;

    const requestId = crypto.randomUUID();
    const claimSecret = crypto.randomBytes(24).toString('base64url');
    const verificationCode = String(crypto.randomInt(100000, 1000000));
    const createdAt = new Date(now).toISOString();
    const expiresAtMs = now + this.pendingRequestTtlMs;
    const expiresAt = new Date(expiresAtMs).toISOString();

    const record: InternalPendingRequest = {
      requestId,
      deviceName: sanitizeDeviceName(params.deviceName),
      remoteIp: ip,
      verificationCode,
      claimSecretHash: sha256Hex(claimSecret),
      status: 'pending',
      createdAt,
      expiresAt,
      expiresAtMs,
      pendingToken: null,
      pendingTrustToken: null,
      sessionId: null,
    };

    this.pendingRequests.set(requestId, record);
    this.emitUpdate();

    return {
      requestId,
      claimSecret,
      verificationCode,
      expiresAt,
    };
  }

  public approveRequest(requestId: string): PairingSessionInfo {
    this.pruneExpired();
    const req = this.pendingRequests.get(requestId);
    const now = Date.now();
    if (!req || req.status !== 'pending' || now > req.expiresAtMs) {
      if (req && req.status === 'pending' && now > req.expiresAtMs) {
        req.status = 'expired';
        this.emitUpdate();
      }
      throw new PairingError(
        'PAIRING_REQUEST_NOT_FOUND',
        404,
        'Solicitação de pareamento não encontrada ou expirada.',
      );
    }

    // Enforce strict single-mobile-controller rule: revoke any prior active session
    if (this.activeSession) {
      this.revokeSessionInternal('superseded');
    }

    const createdAt = new Date(now).toISOString();
    const trustToken = crypto.randomBytes(32).toString('base64url');
    const trustTokenHash = sha256Hex(trustToken);
    let deviceId: string = crypto.randomUUID();

    // Reuse slot in trusted list if same device name + remote IP re-pairs via QR
    for (const [existingId, existingDevice] of this.trustedDevices.entries()) {
      if (
        existingDevice.deviceName === req.deviceName &&
        existingDevice.remoteIp === req.remoteIp
      ) {
        deviceId = existingId;
        break;
      }
    }

    const trustedRecord: InternalTrustedDevice = {
      deviceId,
      deviceName: req.deviceName,
      remoteIp: req.remoteIp,
      tokenHash: trustTokenHash,
      createdAt: this.trustedDevices.get(deviceId)?.createdAt ?? createdAt,
      lastConnectedAt: createdAt,
      expiresAtMs: now + this.trustedDeviceTtlMs,
    };
    this.trustedDevices.set(deviceId, trustedRecord);
    this.persistTrustedDevices();

    const sessionId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const expiresAtMs = now + this.sessionTtlMs;

    const session: InternalSession = {
      sessionId,
      trustedDeviceId: deviceId,
      tokenHash: sha256Hex(sessionToken),
      deviceName: req.deviceName,
      remoteIp: req.remoteIp,
      createdAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      lastActivityAt: createdAt,
      lastActivityAtMs: now,
    };

    this.activeSession = session;
    req.status = 'approved';
    req.sessionId = sessionId;
    req.pendingToken = sessionToken;
    req.pendingTrustToken = trustToken;

    this.emitUpdate();
    return toSessionInfo(session);
  }

  public rejectRequest(requestId: string): void {
    this.pruneExpired();
    const req = this.pendingRequests.get(requestId);
    if (!req) {
      throw new PairingError(
        'PAIRING_REQUEST_NOT_FOUND',
        404,
        'Solicitação de pareamento não encontrada.',
      );
    }
    req.status = 'rejected';
    req.pendingToken = null;
    req.pendingTrustToken = null;
    this.emitUpdate();
  }

  public pollRequest(requestId: string, claimSecret: string): PairingPollResult {
    this.pruneExpired();
    const req = this.pendingRequests.get(requestId);
    if (!req) {
      throw new PairingError(
        'PAIRING_REQUEST_NOT_FOUND',
        404,
        'Solicitação de pareamento não encontrada ou expirada.',
      );
    }

    if (!timingSafeEqualHex(sha256Hex(claimSecret.trim()), req.claimSecretHash)) {
      throw new PairingError(
        'UNAUTHORIZED',
        401,
        'Credencial de solicitação de pareamento inválida.',
      );
    }

    const now = Date.now();
    if (req.status === 'pending' && now > req.expiresAtMs) {
      req.status = 'expired';
      this.emitUpdate();
    }

    if (req.status === 'expired') {
      return { status: 'expired' };
    }
    if (req.status === 'rejected') {
      return { status: 'rejected' };
    }
    if (req.status === 'pending') {
      return {
        status: 'pending',
        verificationCode: req.verificationCode,
        expiresAt: req.expiresAt,
      };
    }

    // Approved
    if (
      req.pendingToken &&
      req.pendingTrustToken &&
      this.activeSession &&
      this.activeSession.sessionId === req.sessionId
    ) {
      const token = req.pendingToken;
      const trustToken = req.pendingTrustToken;
      req.pendingToken = null;
      req.pendingTrustToken = null;
      return {
        status: 'approved',
        sessionToken: token,
        trustToken,
        session: toSessionInfo(this.activeSession),
      };
    }

    return {
      status: 'claimed',
      session:
        this.activeSession && this.activeSession.sessionId === req.sessionId
          ? toSessionInfo(this.activeSession)
          : null,
    };
  }

  public validateSessionToken(token: string | null | undefined): SessionValidationResult {
    this.pruneExpired();
    if (!token || !token.trim()) {
      return { valid: false, status: 'none', session: null };
    }

    const candidateHash = sha256Hex(token.trim());
    if (
      this.activeSession &&
      timingSafeEqualHex(candidateHash, this.activeSession.tokenHash)
    ) {
      const now = Date.now();
      this.activeSession.lastActivityAtMs = now;
      this.activeSession.lastActivityAt = new Date(now).toISOString();
      return {
        valid: true,
        status: 'active',
        session: toSessionInfo(this.activeSession),
      };
    }

    const terminatedReason = this.terminatedTokenReasons.get(candidateHash);
    if (terminatedReason === 'expired') {
      return { valid: false, status: 'expired', session: null };
    }
    if (terminatedReason) {
      return { valid: false, status: 'revoked', session: null };
    }

    return { valid: false, status: 'none', session: null };
  }

  public revokeActiveSession(reason: 'revoked' | 'logout' = 'revoked'): boolean {
    if (!this.activeSession) {
      return false;
    }
    this.revokeSessionInternal(reason);
    this.emitUpdate();
    return true;
  }

  public validateTrustedDeviceToken(
    token: string | null | undefined,
  ): TrustedDeviceInfo | null {
    this.pruneExpired();
    if (!token || !token.trim()) {
      return null;
    }
    const device = this.findTrustedDeviceByToken(token.trim());
    return device ? this.toTrustedDeviceInfo(device) : null;
  }

  public loginTrustedDevice(
    trustToken: string | null | undefined,
    remoteIp?: string,
  ): { sessionToken: string; session: PairingSessionInfo } {
    this.pruneExpired();
    if (!trustToken || !trustToken.trim()) {
      throw new PairingError(
        'TRUSTED_DEVICE_INVALID',
        401,
        'Dispositivo não reconhecido como confiável. Escaneie o QR Code no computador.',
      );
    }

    const device = this.findTrustedDeviceByToken(trustToken.trim());
    if (!device) {
      throw new PairingError(
        'TRUSTED_DEVICE_INVALID',
        401,
        'Dispositivo removido ou confiança expirada. Escaneie um novo QR Code no computador.',
      );
    }

    if (this.activeSession) {
      this.revokeSessionInternal('superseded');
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    device.lastConnectedAt = nowIso;
    if (remoteIp) {
      device.remoteIp = normalizeRemoteIp(remoteIp);
    }
    device.expiresAtMs = now + this.trustedDeviceTtlMs;
    this.persistTrustedDevices();

    const sessionId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const expiresAtMs = now + this.sessionTtlMs;

    const session: InternalSession = {
      sessionId,
      trustedDeviceId: device.deviceId,
      tokenHash: sha256Hex(sessionToken),
      deviceName: device.deviceName,
      remoteIp: device.remoteIp,
      createdAt: nowIso,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      lastActivityAt: nowIso,
      lastActivityAtMs: now,
    };

    this.activeSession = session;
    this.emitUpdate();

    return {
      sessionToken,
      session: toSessionInfo(session),
    };
  }

  public removeTrustedDevice(deviceId: string): boolean {
    this.pruneExpired();
    const existing = this.trustedDevices.get(deviceId);
    if (!existing) {
      throw new PairingError(
        'TRUSTED_DEVICE_NOT_FOUND',
        404,
        'Dispositivo confiável não encontrado.',
      );
    }

    this.trustedDevices.delete(deviceId);
    this.persistTrustedDevices();

    if (this.activeSession?.trustedDeviceId === deviceId) {
      this.revokeSessionInternal('revoked');
    }

    this.emitUpdate();
    return true;
  }

  public getDesktopSnapshot(): PairingDesktopSnapshot {
    this.pruneExpired();
    const pending: PendingPairingRequest[] = [];
    for (const req of this.pendingRequests.values()) {
      if (req.status === 'pending') {
        pending.push(toPendingRequestInfo(req));
      }
    }
    return {
      activeSession: this.activeSession ? toSessionInfo(this.activeSession) : null,
      pendingRequests: pending,
      activeChallenge:
        this.activeChallenge && !this.activeChallenge.consumed
          ? toChallengeInfo(this.activeChallenge)
          : null,
      trustedDevices: this.listTrustedDevices(),
    };
  }

  public dispose(): void {
    this.updateListeners.clear();
    this.revokeListeners.clear();
    this.pendingRequests.clear();
    this.trustedDevices.clear();
    this.failedAttemptsByIp.clear();
    this.terminatedTokenReasons.clear();
    this.activeChallenge = null;
    this.activeSession = null;
  }

  private revokeSessionInternal(reason: PairingRevokeReason): void {
    const current = this.activeSession;
    if (!current) {
      return;
    }
    this.activeSession = null;
    this.recordTerminatedToken(current.tokenHash, reason);
    for (const listener of this.revokeListeners) {
      listener(current.sessionId, reason);
    }
  }

  private recordTerminatedToken(tokenHash: string, reason: PairingRevokeReason): void {
    this.terminatedTokenReasons.set(tokenHash, reason);
    if (this.terminatedTokenReasons.size > 50) {
      const oldestKey = this.terminatedTokenReasons.keys().next().value;
      if (oldestKey) {
        this.terminatedTokenReasons.delete(oldestKey);
      }
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    let changed = false;

    if (this.activeChallenge && now > this.activeChallenge.expiresAtMs) {
      this.activeChallenge = null;
      changed = true;
    }

    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.status === 'pending' && now > req.expiresAtMs) {
        req.status = 'expired';
        changed = true;
      } else if (now - req.expiresAtMs > 5 * 60 * 1000) {
        this.pendingRequests.delete(id);
      }
    }

    if (this.activeSession) {
      const expiredByAge = now > this.activeSession.expiresAtMs;
      const expiredByIdle =
        now - this.activeSession.lastActivityAtMs > this.sessionIdleTtlMs;
      if (expiredByAge || expiredByIdle) {
        this.revokeSessionInternal('expired');
        changed = true;
      }
    }

    for (const [ip, timestamps] of this.failedAttemptsByIp.entries()) {
      const recent = timestamps.filter((ts) => now - ts < this.rateLimitWindowMs);
      if (recent.length === 0) {
        this.failedAttemptsByIp.delete(ip);
      } else if (recent.length !== timestamps.length) {
        this.failedAttemptsByIp.set(ip, recent);
      }
    }

    let trustedChanged = false;
    for (const [deviceId, device] of this.trustedDevices.entries()) {
      if (now > device.expiresAtMs) {
        this.trustedDevices.delete(deviceId);
        trustedChanged = true;
        changed = true;
      }
    }
    if (trustedChanged) {
      this.persistTrustedDevices();
    }

    if (changed) {
      this.emitUpdate();
    }
  }

  private findTrustedDeviceByToken(token: string): InternalTrustedDevice | null {
    const candidateHash = sha256Hex(token);
    for (const device of this.trustedDevices.values()) {
      if (timingSafeEqualHex(candidateHash, device.tokenHash)) {
        return device;
      }
    }
    return null;
  }

  private toTrustedDeviceInfo(device: InternalTrustedDevice): TrustedDeviceInfo {
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      remoteIp: device.remoteIp,
      createdAt: device.createdAt,
      lastConnectedAt: device.lastConnectedAt,
      isCurrentlyActive: this.activeSession?.trustedDeviceId === device.deviceId,
    };
  }

  private listTrustedDevices(): TrustedDeviceInfo[] {
    return Array.from(this.trustedDevices.values())
      .map((d) => this.toTrustedDeviceInfo(d))
      .sort((a, b) => b.lastConnectedAt.localeCompare(a.lastConnectedAt));
  }

  private loadTrustedDevices(): void {
    if (!this.trustedDevicesPath) {
      return;
    }
    try {
      if (!fs.existsSync(this.trustedDevicesPath)) {
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.trustedDevicesPath, 'utf8')) as unknown;
      const list = Array.isArray((raw as { devices?: unknown })?.devices)
        ? ((raw as { devices: unknown[] }).devices)
        : [];
      const now = Date.now();
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        if (
          typeof r.deviceId === 'string' &&
          typeof r.deviceName === 'string' &&
          typeof r.remoteIp === 'string' &&
          typeof r.tokenHash === 'string' &&
          typeof r.createdAt === 'string' &&
          typeof r.lastConnectedAt === 'string' &&
          typeof r.expiresAtMs === 'number' &&
          r.expiresAtMs > now
        ) {
          this.trustedDevices.set(r.deviceId, {
            deviceId: r.deviceId,
            deviceName: r.deviceName,
            remoteIp: r.remoteIp,
            tokenHash: r.tokenHash,
            createdAt: r.createdAt,
            lastConnectedAt: r.lastConnectedAt,
            expiresAtMs: r.expiresAtMs,
          });
        }
      }
    } catch {
      // Recover cleanly from missing or corrupted trusted-devices store
    }
  }

  private persistTrustedDevices(): void {
    if (!this.trustedDevicesPath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.trustedDevicesPath), { recursive: true });
      const tmpPath = `${this.trustedDevicesPath}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ devices: Array.from(this.trustedDevices.values()) }, null, 2),
        'utf8',
      );
      fs.renameSync(tmpPath, this.trustedDevicesPath);
    } catch {
      // Best-effort persistence on disk
    }
  }

  private emitUpdate(): void {
    const snapshot: PairingDesktopSnapshot = {
      activeSession: this.activeSession ? toSessionInfo(this.activeSession) : null,
      pendingRequests: Array.from(this.pendingRequests.values())
        .filter((req) => req.status === 'pending')
        .map(toPendingRequestInfo),
      activeChallenge:
        this.activeChallenge && !this.activeChallenge.consumed
          ? toChallengeInfo(this.activeChallenge)
          : null,
      trustedDevices: this.listTrustedDevices(),
    };
    for (const listener of this.updateListeners) {
      listener(snapshot);
    }
  }
}
