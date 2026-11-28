import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { LocalCoreSupervisor } from './core-supervisor.js';
import { DpapiSessionStore } from './dpapi-store.js';
import { createIpcHandlers, registerTypedIpcHandlers } from './ipc-router.js';
import {
  ensureDesktopDirectories,
  resolveDesktopPaths,
  runNonDestructiveLegacyMigration,
} from './paths.js';
import {
  buildDesktopCspHeader,
  createSecureWebPreferences,
  isAllowedExternalUrl,
  isAllowedInAppNavigationUrl,
} from './security.js';

function resolveDevRendererUrl(): string | null {
  const raw = process.env.MG_DESKTOP_DEV_URL?.trim();
  if (!raw || app.isPackaged) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return parsed.toString();
    }
  } catch {
    // Ignore invalid dev renderer override
  }
  return null;
}

function stripCaseInsensitiveHeader(
  headers: Record<string, string | string[]> | undefined,
  headerName: string,
): Record<string, string | string[]> {
  const target = headerName.toLowerCase();
  const next: Record<string, string | string[]> = {};
  if (!headers) {
    return next;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      next[key] = value;
    }
  }
  return next;
}

app.setName('MG Control');
const desktopPaths = resolveDesktopPaths({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  userDataDir:
    process.env.MG_DATA_DIR?.trim() || path.join(app.getPath('appData'), 'MG Control'),
});
app.setPath('userData', desktopPaths.dataDir);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  void bootstrapDesktopApp();
}

async function bootstrapDesktopApp(): Promise<void> {
  ensureDesktopDirectories(desktopPaths);

  let mainWindow: BrowserWindow | null = null;
  let lastKnownCoreOrigin: string | null = null;
  const devRendererUrl = resolveDevRendererUrl();

  const supervisor = new LocalCoreSupervisor({
    paths: desktopPaths,
    appVersion: app.getVersion() || '1.0.0',
    preferredPort: Number(process.env.MG_PORT ?? process.env.PORT ?? 3001) || 3001,
    onStatusChange: (status) => {
      if (status.status !== 'running' || !status.baseUrl) {
        return;
      }
      try {
        const targetOrigin = new URL(status.baseUrl).origin;
        lastKnownCoreOrigin = targetOrigin;

        if (devRendererUrl || !mainWindow || mainWindow.isDestroyed()) {
          return;
        }
        const currentUrl = mainWindow.webContents.getURL();
        const currentOrigin = currentUrl ? new URL(currentUrl).origin : '';
        if (currentOrigin !== targetOrigin) {
          void mainWindow.loadURL(status.baseUrl).catch((err) => {
            supervisor.logLine(
              'warn',
              `Falha ao recarregar janela após troca de origem do core: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      } catch {
        // Ignore transient URL parse error
      }
    },
  });

  const migrationResult = runNonDestructiveLegacyMigration({
    legacyRootDir: desktopPaths.legacyRootDir,
    targetUserDataDir: desktopPaths.dataDir,
    migrationSentinelPath: desktopPaths.migrationSentinelPath,
  });
  if (!migrationResult.alreadyCompleted) {
    supervisor.logLine(
      'info',
      `Migração não destrutiva concluída: ${migrationResult.copiedFiles.length} arquivo(s) copiado(s), ${migrationResult.skippedExistingTargets.length} preservado(s), ${migrationResult.errors.length} erro(s).`,
    );
  }

  const sessionStore = new DpapiSessionStore({
    sessionFilePath: desktopPaths.dpapiSessionPath,
    deviceIdentityPath: desktopPaths.deviceIdentityPath,
    safeStorage,
    logWarning: (message) => supervisor.logLine('warn', message),
  });

  let unregisterIpc: (() => void) | null = null;
  let quitCleanupCompleted = false;
  let quitCleanupInFlight = false;

  const focusPrimaryWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  };

  app.on('second-instance', () => {
    focusPrimaryWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (quitCleanupCompleted) {
      return;
    }
    event.preventDefault();
    if (quitCleanupInFlight) {
      return;
    }
    quitCleanupInFlight = true;
    unregisterIpc?.();
    unregisterIpc = null;
    void supervisor
      .stop()
      .catch((err) => {
        supervisor.logLine(
          'error',
          `Falha ao encerrar Local Core no before-quit: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        quitCleanupCompleted = true;
        app.quit();
      });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.quit();
    });
  }

  await app.whenReady();

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const getAllowedNavigationOrigins = (): string[] => {
    const origins: string[] = [];
    const currentBaseUrl = supervisor.getStatus().baseUrl;
    if (currentBaseUrl) {
      try {
        origins.push(new URL(currentBaseUrl).origin);
      } catch {
        // Ignore malformed status URL
      }
    }
    if (devRendererUrl) {
      origins.push(new URL(devRendererUrl).origin);
    }
    return origins;
  };

  const getAllowedIpcOrigins = (): string[] => {
    const origins = new Set<string>(getAllowedNavigationOrigins());
    if (lastKnownCoreOrigin) {
      origins.add(lastKnownCoreOrigin);
    }
    return [...origins];
  };

  const ipcHandlers = createIpcHandlers({
    paths: desktopPaths,
    appVersion: app.getVersion() || '1.0.0',
    supervisor,
    sessionStore,
    openExternalUrl: async (httpsUrl: string) => {
      await shell.openExternal(httpsUrl);
    },
  });
  unregisterIpc = registerTypedIpcHandlers(
    ipcMain,
    ipcHandlers,
    getAllowedIpcOrigins,
    (event) =>
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      event.senderFrame === mainWindow.webContents.mainFrame,
  );

  let initialStatus;
  try {
    initialStatus = await supervisor.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    supervisor.logLine('error', `Falha crítica na inicialização do Local Core: ${message}`);
    if (process.env.MG_HEADLESS_EXIT_ON_BOOT_ERROR === '1') {
      app.exit(1);
      return;
    }
    dialog.showErrorBox(
      'MG Control — Falha ao iniciar núcleo local',
      `Não foi possível iniciar o servidor local da pedaleira.\n\nDetalhes: ${message}`,
    );
    app.exit(1);
    return;
  }

  if (!initialStatus.baseUrl) {
    const msg = 'Local Core iniciou sem URL base válida.';
    supervisor.logLine('error', msg);
    app.exit(1);
    return;
  }

  const coreBaseUrl = initialStatus.baseUrl;
  lastKnownCoreOrigin = new URL(coreBaseUrl).origin;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const allowedOrigins = getAllowedNavigationOrigins();
    let applyCsp = false;
    try {
      applyCsp = allowedOrigins.includes(new URL(details.url).origin);
    } catch {
      applyCsp = false;
    }
    if (!applyCsp) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const activeCoreBaseUrl = supervisor.getStatus().baseUrl ?? coreBaseUrl;
    const dynamicCsp = buildDesktopCspHeader(
      activeCoreBaseUrl,
      devRendererUrl ? [devRendererUrl] : [],
    );
    const cleanHeaders = stripCaseInsensitiveHeader(
      stripCaseInsensitiveHeader(details.responseHeaders, 'Content-Security-Policy'),
      'X-Content-Type-Options',
    );
    callback({
      responseHeaders: {
        ...cleanHeaders,
        'Content-Security-Policy': [dynamicCsp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  mainWindow = new BrowserWindow({
    title: 'MG Control',
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    show: false,
    webPreferences: createSecureWebPreferences(desktopPaths.preloadPath),
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedInAppNavigationUrl(targetUrl, getAllowedNavigationOrigins())) {
      supervisor.logLine('warn', `Navegação inesperada bloqueada: ${targetUrl}`);
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('will-redirect', (event, targetUrl) => {
    if (!isAllowedInAppNavigationUrl(targetUrl, getAllowedNavigationOrigins())) {
      supervisor.logLine('warn', `Redirecionamento inesperado bloqueado: ${targetUrl}`);
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url).catch((err) => {
        supervisor.logLine(
          'warn',
          `Falha ao abrir URL externa no navegador: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } else {
      supervisor.logLine('warn', `Popup/URL externa bloqueada: ${url}`);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const targetStartUrl = devRendererUrl ?? coreBaseUrl;
  await mainWindow.loadURL(targetStartUrl).catch((err) => {
    supervisor.logLine(
      'error',
      `Falha ao carregar URL inicial do renderer: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    app.exit(1);
  });
}
