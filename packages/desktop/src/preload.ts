import { contextBridge, ipcRenderer } from 'electron';
import {
  type AppInfoV1,
  type AuthSessionResponseV1,
  CONTRACT_VERSION_V1,
  type DeviceIdentityV1,
  type DiagnosticsExportResultV1,
  type LocalCoreStatusV1,
  type MgControlDesktopBridgeV1,
  type OkResponseV1,
  type OpenExternalUrlResponseV1,
  type UpdateCheckResultV1,
} from '@quicktone/shared';

export type { MgControlDesktopBridgeV1 };

const mgControlBridge: MgControlDesktopBridgeV1 = Object.freeze({
  contractVersion: CONTRACT_VERSION_V1,
  getAppInfo: (): Promise<AppInfoV1> => ipcRenderer.invoke('mg:v1:app:get-info'),
  getCoreStatus: (): Promise<LocalCoreStatusV1> => ipcRenderer.invoke('mg:v1:core:get-status'),
  restartCore: (): Promise<LocalCoreStatusV1> => ipcRenderer.invoke('mg:v1:core:restart'),
  exportDiagnostics: (): Promise<DiagnosticsExportResultV1> =>
    ipcRenderer.invoke('mg:v1:diagnostics:export'),
  openExternalUrl: (url: string): Promise<OpenExternalUrlResponseV1> =>
    ipcRenderer.invoke('mg:v1:external:open-url', { url }),
  checkForUpdates: (): Promise<UpdateCheckResultV1> => ipcRenderer.invoke('mg:v1:update:check'),
  getAuthSession: (): Promise<AuthSessionResponseV1 | null> =>
    ipcRenderer.invoke('mg:v1:auth:get-session'),
  setAuthSession: (session: AuthSessionResponseV1): Promise<AuthSessionResponseV1> =>
    ipcRenderer.invoke('mg:v1:auth:set-session', session),
  clearAuthSession: (): Promise<OkResponseV1> => ipcRenderer.invoke('mg:v1:auth:clear-session'),
  getDeviceIdentity: (): Promise<DeviceIdentityV1> =>
    ipcRenderer.invoke('mg:v1:device:get-identity'),
});

contextBridge.exposeInMainWorld('mgControl', mgControlBridge);
