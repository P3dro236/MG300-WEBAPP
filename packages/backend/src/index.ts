import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION_V1, LocalCoreBootstrapEventV1Schema } from '@quicktone/shared';
import { loadEnvFiles, MONOREPO_ROOT } from './env.js';
import {
  type BackendAppOptions,
  createBackendApp,
  isAllowedLanHost,
  isAllowedLanOrigin,
  isPrivateOrLoopbackIp,
  type QuickToneBackendApp,
} from './app.js';
import {
  PairingError,
  PairingManager,
  type PairingManagerOptions,
} from './pairing-manager.js';
import {
  computeLocalLanUrls,
  ControllerStateManager,
  type ControllerStateManagerOptions,
  getLocalLanAddresses,
  PresetNotFoundError,
  type PresetsUpdatedListener,
  type StateChangeListener,
} from './state-manager.js';

export {
  createBackendApp,
  isAllowedLanOrigin,
  isAllowedLanHost,
  isPrivateOrLoopbackIp,
  PairingManager,
  PairingError,
  computeLocalLanUrls,
  getLocalLanAddresses,
  ControllerStateManager,
  PresetNotFoundError,
  type BackendAppOptions,
  type QuickToneBackendApp,
  type PairingManagerOptions,
  type ControllerStateManagerOptions,
  type StateChangeListener,
  type PresetsUpdatedListener,
};

export interface StartBackendServerOptions extends BackendAppOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  allowPortFallback?: boolean;
}

export interface StartBackendServerResult {
  app: QuickToneBackendApp;
  address: string;
  host: string;
  port: number;
  lanUrls: string[];
  dataDir: string;
}

function resolvePreferredPort(explicitPort?: number): number {
  if (
    explicitPort !== undefined &&
    Number.isInteger(explicitPort) &&
    explicitPort >= 0 &&
    explicitPort <= 65535
  ) {
    return explicitPort;
  }
  const rawEnv = (process.env.PORT ?? process.env.MG_PORT ?? '').trim();
  if (rawEnv.length > 0) {
    const parsed = Number(rawEnv);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return 3001;
}

function buildCandidatePorts(preferredPort: number, allowPortFallback: boolean): number[] {
  if (!allowPortFallback || preferredPort === 0) {
    return [preferredPort];
  }
  const candidates: number[] = [];
  const maxOffset = Math.min(20, 65535 - preferredPort + 1);
  for (let offset = 0; offset < maxOffset; offset += 1) {
    candidates.push(preferredPort + offset);
  }
  candidates.push(0);
  return candidates;
}

function isPortBindError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  if (port === 0) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host, port }, () => {
      probe.close(() => resolve(true));
    });
  });
}

function resolveConfiguredDataDir(explicitDataDir?: string): string | undefined {
  const raw = explicitDataDir?.trim() || process.env.MG_DATA_DIR?.trim();
  return raw ? path.resolve(raw) : undefined;
}

export async function startBackendServer(
  options: StartBackendServerOptions = {},
): Promise<StartBackendServerResult> {
  loadEnvFiles();
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const preferredPort = resolvePreferredPort(options.port);
  const allowPortFallback =
    options.allowPortFallback ?? process.env.MG_ALLOW_PORT_FALLBACK === '1';
  const isRealAdapter =
    options.midiAdapter === undefined && process.env.QUICKTONE_MIDI_ADAPTER !== 'mock';

  const resolvedDataDir = resolveConfiguredDataDir(options.dataDir);
  if (resolvedDataDir) {
    fs.mkdirSync(path.join(resolvedDataDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(resolvedDataDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(resolvedDataDir, 'backups'), { recursive: true });
    if (!process.env.QUICKTONE_MIDI_LOG_FILE?.trim()) {
      process.env.QUICKTONE_MIDI_LOG_FILE = path.join(
        resolvedDataDir,
        'logs',
        'midi-diagnostics.log',
      );
    }
  }

  const effectiveDataDir = resolvedDataDir ?? path.resolve(MONOREPO_ROOT, 'data');
  const defaultAiGearPath = resolvedDataDir
    ? path.join(resolvedDataDir, 'data', 'user-gear.json')
    : path.resolve(MONOREPO_ROOT, 'data', 'user-gear.json');
  const defaultTrustedDevicesPath = resolvedDataDir
    ? path.join(resolvedDataDir, 'data', 'trusted-devices.json')
    : path.resolve(process.cwd(), 'data', 'trusted-devices.json');
  const defaultExperimentalBackupDir = resolvedDataDir
    ? path.join(resolvedDataDir, 'backups')
    : (process.env.QUICKTONE_BACKUP_DIR?.trim() || path.resolve(process.cwd(), 'backups'));
  const envStaticDir = process.env.MG_STATIC_DIR?.trim();
  const resolvedStaticDir =
    options.staticDir !== undefined
      ? options.staticDir
      : envStaticDir
        ? path.resolve(envStaticDir)
        : undefined;

  const {
    serverPort: explicitServerPort,
    dataDir: _dataDirOpt,
    allowPortFallback: _allowPortFallbackOpt,
    host: _hostOpt,
    port: _portOpt,
    staticDir: _staticDirOpt,
    pairingOptions,
    ...restOptions
  } = options;

  const candidatePorts = buildCandidatePorts(preferredPort, allowPortFallback);
  let lastBindError: unknown = null;

  for (const candidatePort of candidatePorts) {
    if (allowPortFallback && candidatePort !== 0) {
      const available = await isPortAvailable(host, candidatePort);
      if (!available) {
        continue;
      }
    }

    const effectiveServerPort =
      allowPortFallback && candidatePort !== preferredPort
        ? candidatePort
        : (explicitServerPort ?? candidatePort);

    const app = createBackendApp({
      autoConnectMidiOnInit: true,
      includeFactoryPresets: options.includeFactoryPresets ?? true,
      fillMissingUserSlots: options.fillMissingUserSlots ?? false,
      enableSysExSync: options.enableSysExSync ?? isRealAdapter,
      experimentalEdit:
        options.experimentalEdit ?? process.env.QUICKTONE_EXPERIMENTAL_EDIT !== '0',
      aiGearPath: defaultAiGearPath,
      experimentalBackupDir: defaultExperimentalBackupDir,
      ...(resolvedStaticDir !== undefined ? { staticDir: resolvedStaticDir } : {}),
      ...restOptions,
      serverPort: effectiveServerPort,
      pairingOptions: {
        trustedDevicesPath: defaultTrustedDevicesPath,
        ...pairingOptions,
      },
    });

    try {
      const address = await app.listen({ host, port: candidatePort });
      const boundAddress = app.server.address();
      const actualPort =
        typeof boundAddress === 'object' && boundAddress !== null
          ? boundAddress.port
          : candidatePort;
      const lanUrls = getLocalLanAddresses().map((ip) => `http://${ip}:${actualPort}`);
      app.stateManager.setLanUrls(lanUrls);

      return {
        app,
        address,
        host,
        port: actualPort,
        lanUrls,
        dataDir: effectiveDataDir,
      };
    } catch (err) {
      await app.close().catch(() => undefined);
      if (allowPortFallback && isPortBindError(err)) {
        lastBindError = err;
        continue;
      }
      throw err;
    }
  }

  throw (
    lastBindError ??
    new Error(
      `Não foi possível iniciar servidor HTTP em ${host} (porta preferencial ${preferredPort}).`,
    )
  );
}

function isExecutedDirectly(): boolean {
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    return true;
  }
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    const currentFile = path.resolve(fileURLToPath(import.meta.url));
    const entryFile = path.resolve(entryArg);
    return currentFile.toLowerCase() === entryFile.toLowerCase();
  } catch {
    return false;
  }
}

function attachParentIpcShutdown(onShutdown: () => void): void {
  if (process.env.MG_CORE_IPC_STDIN !== '1') {
    return;
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as { cmd?: unknown };
          if (msg.cmd === 'shutdown') {
            onShutdown();
            return;
          }
        } catch {
          // Ignore malformed control frames on stdin
        }
      }
      newlineIdx = buffer.indexOf('\n');
    }
  });
  process.stdin.once('end', onShutdown);
  process.stdin.once('close', onShutdown);
  process.stdin.resume();
}

if (isExecutedDirectly()) {
  loadEnvFiles();
  void startBackendServer()
    .then(({ app, host, port, lanUrls, dataDir }) => {
      const lanIps = getLocalLanAddresses();
      console.log(`[QuickTone Web Controller] Backend listening on http://0.0.0.0:${port}`);
      console.log(`  Local:   http://localhost:${port}`);
      for (const ip of lanIps) {
        console.log(`  LAN:     http://${ip}:${port}`);
      }

      const bootstrapHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      const bootstrapEvent = LocalCoreBootstrapEventV1Schema.parse({
        event: 'ready',
        contractVersion: CONTRACT_VERSION_V1,
        host: bootstrapHost,
        port,
        lanUrls,
        pid: process.pid,
        dataDir,
        startedAt: new Date().toISOString(),
      });
      process.stdout.write(`__MG_CORE_BOOTSTRAP__:${JSON.stringify(bootstrapEvent)}\n`);

      let shutdownPromise: Promise<void> | null = null;
      const shutdown = (): void => {
        if (shutdownPromise) {
          return;
        }
        const forceExitTimer = setTimeout(() => {
          process.exit(0);
        }, 4500);
        forceExitTimer.unref();

        shutdownPromise = app
          .close()
          .catch((err) => {
            console.error('[QuickTone Web Controller] Error during shutdown:', err);
          })
          .finally(() => {
            clearTimeout(forceExitTimer);
            process.exit(0);
          });
      };

      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      attachParentIpcShutdown(shutdown);
    })
    .catch((err) => {
      console.error('[QuickTone Web Controller] Failed to start backend server:', err);
      process.exit(1);
    });
}
