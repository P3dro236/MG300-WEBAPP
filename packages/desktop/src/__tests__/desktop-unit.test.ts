import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthSessionResponseV1,
  CONTRACT_VERSION_V1,
  IPC_CHANNELS_V1,
  type LocalCoreStatusV1,
} from '@quicktone/shared';
import { DpapiSessionStore, type SafeStorageAdapter } from '../dpapi-store.js';
import { createIpcHandlers, registerTypedIpcHandlers } from '../ipc-router.js';
import { resolveDesktopPaths, runNonDestructiveLegacyMigration } from '../paths.js';
import { sanitizeDiagnosticPayload, sanitizeLogText } from '../sanitizer.js';
import {
  buildDesktopCspHeader,
  createSecureWebPreferences,
  isAllowedExternalUrl,
  isAllowedInAppNavigationUrl,
} from '../security.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeSafeStorage(available = true): SafeStorageAdapter {
  const prefix = Buffer.from('DPAPI_ENC:', 'utf8');
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) =>
      Buffer.concat([prefix, Buffer.from(Buffer.from(plainText, 'utf8').toString('base64'), 'utf8')]),
    decryptString: (encrypted: Buffer) => {
      const asStr = encrypted.toString('utf8');
      if (!asStr.startsWith('DPAPI_ENC:')) {
        throw new Error('Invalid cipher envelope');
      }
      return Buffer.from(asStr.slice('DPAPI_ENC:'.length), 'base64').toString('utf8');
    },
  };
}

const SAMPLE_SESSION: AuthSessionResponseV1 = {
  account: {
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'guitarrista@mgcontrol.app',
    emailVerified: true,
    locale: 'pt-BR',
    createdAt: '2026-11-28T00:00:00.000Z',
  },
  tokens: {
    accessToken: 'a'.repeat(32),
    accessExpiresInSeconds: 900,
    refreshToken: 'r'.repeat(40),
    refreshExpiresAt: '2026-12-28T00:00:00.000Z',
  },
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Desktop paths and non-destructive legacy migration', () => {
  it('resolves packaged vs dev paths cleanly keeping mutable state inside userData', () => {
    const userDataDir = path.join('C:\\Users\\Pedro\\AppData\\Roaming', 'MG Control');
    const packaged = resolveDesktopPaths({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\MG Control\\resources',
      userDataDir,
    });

    expect(packaged.coreEntryPath).toBe(
      path.join('C:\\Program Files\\MG Control\\resources', 'core', 'local-core.cjs'),
    );
    expect(packaged.staticDir).toBe(
      path.join('C:\\Program Files\\MG Control\\resources', 'frontend'),
    );
    expect(packaged.dataDir).toBe(path.resolve(userDataDir));
    expect(packaged.midiLogFilePath).toBe(path.join(path.resolve(userDataDir), 'logs', 'midi-diagnostics.log'));

    const dev = resolveDesktopPaths({ isPackaged: false, userDataDir });
    expect(dev.coreEntryPath).toMatch(/packages[\\/]backend[\\/]dist[\\/]local-core\.cjs$/);
    expect(dev.staticDir).toMatch(/packages[\\/]frontend[\\/]dist$/);
  });

  it('migrates legacy files without deleting sources and never overwrites existing targets', () => {
    const legacyRoot = makeTempDir('mg-legacy-');
    const targetUserData = makeTempDir('mg-userdata-');

    fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true });
    fs.mkdirSync(path.join(legacyRoot, 'backups'), { recursive: true });
    fs.mkdirSync(path.join(legacyRoot, 'logs'), { recursive: true });

    const legacyDevices = JSON.stringify([{ deviceId: 'dev-1' }]);
    const legacyGear = JSON.stringify({ guitarModel: 'Stratocaster' });
    const legacyBackup = JSON.stringify({ slotIndex: 0 });
    const legacyLog = 'midi init ok\n';

    fs.writeFileSync(path.join(legacyRoot, 'data', 'trusted-devices.json'), legacyDevices, 'utf8');
    fs.writeFileSync(path.join(legacyRoot, 'data', 'user-gear.json'), legacyGear, 'utf8');
    fs.writeFileSync(path.join(legacyRoot, 'backups', 'slot-1A.json'), legacyBackup, 'utf8');
    fs.writeFileSync(path.join(legacyRoot, 'logs', 'midi-diagnostics.log'), legacyLog, 'utf8');

    // Pre-existing user-gear.json inside target must NOT be overwritten
    fs.mkdirSync(path.join(targetUserData, 'data'), { recursive: true });
    const newerGear = JSON.stringify({ guitarModel: 'Les Paul Custom' });
    fs.writeFileSync(path.join(targetUserData, 'data', 'user-gear.json'), newerGear, 'utf8');

    const result = runNonDestructiveLegacyMigration({
      legacyRootDir: legacyRoot,
      targetUserDataDir: targetUserData,
    });

    expect(result.alreadyCompleted).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.preserveSourceForRollback).toBe(true);
    expect(result.copiedFiles.length).toBe(3);
    expect(result.skippedExistingTargets).toContain(path.join(targetUserData, 'data', 'user-gear.json'));

    // Targets reflect copied + preserved files
    expect(fs.readFileSync(path.join(targetUserData, 'data', 'trusted-devices.json'), 'utf8')).toBe(
      legacyDevices,
    );
    expect(fs.readFileSync(path.join(targetUserData, 'backups', 'slot-1A.json'), 'utf8')).toBe(
      legacyBackup,
    );
    expect(fs.readFileSync(path.join(targetUserData, 'data', 'user-gear.json'), 'utf8')).toBe(
      newerGear,
    );

    // Legacy sources remain intact for rollback
    expect(fs.existsSync(path.join(legacyRoot, 'data', 'trusted-devices.json'))).toBe(true);
    expect(fs.existsSync(path.join(legacyRoot, 'backups', 'slot-1A.json'))).toBe(true);

    // Re-running is idempotent via sentinel
    const secondRun = runNonDestructiveLegacyMigration({
      legacyRootDir: legacyRoot,
      targetUserDataDir: targetUserData,
    });
    expect(secondRun.alreadyCompleted).toBe(true);
    expect(secondRun.copiedFiles).toEqual([]);
  });
});

describe('Log sanitizer and Electron security posture', () => {
  it('redacts tokens, emails, Windows usernames, and private LAN IPs', () => {
    const raw = [
      'Authorization: Bearer abc.def.ghi',
      'GEMINI_API_KEY=AIzaSyDummySecretKey1234567890',
      'user=musico@exemplo.com.br',
      'path=C:\\Users\\Pedro\\AppData\\Roaming\\MG Control\\logs',
      'lan=::ffff:192.168.15.42 other=10.0.0.18 v6=fd00::1234:1 ll=fe80::abcd:1',
    ].join(' | ');

    const cleaned = sanitizeLogText(raw);
    expect(cleaned).not.toContain('abc.def.ghi');
    expect(cleaned).not.toContain('AIzaSyDummySecretKey1234567890');
    expect(cleaned).not.toContain('musico@exemplo.com.br');
    expect(cleaned).not.toContain('Pedro');
    expect(cleaned).not.toContain('192.168.15.42');
    expect(cleaned).not.toContain('10.0.0.18');
    expect(cleaned).not.toContain('fd00::1234:1');
    expect(cleaned).not.toContain('fe80::abcd:1');
    expect(cleaned).toContain('[REDACTED_IPV6]');

    const obj = sanitizeDiagnosticPayload({
      accessToken: 'secret-token',
      nested: {
        refreshToken: 'secret-refresh',
        host: '192.168.1.99',
      },
    }) as { accessToken: string; nested: { refreshToken: string; host: string } };
    expect(obj.accessToken).toBe('[REDACTED]');
    expect(obj.nested.refreshToken).toBe('[REDACTED]');
    expect(obj.nested.host).toBe('192.0.2.10');
  });

  it('builds strict webPreferences, CSP, navigation guard, and HTTPS-only external check', () => {
    const prefs = createSecureWebPreferences('C:\\app\\preload.js');
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.allowRunningInsecureContent).toBe(false);

    const csp = buildDesktopCspHeader('http://127.0.0.1:3005');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain('connect-src \'self\' http://127.0.0.1:3005 ws://127.0.0.1:3005');
    expect(csp).toContain("frame-ancestors 'none'");

    const allowedOrigins = ['http://127.0.0.1:3005'];
    expect(isAllowedInAppNavigationUrl('http://127.0.0.1:3005/presets', allowedOrigins)).toBe(true);
    expect(isAllowedInAppNavigationUrl('https://evil.example/phish', allowedOrigins)).toBe(false);
    expect(isAllowedInAppNavigationUrl('file:///C:/Windows/win.ini', allowedOrigins)).toBe(false);
    expect(isAllowedInAppNavigationUrl('http://user:pass@127.0.0.1:3005/', allowedOrigins)).toBe(
      false,
    );

    expect(isAllowedExternalUrl('https://mgcontrol.app/changelog')).toBe(true);
    expect(isAllowedExternalUrl('http://mgcontrol.app/changelog')).toBe(false);
    expect(isAllowedExternalUrl('file:///C:/test.txt')).toBe(false);
    expect(isAllowedExternalUrl('https://user:pass@mgcontrol.app/')).toBe(false);
  });

  it('keeps preload restricted exclusively to closed IPC_CHANNELS_V1 contract', () => {
    const preloadSource = fs.readFileSync(
      path.resolve(__dirname, '../preload.ts'),
      'utf8',
    );
    expect(preloadSource).not.toMatch(/ipcRenderer\.(?:on|send|sendSync|addListener)/);
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('mgControl'");
    const invokedChannels = [...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(invokedChannels.sort()).toEqual([...IPC_CHANNELS_V1].sort());
  });
});

describe('DPAPI store and typed IPC router', () => {
  it('stores encrypted auth session and persistent device identity safely', () => {
    const dataDir = makeTempDir('mg-dpapi-');
    const sessionFile = path.join(dataDir, 'auth-session.dpapi.json');
    const deviceFile = path.join(dataDir, 'device-identity.json');
    const store = new DpapiSessionStore({
      sessionFilePath: sessionFile,
      deviceIdentityPath: deviceFile,
      safeStorage: createFakeSafeStorage(true),
    });

    expect(store.getSession()).toBeNull();
    store.setSession(SAMPLE_SESSION);

    const diskContent = fs.readFileSync(sessionFile, 'utf8');
    expect(diskContent).not.toContain(SAMPLE_SESSION.tokens.accessToken);
    expect(diskContent).not.toContain(SAMPLE_SESSION.tokens.refreshToken);
    expect(store.getSession()).toEqual(SAMPLE_SESSION);

    const id1 = store.getOrCreateDeviceIdentity();
    const id2 = store.getOrCreateDeviceIdentity();
    expect(id1.deviceKeyId).toBe(id2.deviceKeyId);
    expect(id1.platform).toBe('win32');
    expect(id1.dpapiAvailable).toBe(true);

    store.clearSession();
    expect(store.getSession()).toBeNull();

    const unavailableStore = new DpapiSessionStore({
      sessionFilePath: sessionFile,
      deviceIdentityPath: deviceFile,
      safeStorage: createFakeSafeStorage(false),
    });
    expect(() => unavailableStore.setSession(SAMPLE_SESSION)).toThrow(/DPAPI/i);
  });

  it('registers all 10 IPC_CHANNELS_V1 and enforces sender origin validation', async () => {
    const dataDir = makeTempDir('mg-ipc-');
    const paths = resolveDesktopPaths({ isPackaged: false, userDataDir: dataDir });
    const sessionStore = new DpapiSessionStore({
      sessionFilePath: paths.dpapiSessionPath,
      deviceIdentityPath: paths.deviceIdentityPath,
      safeStorage: createFakeSafeStorage(true),
    });

    const coreStatus: LocalCoreStatusV1 = {
      status: 'running',
      port: 3001,
      baseUrl: 'http://127.0.0.1:3001',
      lanUrls: ['http://192.168.1.50:3001'],
      restartCount: 0,
      lastError: null,
    };
    let currentCoreStatus: LocalCoreStatusV1 = coreStatus;

    const openedUrls: string[] = [];
    const handlers = createIpcHandlers({
      paths,
      appVersion: '1.0.0',
      supervisor: {
        getStatus: () => currentCoreStatus,
        restart: async () => {
          currentCoreStatus = {
            ...coreStatus,
            status: 'running',
            restartCount: currentCoreStatus.restartCount + 1,
          };
          return currentCoreStatus;
        },
        exportDiagnostics: () => ({
          exportedPath: path.join(paths.diagnosticsDir, 'diag.json'),
          includedFiles: ['desktop-main.log'],
          sanitized: true,
          exportedAt: '2026-11-28T00:00:00.000Z',
        }),
      },
      sessionStore,
      openExternalUrl: async (url) => {
        openedUrls.push(url);
      },
    });

    const registered = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
    const unregister = registerTypedIpcHandlers(
      {
        handle: (channel, listener) => {
          registered.set(channel, listener as (event: unknown, payload?: unknown) => Promise<unknown>);
        },
        removeHandler: (channel) => {
          registered.delete(channel);
        },
      },
      handlers,
      () => ['http://127.0.0.1:3001'],
      (event) => Boolean((event as { isMainFrame?: boolean }).isMainFrame !== false),
    );

    expect([...registered.keys()].sort()).toEqual([...IPC_CHANNELS_V1].sort());

    const trustedEvent = {
      isMainFrame: true,
      senderFrame: { url: 'http://127.0.0.1:3001/' },
      sender: { getURL: () => 'http://127.0.0.1:3001/' },
    };
    const untrustedEvent = {
      isMainFrame: true,
      senderFrame: { url: 'https://malicious.example/' },
      sender: { getURL: () => 'https://malicious.example/' },
    };

    await expect(registered.get('mg:v1:app:get-info')!(untrustedEvent)).rejects.toThrow(
      /não autorizada/i,
    );
    await expect(
      registered.get('mg:v1:app:get-info')!({
        isMainFrame: true,
        senderFrame: null,
        sender: { getURL: () => 'http://127.0.0.1:3001/' },
      }),
    ).rejects.toThrow(/não autorizada/i);
    await expect(
      registered.get('mg:v1:app:get-info')!({
        isMainFrame: false,
        senderFrame: { url: 'http://127.0.0.1:3001/' },
        sender: { getURL: () => 'http://127.0.0.1:3001/' },
      }),
    ).rejects.toThrow(/não autorizado/i);

    const appInfo = (await registered.get('mg:v1:app:get-info')!(trustedEvent)) as {
      appName: string;
      contractVersion: string;
    };
    expect(appInfo.appName).toBe('MG Control');
    expect(appInfo.contractVersion).toBe(CONTRACT_VERSION_V1);

    await expect(
      registered.get('mg:v1:external:open-url')!(trustedEvent, { url: 'http://insecure.example' }),
    ).rejects.toThrow();

    const openRes = await registered.get('mg:v1:external:open-url')!(trustedEvent, {
      url: 'https://mgcontrol.app/support',
    });
    expect(openRes).toEqual({ opened: true });
    expect(openedUrls).toEqual(['https://mgcontrol.app/support']);

    await registered.get('mg:v1:auth:set-session')!(trustedEvent, SAMPLE_SESSION);
    expect(await registered.get('mg:v1:auth:get-session')!(trustedEvent)).toEqual(SAMPLE_SESSION);
    expect(await registered.get('mg:v1:auth:clear-session')!(trustedEvent)).toEqual({ ok: true });
    expect(await registered.get('mg:v1:auth:get-session')!(trustedEvent)).toBeNull();

    const diag = (await registered.get('mg:v1:diagnostics:export')!(trustedEvent)) as {
      sanitized: boolean;
    };
    expect(diag.sanitized).toBe(true);

    const updateRes = (await registered.get('mg:v1:update:check')!(trustedEvent)) as {
      updateAvailable: boolean;
    };
    expect(updateRes.updateAvailable).toBe(false);

    const devId = (await registered.get('mg:v1:device:get-identity')!(trustedEvent)) as {
      platform: string;
    };
    expect(devId.platform).toBe('win32');

    const restarted = (await registered.get('mg:v1:core:restart')!(trustedEvent)) as {
      restartCount: number;
    };
    expect(restarted.restartCount).toBe(1);

    // Recovery & diagnostics IPCs must stay callable when Local Core is degraded (baseUrl === null)
    currentCoreStatus = {
      status: 'degraded',
      port: null,
      baseUrl: null,
      lanUrls: [],
      restartCount: 3,
      lastError: 'Core offline simulado',
    };
    const degradedStatus = (await registered.get('mg:v1:core:get-status')!(
      trustedEvent,
    )) as LocalCoreStatusV1;
    expect(degradedStatus.status).toBe('degraded');
    expect(degradedStatus.baseUrl).toBeNull();

    const degradedDiag = (await registered.get('mg:v1:diagnostics:export')!(trustedEvent)) as {
      sanitized: boolean;
    };
    expect(degradedDiag.sanitized).toBe(true);

    const recoveredFromDegraded = (await registered.get('mg:v1:core:restart')!(
      trustedEvent,
    )) as LocalCoreStatusV1;
    expect(recoveredFromDegraded.status).toBe('running');
    expect(recoveredFromDegraded.restartCount).toBe(4);

    unregister();
    expect(registered.size).toBe(0);
    vi.restoreAllMocks();
  });
});
