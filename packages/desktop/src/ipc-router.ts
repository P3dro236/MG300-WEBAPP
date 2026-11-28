import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  type AppInfoV1,
  AppInfoV1Schema,
  type AuthSessionResponseV1,
  AuthSessionResponseV1Schema,
  CONTRACT_VERSION_V1,
  type DeviceIdentityV1,
  DeviceIdentityV1Schema,
  type DiagnosticsExportResultV1,
  DiagnosticsExportResultV1Schema,
  IPC_CHANNELS_V1,
  type IpcChannelV1,
  type LocalCoreStatusV1,
  LocalCoreStatusV1Schema,
  type OkResponseV1,
  OkResponseV1Schema,
  OpenExternalUrlRequestV1Schema,
  type OpenExternalUrlResponseV1,
  OpenExternalUrlResponseV1Schema,
  type UpdateCheckResultV1,
  UpdateCheckResultV1Schema,
} from '@quicktone/shared';
import type { LocalCoreSupervisor } from './core-supervisor.js';
import type { DpapiSessionStore } from './dpapi-store.js';
import type { DesktopPaths } from './paths.js';
import { isAllowedExternalUrl, isAllowedInAppNavigationUrl } from './security.js';

export interface DesktopIpcDependencies {
  paths: DesktopPaths;
  appVersion: string;
  supervisor: Pick<LocalCoreSupervisor, 'getStatus' | 'restart' | 'exportDiagnostics'>;
  sessionStore: Pick<
    DpapiSessionStore,
    'getSession' | 'setSession' | 'clearSession' | 'getOrCreateDeviceIdentity'
  >;
  openExternalUrl: (httpsUrl: string) => Promise<void>;
  checkForUpdates?: () => Promise<UpdateCheckResultV1>;
}

export interface DesktopIpcHandlers {
  'mg:v1:app:get-info': () => Promise<AppInfoV1>;
  'mg:v1:core:get-status': () => Promise<LocalCoreStatusV1>;
  'mg:v1:core:restart': () => Promise<LocalCoreStatusV1>;
  'mg:v1:diagnostics:export': () => Promise<DiagnosticsExportResultV1>;
  'mg:v1:external:open-url': (rawPayload: unknown) => Promise<OpenExternalUrlResponseV1>;
  'mg:v1:update:check': () => Promise<UpdateCheckResultV1>;
  'mg:v1:auth:get-session': () => Promise<AuthSessionResponseV1 | null>;
  'mg:v1:auth:set-session': (rawPayload: unknown) => Promise<AuthSessionResponseV1>;
  'mg:v1:auth:clear-session': () => Promise<OkResponseV1>;
  'mg:v1:device:get-identity': () => Promise<DeviceIdentityV1>;
}

export function createIpcHandlers(deps: DesktopIpcDependencies): DesktopIpcHandlers {
  return {
    'mg:v1:app:get-info': async () =>
      AppInfoV1Schema.parse({
        appName: 'MG Control',
        appVersion: deps.appVersion,
        contractVersion: CONTRACT_VERSION_V1,
        platform: 'win32',
        arch: 'x64',
        dataDir: deps.paths.dataDir,
        isPackaged: deps.paths.isPackaged,
      }),

    'mg:v1:core:get-status': async () => LocalCoreStatusV1Schema.parse(deps.supervisor.getStatus()),

    'mg:v1:core:restart': async () =>
      LocalCoreStatusV1Schema.parse(await deps.supervisor.restart()),

    'mg:v1:diagnostics:export': async () =>
      DiagnosticsExportResultV1Schema.parse(deps.supervisor.exportDiagnostics()),

    'mg:v1:external:open-url': async (rawPayload: unknown) => {
      const parsed = OpenExternalUrlRequestV1Schema.parse(rawPayload);
      if (!isAllowedExternalUrl(parsed.url)) {
        throw new Error('URL externa bloqueada: apenas URLs HTTPS válidas são permitidas.');
      }
      await deps.openExternalUrl(parsed.url);
      return OpenExternalUrlResponseV1Schema.parse({ opened: true });
    },

    'mg:v1:update:check': async () => {
      if (deps.checkForUpdates) {
        return UpdateCheckResultV1Schema.parse(await deps.checkForUpdates());
      }
      return UpdateCheckResultV1Schema.parse({
        currentVersion: deps.appVersion,
        updateAvailable: false,
        manifest: null,
        checkedAt: new Date().toISOString(),
      });
    },

    'mg:v1:auth:get-session': async () => {
      const session = deps.sessionStore.getSession();
      return session === null ? null : AuthSessionResponseV1Schema.parse(session);
    },

    'mg:v1:auth:set-session': async (rawPayload: unknown) => {
      const parsed = AuthSessionResponseV1Schema.parse(rawPayload);
      return AuthSessionResponseV1Schema.parse(deps.sessionStore.setSession(parsed));
    },

    'mg:v1:auth:clear-session': async () => {
      deps.sessionStore.clearSession();
      return OkResponseV1Schema.parse({ ok: true });
    },

    'mg:v1:device:get-identity': async () =>
      DeviceIdentityV1Schema.parse(deps.sessionStore.getOrCreateDeviceIdentity()),
  };
}

export function assertValidIpcSender(
  senderUrl: string,
  allowedOrigins: readonly string[],
): void {
  if (!isAllowedInAppNavigationUrl(senderUrl, allowedOrigins)) {
    throw new Error(`Origem IPC não autorizada: ${senderUrl || '<vazia>'}`);
  }
}

export function registerTypedIpcHandlers(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  handlers: DesktopIpcHandlers,
  getAllowedOrigins: () => readonly string[],
  isSenderAuthorized?: (event: IpcMainInvokeEvent) => boolean,
): () => void {
  const registeredChannels: IpcChannelV1[] = [];

  for (const channel of IPC_CHANNELS_V1) {
    ipcMain.removeHandler(channel);
    const handler = handlers[channel];
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, rawPayload?: unknown) => {
      if (isSenderAuthorized && !isSenderAuthorized(event)) {
        throw new Error('Frame IPC não autorizado.');
      }
      const senderUrl = event.senderFrame ? event.senderFrame.url : '';
      assertValidIpcSender(senderUrl, getAllowedOrigins());
      return handler(rawPayload);
    });
    registeredChannels.push(channel);
  }

  return () => {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
  };
}
