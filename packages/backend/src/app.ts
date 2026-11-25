import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { ZodError } from 'zod';
import {
  ConfigurePresetsDirRequestSchema,
  ConnectMidiRequestSchema,
  type MidiErrorCode,
  PairingDecisionPayloadSchema,
  PairingPollPayloadSchema,
  PairingRequestPayloadSchema,
  RemoveTrustedDevicePayloadSchema,
  SelectPresetRequestSchema,
  UpdateVolumeRequestSchema,
  UpdateVolumeTargetRequestSchema,
  WsClientMessageSchema,
  type WsServerMessage,
} from '@quicktone/shared';
import { MidiServiceError } from '@quicktone/midi';
import {
  ExperimentalBlockModelRequestSchema,
  ExperimentalBlockParamRequestSchema,
  ExperimentalBlockRequestSchema,
  ExperimentalCreateDraftRequestSchema,
  ExperimentalEditError,
  ExperimentalEditService,
  ExperimentalImportRequestSchema,
  ExperimentalLevelRequestSchema,
  ExperimentalLoadRequestSchema,
  ExperimentalMetaRequestSchema,
  ExperimentalParamRequestSchema,
  ExperimentalSaveRequestSchema,
} from './experimental-edit.js';
import {
  PairingError,
  PairingManager,
  type PairingManagerOptions,
} from './pairing-manager.js';
import {
  MOBILE_SESSION_COOKIE_NAME,
  TRUSTED_DEVICE_COOKIE_NAME,
  extractAuthTokenFromHeaders,
  extractMobileSessionToken,
  extractTrustedDeviceToken,
  isAllowedLanHost,
  isAllowedLanOrigin,
  isPrivateOrLoopbackIp,
  resolveDesktopRequest,
  resolveEffectiveRemoteIp,
} from './network-security.js';
import {
  ControllerStateManager,
  type ControllerStateManagerOptions,
  PresetNotFoundError,
} from './state-manager.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRONTEND_DIST_DIR = path.resolve(CURRENT_DIR, '../../frontend/dist');

const STATIC_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const MIDI_ERROR_STATUS_MAP: Record<MidiErrorCode, number> = {
  DEVICE_NOT_FOUND: 404,
  PORT_BUSY: 409,
  INVALID_MIDI_VALUE: 400,
  UNVALIDATED_MESSAGE_BLOCKED: 400,
  DISCONNECTED: 503,
  TRANSMISSION_FAILED: 503,
};

const CONTROL_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_SESSION_MAX_AGE_SECONDS = 4 * 60 * 60;
const DEFAULT_TRUSTED_DEVICE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export { isAllowedLanHost, isAllowedLanOrigin, isPrivateOrLoopbackIp };

const PUBLIC_PAIRING_ROUTES = new Set([
  '/api/health',
  '/api/pairing/status',
  '/api/pairing/request',
  '/api/pairing/poll',
  '/api/pairing/trusted-login',
  '/api/pairing/logout',
]);

const DESKTOP_ONLY_PAIRING_ROUTES = new Set([
  '/api/pairing/challenge',
  '/api/pairing/approve',
  '/api/pairing/reject',
  '/api/pairing/revoke',
  '/api/pairing/trusted/remove',
]);

export interface BackendAppOptions extends ControllerStateManagerOptions {
  stateManager?: ControllerStateManager;
  pairingManager?: PairingManager;
  pairingOptions?: PairingManagerOptions;
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
  staticDir?: string | null;
  logger?: boolean;
  disposeStateManagerOnClose?: boolean;
  /** Experimental branch: expose /api/experimental/* (default: env QUICKTONE_EXPERIMENTAL_EDIT=1). */
  experimentalEdit?: boolean;
  experimentalBackupDir?: string;
}

export type QuickToneBackendApp = FastifyInstance & {
  app: FastifyInstance;
  stateManager: ControllerStateManager;
  pairingManager: PairingManager;
  wss: WebSocketServer;
  broadcastWsMessage: (message: WsServerMessage) => void;
};

export function createBackendApp(options: BackendAppOptions = {}): QuickToneBackendApp {
  const experimentalEditEnabled =
    options.experimentalEdit ?? process.env.QUICKTONE_EXPERIMENTAL_EDIT === '1';

  const stateManager =
    options.stateManager ??
    new ControllerStateManager({
      discoveryService: options.discoveryService,
      midiService: options.midiService,
      midiAdapter: options.midiAdapter,
      midiOptions: experimentalEditEnabled
        ? { ...options.midiOptions, experimentalEdit: true }
        : options.midiOptions,
      presetsDirectory: options.presetsDirectory,
      includeFactoryPresets: options.includeFactoryPresets,
      fillMissingUserSlots: options.fillMissingUserSlots,
      enableSysExSync: options.enableSysExSync,
      lanUrls: options.lanUrls,
      serverPort: options.serverPort,
      authToken: options.authToken,
      autoConnectMidiOnInit: options.autoConnectMidiOnInit,
    });

  const pairingManager =
    options.pairingManager ?? new PairingManager(options.pairingOptions);
  const ownsPairingManager = options.pairingManager === undefined;

  if (options.stateManager && options.authToken !== undefined) {
    stateManager.setAuthToken(options.authToken);
  }

  const allowedOrigins = options.allowedOrigins ?? [];
  const allowedHosts = options.allowedHosts ?? [];
  const staticDir =
    options.staticDir !== undefined ? options.staticDir : DEFAULT_FRONTEND_DIST_DIR;
  const disposeStateManagerOnClose =
    options.disposeStateManagerOnClose ?? options.stateManager === undefined;

  const fastify = Fastify({
    logger: options.logger ?? false,
  });

  // Allow empty JSON bodies on POST requests (e.g., POST /api/midi/disconnect or connect)
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const parseErr = err as Error & { statusCode?: number };
        parseErr.statusCode = 400;
        done(parseErr, undefined);
      }
    },
  );

  const wss = new WebSocketServer({ noServer: true });
  const wsClientMeta = new Map<
    WebSocket,
    { role: 'desktop' | 'mobile'; sessionId: string | null }
  >();

  const sendWsMessage = (client: WebSocket, message: WsServerMessage): void => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  };

  const broadcastWsMessage = (message: WsServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  const broadcastDesktopWsMessage = (message: WsServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      const meta = wsClientMeta.get(client);
      if (client.readyState === WebSocket.OPEN && meta?.role === 'desktop') {
        client.send(payload);
      }
    }
  };

  const buildStateSyncMessage = (): WsServerMessage => ({
    type: 'state_sync',
    state: stateManager.getState(),
    presets: stateManager.getPresetsResponse().presets,
    timestamp: new Date().toISOString(),
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('close', () => {
      wsClientMeta.delete(ws);
    });
    sendWsMessage(ws, buildStateSyncMessage());

    ws.on('message', (rawData) => {
      let parsedJson: unknown;
      try {
        const rawText =
          typeof rawData === 'string'
            ? rawData
            : Buffer.isBuffer(rawData)
              ? rawData.toString('utf8')
              : Array.isArray(rawData)
                ? Buffer.concat(rawData).toString('utf8')
                : Buffer.from(rawData).toString('utf8');
        parsedJson = JSON.parse(rawText);
      } catch {
        return;
      }

      const validated = WsClientMessageSchema.safeParse(parsedJson);
      if (!validated.success) {
        return;
      }

      if (validated.data.type === 'ping') {
        sendWsMessage(ws, {
          type: 'pong',
          timestamp: new Date().toISOString(),
        });
      } else if (validated.data.type === 'request_sync') {
        sendWsMessage(ws, buildStateSyncMessage());
      }
    });
  });

  fastify.server.on('upgrade', (request, socket, head) => {
    const rawUrl = request.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';
    if (pathname !== '/ws' && pathname !== '/') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isAllowedLanHost(request.headers.host, allowedHosts)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isPrivateOrLoopbackIp(request.socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const originHeader = request.headers.origin;
    if (
      typeof originHeader === 'string' &&
      !isAllowedLanOrigin(originHeader, allowedOrigins)
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const isDesktop = resolveDesktopRequest(request.headers, request.socket.remoteAddress);

    let wsMeta: { role: 'desktop' | 'mobile'; sessionId: string | null } = {
      role: 'desktop',
      sessionId: null,
    };

    if (isDesktop) {
      if (stateManager.isAuthRequired()) {
        let queryToken: string | null = null;
        try {
          queryToken = new URL(rawUrl, 'http://localhost').searchParams.get('token');
        } catch {
          queryToken = null;
        }
        const headerToken = extractAuthTokenFromHeaders(request.headers);
        if (!stateManager.validateAuthToken(queryToken || headerToken)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    } else {
      const mobileToken = extractMobileSessionToken(request.headers);
      const validation = pairingManager.validateSessionToken(mobileToken);
      if (!validation.valid || !validation.session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wsMeta = {
        role: 'mobile',
        sessionId: validation.session.sessionId,
      };
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wsClientMeta.set(ws, wsMeta);
      wss.emit('connection', ws, request);
    });
  });

  const unsubscribeState = stateManager.onStateChange((state, presetsResponse) => {
    broadcastWsMessage({
      type: 'state_sync',
      state,
      presets: presetsResponse.presets,
      timestamp: new Date().toISOString(),
    });
  });

  const unsubscribePresets = stateManager.onPresetsUpdated((presetsResponse) => {
    broadcastWsMessage({
      type: 'presets_updated',
      presets: presetsResponse.presets,
      directory: presetsResponse.directory,
      directoryStatus: presetsResponse.directoryStatus,
      warnings: presetsResponse.warnings,
      timestamp: new Date().toISOString(),
    });
  });

  let unsubscribeExperimentalState: (() => void) | null = null;
  let disposeExperimentalService: (() => void) | null = null;

  const unsubscribePairing = pairingManager.onUpdate((snapshot) => {
    broadcastDesktopWsMessage({
      type: 'pairing_updated',
      activeSession: snapshot.activeSession,
      pendingRequests: snapshot.pendingRequests,
      activeChallenge: snapshot.activeChallenge,
      trustedDevices: snapshot.trustedDevices,
      timestamp: new Date().toISOString(),
    });
  });

  const unsubscribeSessionRevoked = pairingManager.onSessionRevoked((sessionId, reason) => {
    const closeCode = reason === 'expired' ? 4002 : 4001;
    const closeReason =
      reason === 'expired'
        ? 'Sessão expirada'
        : reason === 'superseded'
          ? 'Substituída por outro celular'
          : 'Acesso revogado pelo desktop';

    for (const client of wss.clients) {
      const meta = wsClientMeta.get(client);
      if (meta?.role === 'mobile' && meta.sessionId === sessionId) {
        try {
          client.close(closeCode, closeReason);
        } catch {
          try {
            client.terminate();
          } catch {
            // Ignore terminate errors
          }
        }
      }
    }
  });

  const authenticatedMobileRequests = new WeakSet<FastifyRequest>();

  // LAN Host (DNS Rebinding), Private Network, CORS Origin & Mandatory Pairing Session Hook
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAllowedLanHost(request.headers.host, allowedHosts)) {
      return reply.status(403).send({
        code: 'FORBIDDEN_HOST',
        message: 'Cabeçalho Host inválido ou não permitido na rede local.',
        timestamp: new Date().toISOString(),
      });
    }

    const remoteAddr = request.socket.remoteAddress;
    if (remoteAddr && !isPrivateOrLoopbackIp(remoteAddr)) {
      return reply.status(403).send({
        code: 'FORBIDDEN_NETWORK',
        message: 'Acesso permitido apenas na rede local privada.',
        timestamp: new Date().toISOString(),
      });
    }

    const originHeader = request.headers.origin;
    const hasOrigin = typeof originHeader === 'string' && originHeader.trim().length > 0;
    const isOriginAllowed =
      hasOrigin && isAllowedLanOrigin(originHeader, allowedOrigins);

    if (hasOrigin && !isOriginAllowed) {
      return reply.status(403).send({
        code: 'FORBIDDEN_ORIGIN',
        message: `Origem externa bloqueada pela política de segurança LAN: "${originHeader}".`,
        timestamp: new Date().toISOString(),
      });
    }

    if (hasOrigin && isOriginAllowed) {
      reply.header('Access-Control-Allow-Origin', originHeader);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      reply.header(
        'Access-Control-Allow-Headers',
        'Content-Type, X-QuickTone-Token, X-Session-Token, Authorization',
      );
    }

    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }

    const rawUrl = request.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';
    const isApiRoute = pathname === '/api' || pathname.startsWith('/api/');
    if (!isApiRoute) {
      return;
    }

    const isDesktop = resolveDesktopRequest(request.headers, remoteAddr);

    if (DESKTOP_ONLY_PAIRING_ROUTES.has(pathname)) {
      if (!isDesktop) {
        return reply.status(403).send({
          code: 'DESKTOP_ONLY',
          message: 'Esta ação de pareamento só pode ser executada no computador principal.',
          timestamp: new Date().toISOString(),
        });
      }
      if (stateManager.isAuthRequired()) {
        const token = extractAuthTokenFromHeaders(request.headers);
        if (!stateManager.validateAuthToken(token)) {
          return reply.status(401).send({
            code: 'UNAUTHORIZED',
            message:
              'Autenticação necessária: forneça um token/PIN válido via header X-QuickTone-Token ou Authorization.',
            timestamp: new Date().toISOString(),
          });
        }
      }
      return;
    }

    if (!PUBLIC_PAIRING_ROUTES.has(pathname)) {
      if (!isDesktop) {
        const mobileToken = extractMobileSessionToken(request.headers);
        const validation = pairingManager.validateSessionToken(mobileToken);
        if (!validation.valid) {
          const code =
            validation.status === 'expired'
              ? 'SESSION_EXPIRED'
              : validation.status === 'revoked'
                ? 'SESSION_REVOKED'
                : 'PAIRING_REQUIRED';
          const message =
            code === 'SESSION_EXPIRED'
              ? 'Sua sessão expirou. Escaneie um novo QR Code no computador para reconectar.'
              : code === 'SESSION_REVOKED'
                ? 'O acesso deste celular foi revogado ou substituído por outro dispositivo.'
                : 'Pareamento obrigatório via QR Code no computador antes de acessar ou controlar a pedaleira.';
          return reply.status(401).send({
            code,
            message,
            timestamp: new Date().toISOString(),
          });
        }
        authenticatedMobileRequests.add(request);
      } else if (
        CONTROL_HTTP_METHODS.has(request.method) &&
        stateManager.isAuthRequired()
      ) {
        const token = extractAuthTokenFromHeaders(request.headers);
        if (!stateManager.validateAuthToken(token)) {
          return reply.status(401).send({
            code: 'UNAUTHORIZED',
            message:
              'Autenticação necessária: forneça um token/PIN válido via header X-QuickTone-Token ou Authorization.',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  });

  fastify.addHook('onReady', async () => {
    await stateManager.initialize();
  });

  fastify.addHook('preClose', async () => {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // Ignore terminate errors
      }
    }
    fastify.server.closeAllConnections?.();
  });

  fastify.addHook('onClose', async () => {
    unsubscribeState();
    unsubscribePresets();
    unsubscribePairing();
    unsubscribeSessionRevoked();
    unsubscribeExperimentalState?.();
    disposeExperimentalService?.();
    if (ownsPairingManager) {
      pairingManager.dispose();
    }
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // Ignore terminate errors
      }
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    if (disposeStateManagerOnClose) {
      await stateManager.disconnectMidi().catch(() => {});
      stateManager.dispose();
    }
  });

  // Error Handler
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const detail = error.errors
        .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
        .join('; ');
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: `Payload inválido: ${detail}`,
        issues: error.errors,
        timestamp: new Date().toISOString(),
      });
    }

    if (error instanceof ExperimentalEditError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      });
    }

    if (error instanceof PresetNotFoundError) {
      return reply.status(404).send({
        code: error.code,
        message: error.message,
        timestamp: error.timestamp,
      });
    }

    if (error instanceof PairingError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        timestamp: error.timestamp,
      });
    }

    if (error instanceof MidiServiceError) {
      const status = MIDI_ERROR_STATUS_MAP[error.code] ?? 500;
      return reply.status(status).send({
        code: error.code,
        message: error.message,
        timestamp: error.timestamp,
      });
    }

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? ((error as { statusCode: number }).statusCode)
        : 500;

    const resolvedStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;

    return reply.status(resolvedStatus).send({
      code: resolvedStatus === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
      message:
        resolvedStatus >= 500
          ? 'Erro interno no servidor.'
          : error instanceof Error
            ? error.message
            : 'Requisição inválida.',
      timestamp: new Date().toISOString(),
    });
  });

  // REST Endpoints

  fastify.get('/api/health', async () => {
    return stateManager.getHealth();
  });

  // Mobile Pairing & Session Endpoints
  fastify.get('/api/pairing/status', async (request) => {
    const isDesktop = resolveDesktopRequest(request.headers, request.socket.remoteAddress);

    if (isDesktop) {
      if (
        stateManager.isAuthRequired() &&
        !stateManager.validateAuthToken(extractAuthTokenFromHeaders(request.headers))
      ) {
        return {
          isLocalDesktop: true,
          authenticated: false,
          sessionStatus: 'none' as const,
          activeSession: null,
          pendingRequests: [],
          activeChallenge: null,
          lanUrls: [],
          trustedDevices: [],
        };
      }
      const snapshot = pairingManager.getDesktopSnapshot();
      return {
        isLocalDesktop: true,
        authenticated: true,
        sessionStatus: 'desktop' as const,
        activeSession: snapshot.activeSession,
        pendingRequests: snapshot.pendingRequests,
        activeChallenge: snapshot.activeChallenge,
        lanUrls: stateManager.getState().lanUrls ?? [],
        trustedDevices: snapshot.trustedDevices,
      };
    }

    const mobileToken = extractMobileSessionToken(request.headers);
    const validation = pairingManager.validateSessionToken(mobileToken);
    const trustedDevice = pairingManager.validateTrustedDeviceToken(
      extractTrustedDeviceToken(request.headers),
    );
    return {
      isLocalDesktop: false,
      authenticated: validation.valid,
      sessionStatus: validation.status,
      activeSession: validation.valid ? validation.session : null,
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: [],
      isTrustedDevice: Boolean(trustedDevice),
      trustedDeviceName: trustedDevice?.deviceName ?? null,
    };
  });

  fastify.post('/api/pairing/challenge', async (request) => {
    const lanUrls = stateManager.getState().lanUrls ?? [];
    const boundAddress = fastify.server.address();
    const serverPort =
      typeof boundAddress === 'object' && boundAddress !== null ? boundAddress.port : 3001;

    let baseUrl = lanUrls[0] ?? `http://127.0.0.1:${serverPort}`;
    // In Vite dev mode (staticDir absent), prefer the frontend dev server port (e.g. 5173)
    const originHeader = request.headers.origin;
    if (
      typeof originHeader === 'string' &&
      (!staticDir || !fs.existsSync(staticDir))
    ) {
      try {
        const originUrl = new URL(originHeader);
        if (originUrl.port) {
          const parsedBase = new URL(baseUrl);
          parsedBase.port = originUrl.port;
          baseUrl = parsedBase.toString().replace(/\/+$/, '');
        }
      } catch {
        // Keep baseUrl as-is
      }
    }

    const challenge = pairingManager.createChallenge(baseUrl);
    return {
      challenge,
      ...pairingManager.getDesktopSnapshot(),
    };
  });

  fastify.post('/api/pairing/request', async (request) => {
    const payload = PairingRequestPayloadSchema.parse(request.body ?? {});
    const remoteIp = resolveEffectiveRemoteIp(
      request.socket.remoteAddress,
      request.headers,
    );

    return pairingManager.submitPairingRequest({
      pairingCode: payload.pairingCode,
      remoteIp,
      deviceName: payload.deviceName,
    });
  });

  fastify.post('/api/pairing/poll', async (request, reply) => {
    const payload = PairingPollPayloadSchema.parse(request.body ?? {});
    const result = pairingManager.pollRequest(payload.requestId, payload.claimSecret);

    if (result.status === 'approved') {
      const maxAge = Math.floor(
        (options.pairingOptions?.sessionTtlMs ?? DEFAULT_SESSION_MAX_AGE_SECONDS * 1000) /
          1000,
      );
      const trustMaxAge = Math.floor(
        (options.pairingOptions?.trustedDeviceTtlMs ??
          DEFAULT_TRUSTED_DEVICE_MAX_AGE_SECONDS * 1000) / 1000,
      );
      reply.header('Set-Cookie', [
        `${MOBILE_SESSION_COOKIE_NAME}=${encodeURIComponent(result.sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
        `${TRUSTED_DEVICE_COOKIE_NAME}=${encodeURIComponent(result.trustToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${trustMaxAge}`,
      ]);
      return {
        status: 'approved' as const,
        session: result.session,
      };
    }

    return result;
  });

  fastify.post('/api/pairing/trusted-login', async (request, reply) => {
    const trustToken = extractTrustedDeviceToken(request.headers);
    const remoteIp = resolveEffectiveRemoteIp(
      request.socket.remoteAddress,
      request.headers,
    );
    const result = pairingManager.loginTrustedDevice(trustToken, remoteIp);
    const maxAge = Math.floor(
      (options.pairingOptions?.sessionTtlMs ?? DEFAULT_SESSION_MAX_AGE_SECONDS * 1000) /
        1000,
    );
    reply.header(
      'Set-Cookie',
      `${MOBILE_SESSION_COOKIE_NAME}=${encodeURIComponent(result.sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
    );
    return {
      ok: true,
      session: result.session,
    };
  });

  fastify.post('/api/pairing/trusted/remove', async (request) => {
    const payload = RemoveTrustedDevicePayloadSchema.parse(request.body ?? {});
    pairingManager.removeTrustedDevice(payload.deviceId);
    return {
      ok: true,
      ...pairingManager.getDesktopSnapshot(),
    };
  });

  fastify.post('/api/pairing/approve', async (request) => {
    const payload = PairingDecisionPayloadSchema.parse(request.body ?? {});
    const session = pairingManager.approveRequest(payload.requestId);
    return {
      ...pairingManager.getDesktopSnapshot(),
      activeSession: session,
    };
  });

  fastify.post('/api/pairing/reject', async (request) => {
    const payload = PairingDecisionPayloadSchema.parse(request.body ?? {});
    pairingManager.rejectRequest(payload.requestId);
    return {
      ok: true,
      ...pairingManager.getDesktopSnapshot(),
    };
  });

  fastify.post('/api/pairing/revoke', async () => {
    pairingManager.revokeActiveSession('revoked');
    return {
      ok: true,
      ...pairingManager.getDesktopSnapshot(),
    };
  });

  fastify.post('/api/pairing/logout', async (request, reply) => {
    const mobileToken = extractMobileSessionToken(request.headers);
    const validation = pairingManager.validateSessionToken(mobileToken);
    if (validation.valid) {
      pairingManager.revokeActiveSession('logout');
    }
    reply.header(
      'Set-Cookie',
      `${MOBILE_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    return { ok: true };
  });

  fastify.get('/api/presets', async (request) => {
    if (
      !authenticatedMobileRequests.has(request) &&
      stateManager.isAuthRequired() &&
      !stateManager.validateAuthToken(extractAuthTokenFromHeaders(request.headers))
    ) {
      return {
        presets: [],
        directory: null,
        directoryStatus: 'unconfigured' as const,
        warnings: [],
      };
    }
    return stateManager.getPresetsResponse();
  });

  fastify.get('/api/status', async (request) => {
    const state = stateManager.getState();
    if (
      !authenticatedMobileRequests.has(request) &&
      stateManager.isAuthRequired() &&
      !stateManager.validateAuthToken(extractAuthTokenFromHeaders(request.headers))
    ) {
      return {
        ...state,
        connectedPortName: null,
        availablePorts: [],
        presetsDirectory: null,
        warnings: [],
        lanUrls: [],
      };
    }
    return state;
  });

  fastify.post('/api/presets/select', async (request) => {
    const payload = SelectPresetRequestSchema.parse(request.body ?? {});
    const result = await stateManager.selectPreset(payload);
    return {
      state: result.state,
      command: result.command,
    };
  });

  fastify.put('/api/volume', async (request) => {
    const payload = UpdateVolumeRequestSchema.parse(request.body ?? {});
    const result = await stateManager.setVolume(payload);
    return {
      state: result.state,
      command: result.command,
    };
  });

  fastify.post('/api/volume/target', async (request) => {
    const payload = UpdateVolumeTargetRequestSchema.parse(request.body ?? {});
    const result = stateManager.setVolumeTarget(payload.target);
    return {
      state: result.state,
    };
  });

  fastify.post('/api/midi/connect', async (request) => {
    const payload = ConnectMidiRequestSchema.parse(request.body ?? {});
    const result = await stateManager.connectMidi(payload);
    return {
      state: result.state,
    };
  });

  fastify.post('/api/midi/disconnect', async () => {
    const result = await stateManager.disconnectMidi();
    return {
      state: result.state,
    };
  });

  fastify.post('/api/presets/config', async (request) => {
    const payload = ConfigurePresetsDirRequestSchema.parse(request.body ?? {});
    const response = await stateManager.configurePresetsDirectory(
      payload.directoryPath,
      payload.includeFactoryPresets,
    );
    return {
      ...response,
      state: stateManager.getState(),
    };
  });

  fastify.post('/api/presets/reload', async () => {
    const response = await stateManager.refreshPresets();
    return {
      ...response,
      state: stateManager.getState(),
    };
  });

  if (experimentalEditEnabled) {
    const experimental = new ExperimentalEditService(stateManager.getMidiService(), {
      backupDir:
        options.experimentalBackupDir ??
        process.env.QUICKTONE_BACKUP_DIR ??
        path.resolve(process.cwd(), 'backups'),
      onPresetSaved: (slotIndex, struct102) => {
        stateManager.applySavedHardwarePreset(slotIndex, struct102);
      },
    });

    unsubscribeExperimentalState = experimental.onStateChange((state) => {
      broadcastWsMessage({
        type: 'experimental_state_sync',
        state,
        timestamp: new Date().toISOString(),
      });
    });
    disposeExperimentalService = () => experimental.dispose();

    fastify.get('/api/experimental/state', async (request, reply) => {
      if (
        !authenticatedMobileRequests.has(request) &&
        stateManager.isAuthRequired() &&
        !stateManager.validateAuthToken(extractAuthTokenFromHeaders(request.headers))
      ) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message:
            'Autenticação necessária: forneça um token/PIN válido via header X-QuickTone-Token ou Authorization.',
          timestamp: new Date().toISOString(),
        });
      }
      return experimental.getState();
    });
    fastify.post('/api/experimental/load', async (request) => {
      const { slot } = ExperimentalLoadRequestSchema.parse(request.body ?? {});
      return experimental.load(slot);
    });
    fastify.post('/api/experimental/new', async (request) => {
      const payload = ExperimentalCreateDraftRequestSchema.parse(request.body ?? {});
      return experimental.createNewDraft(payload);
    });
    fastify.post('/api/experimental/import', async (request) => {
      const payload = ExperimentalImportRequestSchema.parse(request.body ?? {});
      return experimental.importNuxPreset(payload);
    });
    fastify.put('/api/experimental/meta', async (request) => {
      const payload = ExperimentalMetaRequestSchema.parse(request.body ?? {});
      return experimental.setMeta(payload);
    });
    fastify.put('/api/experimental/param', async (request) => {
      const { index, value } = ExperimentalParamRequestSchema.parse(request.body ?? {});
      return experimental.setAmpParam(index, value);
    });
    fastify.put('/api/experimental/block', async (request) => {
      const { block, on } = ExperimentalBlockRequestSchema.parse(request.body ?? {});
      return experimental.setBlock(block, on);
    });
    fastify.put('/api/experimental/block-model', async (request) => {
      const { block, modelId } = ExperimentalBlockModelRequestSchema.parse(request.body ?? {});
      return experimental.setBlockModel(block, modelId);
    });
    fastify.put('/api/experimental/block-param', async (request) => {
      const { block, index, value } = ExperimentalBlockParamRequestSchema.parse(
        request.body ?? {},
      );
      return experimental.setBlockParam(block, index, value);
    });
    fastify.put('/api/experimental/level', async (request) => {
      const { target, value } = ExperimentalLevelRequestSchema.parse(request.body ?? {});
      return experimental.setLevelParam(target, value);
    });
    fastify.post('/api/experimental/save', async (request) => {
      const { confirmSlot } = ExperimentalSaveRequestSchema.parse(request.body ?? {});
      return experimental.save(confirmSlot);
    });
  }

  // Static Frontend Serving (SPA fallback when packages/frontend/dist exists)
  fastify.setNotFoundHandler(async (request, reply) => {
    const rawUrl = request.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';
    const isApiOrWs =
      pathname === '/api' ||
      pathname.startsWith('/api/') ||
      pathname === '/ws' ||
      pathname.startsWith('/ws/');

    if (
      !isApiOrWs &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      staticDir &&
      fs.existsSync(staticDir)
    ) {
      const resolvedStaticRoot = path.resolve(staticDir);
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(pathname);
      } catch {
        return reply.status(400).send({
          code: 'BAD_REQUEST',
          message: 'Caminho URL inválido.',
          timestamp: new Date().toISOString(),
        });
      }
      if (decodedPath.includes('\0')) {
        return reply.status(400).send({
          code: 'BAD_REQUEST',
          message: 'Caminho URL inválido.',
          timestamp: new Date().toISOString(),
        });
      }
      const relativePath = decodedPath.replace(/^\/+/, '');
      const candidatePath = path.resolve(resolvedStaticRoot, relativePath);
      const relFromRoot = path.relative(resolvedStaticRoot, candidatePath);
      const isInsideStaticRoot =
        relFromRoot.length > 0 &&
        !relFromRoot.startsWith('..') &&
        !path.isAbsolute(relFromRoot);

      if (relativePath.length > 0 && isInsideStaticRoot) {
        try {
          const stats = await fs.promises.stat(candidatePath);
          if (stats.isFile()) {
            const ext = path.extname(candidatePath).toLowerCase();
            const contentType =
              STATIC_MIME_TYPES[ext] ?? 'application/octet-stream';
            const content = await fs.promises.readFile(candidatePath);
            return reply.type(contentType).send(content);
          }
        } catch {
          // Fall through to index.html
        }
      }

      const indexHtmlPath = path.join(resolvedStaticRoot, 'index.html');
      try {
        const indexContent = await fs.promises.readFile(indexHtmlPath);
        return reply.type('text/html; charset=utf-8').send(indexContent);
      } catch {
        // Fall through to 404
      }
    }

    return reply.status(404).send({
      code: 'NOT_FOUND',
      message: `Rota não encontrada: ${request.method} ${pathname}`,
      timestamp: new Date().toISOString(),
    });
  });

  const decoratedApp = Object.assign(fastify, {
    app: fastify,
    stateManager,
    pairingManager,
    wss,
    broadcastWsMessage,
  }) as QuickToneBackendApp;

  return decoratedApp;
}
