import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BackendAppOptions,
  createBackendApp,
  isAllowedLanOrigin,
  type QuickToneBackendApp,
} from './app.js';
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
  computeLocalLanUrls,
  getLocalLanAddresses,
  ControllerStateManager,
  PresetNotFoundError,
  type BackendAppOptions,
  type QuickToneBackendApp,
  type ControllerStateManagerOptions,
  type StateChangeListener,
  type PresetsUpdatedListener,
};

export interface StartBackendServerOptions extends BackendAppOptions {
  host?: string;
  port?: number;
}

export async function startBackendServer(
  options: StartBackendServerOptions = {},
): Promise<{ app: QuickToneBackendApp; address: string; port: number }> {
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const rawPort = options.port ?? Number(process.env.PORT ?? 3001);
  const port = Number.isInteger(rawPort) && rawPort >= 0 ? rawPort : 3001;
  const isRealAdapter =
    options.midiAdapter === undefined && process.env.QUICKTONE_MIDI_ADAPTER !== 'mock';

  const app = createBackendApp({
    autoConnectMidiOnInit: true,
    includeFactoryPresets: options.includeFactoryPresets ?? true,
    fillMissingUserSlots: options.fillMissingUserSlots ?? true,
    enableSysExSync: options.enableSysExSync ?? isRealAdapter,
    serverPort: port,
    ...options,
  });

  const address = await app.listen({ host, port });
  const boundAddress = app.server.address();
  const actualPort =
    typeof boundAddress === 'object' && boundAddress !== null ? boundAddress.port : port;
  app.stateManager.setLanUrls(getLocalLanAddresses().map((ip) => `http://${ip}:${actualPort}`));

  return { app, address, port: actualPort };
}

function isExecutedDirectly(): boolean {
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

if (isExecutedDirectly()) {
  void startBackendServer()
    .then(({ app, port }) => {
      const lanIps = getLocalLanAddresses();
      console.log(`[QuickTone Web Controller] Backend listening on http://0.0.0.0:${port}`);
      console.log(`  Local:   http://localhost:${port}`);
      for (const ip of lanIps) {
        console.log(`  LAN:     http://${ip}:${port}`);
      }

      const shutdown = async (): Promise<void> => {
        try {
          await app.close();
        } finally {
          process.exit(0);
        }
      };

      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
    })
    .catch((err) => {
      console.error('[QuickTone Web Controller] Failed to start backend server:', err);
      process.exit(1);
    });
}
