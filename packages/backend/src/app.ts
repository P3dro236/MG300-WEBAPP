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
  SelectPresetRequestSchema,
  UpdateVolumeRequestSchema,
  UpdateVolumeTargetRequestSchema,
  WsClientMessageSchema,
  type WsServerMessage,
} from '@quicktone/shared';
import { MidiServiceError } from '@quicktone/midi';
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

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local')
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
    // 127.0.0.0/8 (loopback)
    if (a === 127) {
      return true;
    }
    // 10.0.0.0/8 (RFC 1918 private LAN)
    if (a === 10) {
      return true;
    }
    // 192.168.0.0/16 (RFC 1918 private LAN)
    if (a === 192 && b === 168) {
      return true;
    }
    // 172.16.0.0/12 (RFC 1918 private LAN)
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    // 169.254.0.0/16 (Link-local)
    if (a === 169 && b === 254) {
      return true;
    }
    return false;
  }

  // IPv6 Link-Local (fe80::/10) or Unique Local (fc00::/7)
  if (/^(fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(hostname)) {
    return true;
  }

  return false;
}

function extractAuthToken(request: FastifyRequest): string | null {
  const customHeader = request.headers['x-quicktone-token'];
  if (typeof customHeader === 'string' && customHeader.trim().length > 0) {
    return customHeader.trim();
  }
  if (Array.isArray(customHeader) && customHeader[0]?.trim()) {
    return customHeader[0].trim();
  }

  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    return trimmed;
  }

  return null;
}

export interface BackendAppOptions extends ControllerStateManagerOptions {
  stateManager?: ControllerStateManager;
  allowedOrigins?: readonly string[];
  staticDir?: string | null;
  logger?: boolean;
  disposeStateManagerOnClose?: boolean;
}

export type QuickToneBackendApp = FastifyInstance & {
  app: FastifyInstance;
  stateManager: ControllerStateManager;
  wss: WebSocketServer;
  broadcastWsMessage: (message: WsServerMessage) => void;
};

export function createBackendApp(options: BackendAppOptions = {}): QuickToneBackendApp {
  const stateManager =
    options.stateManager ??
    new ControllerStateManager({
      discoveryService: options.discoveryService,
      midiService: options.midiService,
      midiAdapter: options.midiAdapter,
      midiOptions: options.midiOptions,
      presetsDirectory: options.presetsDirectory,
      includeFactoryPresets: options.includeFactoryPresets,
      fillMissingUserSlots: options.fillMissingUserSlots,
      enableSysExSync: options.enableSysExSync,
      lanUrls: options.lanUrls,
      serverPort: options.serverPort,
      authToken: options.authToken,
      autoConnectMidiOnInit: options.autoConnectMidiOnInit,
    });

  if (options.stateManager && options.authToken !== undefined) {
    stateManager.setAuthToken(options.authToken);
  }

  const allowedOrigins = options.allowedOrigins ?? [];
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

  const buildStateSyncMessage = (): WsServerMessage => ({
    type: 'state_sync',
    state: stateManager.getState(),
    presets: stateManager.getPresetsResponse().presets,
    timestamp: new Date().toISOString(),
  });

  wss.on('connection', (ws: WebSocket) => {
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

    const originHeader = request.headers.origin;
    if (
      typeof originHeader === 'string' &&
      !isAllowedLanOrigin(originHeader, allowedOrigins)
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (stateManager.isAuthRequired()) {
      let queryToken: string | null = null;
      try {
        queryToken = new URL(rawUrl, 'http://localhost').searchParams.get('token');
      } catch {
        queryToken = null;
      }
      const headerToken = extractAuthToken(request as unknown as FastifyRequest);
      if (!stateManager.validateAuthToken(queryToken || headerToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
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

  // LAN CORS, Origin validation & Token Authentication Hook
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const originHeader = request.headers.origin;
    const hasOrigin = typeof originHeader === 'string' && originHeader.trim().length > 0;
    const isOriginAllowed =
      hasOrigin && isAllowedLanOrigin(originHeader, allowedOrigins);

    if (hasOrigin && isOriginAllowed) {
      reply.header('Access-Control-Allow-Origin', originHeader);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      reply.header(
        'Access-Control-Allow-Headers',
        'Content-Type, X-QuickTone-Token, Authorization',
      );
    }

    if (request.method === 'OPTIONS') {
      if (hasOrigin && !isOriginAllowed) {
        return reply.status(403).send({
          code: 'FORBIDDEN_ORIGIN',
          message: `Origem externa bloqueada pela política de segurança LAN: "${originHeader}".`,
          timestamp: new Date().toISOString(),
        });
      }
      return reply.status(204).send();
    }

    if (CONTROL_HTTP_METHODS.has(request.method)) {
      if (hasOrigin && !isOriginAllowed) {
        return reply.status(403).send({
          code: 'FORBIDDEN_ORIGIN',
          message: `Origem externa bloqueada pela política de segurança LAN: "${originHeader}".`,
          timestamp: new Date().toISOString(),
        });
      }

      if (stateManager.isAuthRequired()) {
        const token = extractAuthToken(request);
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

    if (error instanceof PresetNotFoundError) {
      return reply.status(404).send({
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

    return reply.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).send({
      code: statusCode === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Erro interno no servidor.',
      timestamp: new Date().toISOString(),
    });
  });

  // REST Endpoints

  fastify.get('/api/health', async () => {
    return stateManager.getHealth();
  });

  fastify.get('/api/presets', async (request) => {
    if (
      stateManager.isAuthRequired() &&
      !stateManager.validateAuthToken(extractAuthToken(request))
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
      stateManager.isAuthRequired() &&
      !stateManager.validateAuthToken(extractAuthToken(request))
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
    wss,
    broadcastWsMessage,
  }) as QuickToneBackendApp;

  return decoratedApp;
}
