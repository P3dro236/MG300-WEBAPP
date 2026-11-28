import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, _electron as electron, type ElectronApplication, expect, test } from '@playwright/test';
import { buildNuxPresetBinary } from '../packages/quicktone-reader/src/index.js';

const require = createRequire(import.meta.url);
const electronExecutablePath = require('electron') as string;
const desktopMainJsPath = path.resolve(process.cwd(), 'packages/desktop/dist/main.js');

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Falha ao alocar porta livre.')));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLatestCorePid(desktopLogPath: string): number | null {
  if (!fs.existsSync(desktopLogPath)) {
    return null;
  }
  const content = fs.readFileSync(desktopLogPath, 'utf8');
  const matches = [...content.matchAll(/\(PID (\d+), LAN:/g)];
  if (matches.length === 0) {
    return null;
  }
  return Number(matches[matches.length - 1][1]);
}

async function waitForPredicate(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout (${timeoutMs}ms) aguardando condição E2E Electron.`);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function isHealthReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function createTempPresetDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-electron-presets-'));
  fs.writeFileSync(
    path.join(dir, '01_EaglesDF Crunch.nuxpreset'),
    buildNuxPresetBinary({
      name: 'EaglesDF Crunch',
      slotIndex: 0,
      patchVolume: 50,
      irVolume: 23,
      formatVersion: 'v1',
    }),
  );
  fs.writeFileSync(
    path.join(dir, '02_SCORPIONS.nuxpreset'),
    buildNuxPresetBinary({
      name: 'SCORPIONS',
      slotIndex: 1,
      patchVolume: 68,
      irVolume: 30,
      formatVersion: 'v1',
    }),
  );
  return dir;
}

function buildIsolatedElectronEnv(userDataDir: string, port: number): Record<string, string> {
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      typeof v === 'string' &&
      !k.startsWith('ELECTRON_RUN_AS_NODE') &&
      k !== 'VITEST' &&
      !(k === 'NODE_ENV' && v === 'test')
    ) {
      cleanEnv[k] = v;
    }
  }
  return {
    ...cleanEnv,
    MG_DATA_DIR: userDataDir,
    MG_PORT: String(port),
    QUICKTONE_MIDI_ADAPTER: 'mock',
    MG_ALLOW_PACKAGED_MOCK: '1',
    QUICKTONE_EXPERIMENTAL_EDIT: '0',
    MG_HEADLESS_EXIT_ON_BOOT_ERROR: '1',
  };
}

test.describe('MG Control Desktop Electron Shell — E2E', () => {
  const dirsToCleanup: string[] = [];
  const activeApps: ElectronApplication[] = [];

  async function launchManagedElectron(userDataDir: string, port: number): Promise<ElectronApplication> {
    const app = await electron.launch({
      executablePath: electronExecutablePath,
      args: [desktopMainJsPath],
      env: buildIsolatedElectronEnv(userDataDir, port),
    });
    activeApps.push(app);
    return app;
  }

  async function closeManagedElectron(app: ElectronApplication): Promise<void> {
    const idx = activeApps.indexOf(app);
    if (idx !== -1) {
      activeApps.splice(idx, 1);
    }
    await app.close();
  }

  test.afterEach(async () => {
    for (const app of activeApps.splice(0)) {
      await app.close().catch(() => undefined);
    }
    for (const dir of dirsToCleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });

  test('1. Lifecycle completo, persistência em MG_DATA_DIR entre reinícios e encerramento sem PID órfão', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-electron-data-'));
    dirsToCleanup.push(userDataDir);

    const port1 = await allocateFreePort();
    const app1 = await launchManagedElectron(userDataDir, port1);

    const pageErrors1: string[] = [];
    const window1 = await app1.firstWindow();
    window1.on('pageerror', (err) => pageErrors1.push(err.message));

    await expect(window1.getByTestId('top-bar')).toBeVisible({ timeout: 20_000 });
    await expect(window1.getByTestId('midi-connection-badge')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(window1.getByTestId('midi-connection-badge')).toHaveAttribute(
      'data-midi-mode',
      'mock',
    );
    await expect(window1.getByTestId('midi-connection-badge')).toContainText('MOCK');
    await expect(window1.getByTestId('midi-connection-badge')).not.toContainText(
      'MG-300 Conectada',
    );
    await expect(window1.getByTestId('ws-connection-badge')).toHaveAttribute(
      'data-ws-status',
      'connected',
    );

    const status1 = await window1.evaluate(() => window.mgControl?.getCoreStatus());
    expect(status1).toBeTruthy();
    expect(status1!.status).toBe('running');
    expect(status1!.baseUrl).toBe(`http://127.0.0.1:${port1}`);

    const health1 = await fetch(`${status1!.baseUrl}/api/health`);
    expect(health1.status).toBe(200);

    await window1.getByTestId('volume-increase-btn').click();
    await expect(window1.getByTestId('volume-value')).toHaveText('55%');

    const devId1 = await window1.evaluate(() => window.mgControl?.getDeviceIdentity());
    expect(devId1).toBeTruthy();

    const sampleSession = {
      account: {
        userId: '22222222-2222-4222-8222-222222222222',
        email: 'electron-e2e@mgcontrol.app',
        emailVerified: true,
        locale: 'pt-BR' as const,
        createdAt: '2026-11-28T00:00:00.000Z',
      },
      tokens: {
        accessToken: 'a'.repeat(32),
        accessExpiresInSeconds: 900,
        refreshToken: 'r'.repeat(40),
        refreshExpiresAt: '2026-12-28T00:00:00.000Z',
      },
    };
    if (devId1?.dpapiAvailable) {
      await window1.evaluate(async (session) => {
        await window.mgControl?.setAuthSession(session);
      }, sampleSession);
    }

    await window1.evaluate(() => {
      window.localStorage.setItem('mg_s03_persistence_probe', 'persisted-value-v1');
    });

    const desktopLogPath = path.join(userDataDir, 'logs', 'desktop-main.log');
    const midiLogPath = path.join(userDataDir, 'logs', 'midi-diagnostics.log');
    expect(fs.existsSync(desktopLogPath)).toBe(true);
    expect(fs.existsSync(midiLogPath)).toBe(true);

    const corePid1 = readLatestCorePid(desktopLogPath);
    expect(corePid1).not.toBeNull();
    expect(isPidRunning(corePid1!)).toBe(true);

    await closeManagedElectron(app1);
    expect(pageErrors1).toEqual([]);

    await waitForPredicate(
      async () =>
        !isPidRunning(corePid1!) &&
        !(await isHealthReachable(status1!.baseUrl!)) &&
        (await isPortFree(port1)),
    );
    expect(isPidRunning(corePid1!)).toBe(false);
    expect(await isHealthReachable(status1!.baseUrl!)).toBe(false);

    // Reabre o app na mesma porta e mesmo userDataDir e confirma persistência local + DPAPI
    const app2 = await launchManagedElectron(userDataDir, port1);

    const window2 = await app2.firstWindow();
    await expect(window2.getByTestId('top-bar')).toBeVisible({ timeout: 20_000 });

    const status2 = await window2.evaluate(() => window.mgControl?.getCoreStatus());
    expect(status2?.port).toBe(port1);

    const devId2 = await window2.evaluate(() => window.mgControl?.getDeviceIdentity());
    expect(devId2?.deviceKeyId).toBe(devId1?.deviceKeyId);

    const persistedProbe = await window2.evaluate(() =>
      window.localStorage.getItem('mg_s03_persistence_probe'),
    );
    expect(persistedProbe).toBe('persisted-value-v1');

    if (devId1?.dpapiAvailable) {
      const restoredSession = await window2.evaluate(() => window.mgControl?.getAuthSession());
      expect(restoredSession).toEqual(sampleSession);
      const cleared = await window2.evaluate(() => window.mgControl?.clearAuthSession());
      expect(cleared).toEqual({ ok: true });
      const afterClear = await window2.evaluate(() => window.mgControl?.getAuthSession());
      expect(afterClear).toBeNull();
    }

    const corePid2 = readLatestCorePid(desktopLogPath);
    expect(corePid2).not.toBeNull();
    expect(corePid2).not.toBe(corePid1);

    await closeManagedElectron(app2);
    await waitForPredicate(() => !isPidRunning(corePid2!));
    expect(isPidRunning(corePid2!)).toBe(false);
  });

  test('2. Isolamento de segurança, preload restrito, CSP, bloqueio de navegação e fluxos offline (presets/volume/QR)', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-electron-sec-'));
    const presetsDir = createTempPresetDir();
    dirsToCleanup.push(userDataDir, presetsDir);

    const port = await allocateFreePort();
    const electronApp = await launchManagedElectron(userDataDir, port);

    const mainWindow = await electronApp.firstWindow();
    await expect(mainWindow.getByTestId('top-bar')).toBeVisible({ timeout: 20_000 });

    // Isolamento de contexto, allowlist estrita em window.mgControl e CSP ativa no Chromium
    const isolationReport = await mainWindow.evaluate(
      () =>
        new Promise<{
          hasRequire: boolean;
          hasProcess: boolean;
          hasIpcRenderer: boolean;
          hasBuffer: boolean;
          hasBridge: boolean;
          isFrozen: boolean;
          bridgeKeys: string[];
          contractVersion: string | null;
          cspBlockedInlineScript: boolean;
          inlineExecuted: boolean;
          violatedDirective: string | null;
        }>((resolve) => {
          const win = window as unknown as Record<string, unknown>;
          const bridge = window.mgControl;
          let violatedDirective: string | null = null;

          const finish = (cspBlockedInlineScript: boolean) => {
            resolve({
              hasRequire: typeof win.require !== 'undefined',
              hasProcess: typeof win.process !== 'undefined',
              hasIpcRenderer: typeof win.ipcRenderer !== 'undefined',
              hasBuffer: typeof win.Buffer !== 'undefined',
              hasBridge: Boolean(bridge),
              isFrozen: bridge ? Object.isFrozen(bridge) : false,
              bridgeKeys: bridge ? Object.keys(bridge).sort() : [],
              contractVersion: bridge?.contractVersion ?? null,
              cspBlockedInlineScript,
              inlineExecuted: win.__mgCspInlineRan === true,
              violatedDirective,
            });
          };

          const onViolation = (ev: SecurityPolicyViolationEvent) => {
            violatedDirective = ev.effectiveDirective || ev.violatedDirective;
            window.removeEventListener('securitypolicyviolation', onViolation);
            finish(true);
          };
          window.addEventListener('securitypolicyviolation', onViolation);

          const script = document.createElement('script');
          script.textContent = 'window.__mgCspInlineRan = true;';
          document.head.appendChild(script);
          script.remove();

          setTimeout(() => {
            window.removeEventListener('securitypolicyviolation', onViolation);
            finish(false);
          }, 300);
        }),
    );

    expect(isolationReport.hasRequire).toBe(false);
    expect(isolationReport.hasProcess).toBe(false);
    expect(isolationReport.hasIpcRenderer).toBe(false);
    expect(isolationReport.hasBuffer).toBe(false);
    expect(isolationReport.hasBridge).toBe(true);
    expect(isolationReport.isFrozen).toBe(true);
    expect(isolationReport.contractVersion).toBe('1.0');
    expect(isolationReport.cspBlockedInlineScript).toBe(true);
    expect(isolationReport.inlineExecuted).toBe(false);
    expect(isolationReport.violatedDirective).toMatch(/^script-src/);
    expect(isolationReport.bridgeKeys).toEqual([
      'checkForUpdates',
      'clearAuthSession',
      'contractVersion',
      'exportDiagnostics',
      'getAppInfo',
      'getAuthSession',
      'getCoreStatus',
      'getDeviceIdentity',
      'openExternalUrl',
      'restartCore',
      'setAuthSession',
    ]);

    const appInfo = await mainWindow.evaluate(() => window.mgControl!.getAppInfo());
    expect(appInfo.appName).toBe('MG Control');
    expect(appInfo.platform).toBe('win32');
    expect(appInfo.arch).toBe('x64');

    const insecureOpenRejected = await mainWindow.evaluate(async () => {
      try {
        await window.mgControl!.openExternalUrl('http://insecure.example/test');
        return false;
      } catch {
        return true;
      }
    });
    expect(insecureOpenRejected).toBe(true);

    const diagResult = await mainWindow.evaluate(() => window.mgControl!.exportDiagnostics());
    expect(diagResult.sanitized).toBe(true);
    expect(fs.existsSync(diagResult.exportedPath)).toBe(true);

    const coreStatus = await mainWindow.evaluate(() => window.mgControl!.getCoreStatus());
    const baseUrl = coreStatus.baseUrl!;

    // Regressão funcional offline dentro do Electron: presets, volume e pareamento LAN via QR Code
    const cfgRes = await fetch(`${baseUrl}/api/presets/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directoryPath: presetsDir, includeFactoryPresets: true }),
    });
    expect(cfgRes.status).toBe(200);

    await expect(mainWindow.getByTestId('preset-card-1A')).toBeVisible({ timeout: 10_000 });
    await expect(mainWindow.getByTestId('preset-name-1A')).toHaveText('EaglesDF Crunch');
    await mainWindow.getByTestId('preset-card-1B').click();
    await expect(mainWindow.getByTestId('preset-card-1B')).toHaveAttribute(
      'data-status',
      'command_sent_unconfirmed',
    );

    await mainWindow.getByTestId('filter-tab-factory').click();
    await expect(mainWindow.getByTestId('preset-card-F1A')).toBeVisible();
    await mainWindow.getByTestId('filter-tab-user').click();

    await mainWindow.getByTestId('volume-increase-btn').click();
    await expect(mainWindow.getByTestId('volume-value')).toHaveText('55%');

    await mainWindow.getByTestId('open-settings-btn').click();
    await expect(mainWindow.getByTestId('settings-modal')).toBeVisible();
    await expect(mainWindow.getByTestId('lan-firewall-help')).toBeVisible();
    await mainWindow.getByTestId('lan-firewall-help').locator('summary').click();
    await expect(mainWindow.getByTestId('lan-firewall-help')).toHaveAttribute('open', '');
    await mainWindow.getByTestId('export-diagnostics-btn').click();
    await expect(mainWindow.getByTestId('diagnostics-export-result')).toBeVisible();
    await mainWindow.getByTestId('generate-pairing-qr-btn').click();
    await expect(mainWindow.getByTestId('lan-qr-card')).toBeVisible();
    await expect(mainWindow.getByTestId('pairing-challenge-box')).toBeVisible();
    await expect(mainWindow.getByTestId('lan-qr-svg')).toBeVisible();
    await mainWindow.getByTestId('close-settings-btn').click();

    // Bloqueia navegação externa e popups indesejados sem abrir nova janela
    await mainWindow.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://evil.example/phish';
      link.textContent = 'blocked-nav';
      document.body.appendChild(link);
      link.click();
      window.open('http://evil.example/popup', '_blank');
    });
    await mainWindow.waitForTimeout(300);
    expect(mainWindow.url().startsWith(baseUrl)).toBe(true);
    expect(electronApp.windows()).toHaveLength(1);

    const corePid = readLatestCorePid(path.join(userDataDir, 'logs', 'desktop-main.log'));
    await closeManagedElectron(electronApp);
    if (corePid !== null) {
      await waitForPredicate(() => !isPidRunning(corePid));
    }
  });

  test('3. Bloqueio de segunda instância mantém processo único e preserva estado do Local Core', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-electron-single-'));
    dirsToCleanup.push(userDataDir);

    const port = await allocateFreePort();
    const primaryApp = await launchManagedElectron(userDataDir, port);
    const mainWindow = await primaryApp.firstWindow();
    await expect(mainWindow.getByTestId('top-bar')).toBeVisible({ timeout: 20_000 });

    const desktopLogPath = path.join(userDataDir, 'logs', 'desktop-main.log');
    const primaryPid = readLatestCorePid(desktopLogPath);
    expect(primaryPid).not.toBeNull();

    const secondExitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(electronExecutablePath, [desktopMainJsPath], {
        env: buildIsolatedElectronEnv(userDataDir, port),
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Segunda instância não encerrou dentro do limite esperado.'));
      }, 10_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(secondExitCode).toBe(0);
    expect(primaryApp.windows()).toHaveLength(1);

    const logContent = fs.readFileSync(desktopLogPath, 'utf8');
    const onlineMatches = [...logContent.matchAll(/Local Core online em/g)];
    expect(onlineMatches).toHaveLength(1);

    await closeManagedElectron(primaryApp);
    await waitForPredicate(() => !isPidRunning(primaryPid!));
    expect(isPidRunning(primaryPid!)).toBe(false);
  });

  test('4. Sincronização LAN em tempo real entre navegador mobile pareado e app Electron', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-electron-lan-'));
    const presetsDir = createTempPresetDir();
    dirsToCleanup.push(userDataDir, presetsDir);

    const port = await allocateFreePort();
    const electronApp = await launchManagedElectron(userDataDir, port);
    const mainWindow = await electronApp.firstWindow();
    await expect(mainWindow.getByTestId('top-bar')).toBeVisible({ timeout: 20_000 });

    const coreStatus = await mainWindow.evaluate(() => window.mgControl!.getCoreStatus());
    const baseUrl = coreStatus.baseUrl!;

    const cfgRes = await fetch(`${baseUrl}/api/presets/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directoryPath: presetsDir, includeFactoryPresets: true }),
    });
    expect(cfgRes.status).toBe(200);

    await mainWindow.getByTestId('open-settings-btn').click();
    await mainWindow.getByTestId('generate-pairing-qr-btn').click();
    await expect(mainWindow.getByTestId('pairing-challenge-box')).toBeVisible();

    const pairingStatusRes = await fetch(`${baseUrl}/api/pairing/status`);
    const pairingStatus = (await pairingStatusRes.json()) as {
      activeChallenge: { pairingCode: string } | null;
    };
    const pairingCode = pairingStatus.activeChallenge?.pairingCode;
    expect(pairingCode).toBeTruthy();

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        extraHTTPHeaders: { 'x-forwarded-for': '192.168.1.91' },
      });
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(`${baseUrl}/?pair=${encodeURIComponent(pairingCode!)}`);
      await expect(mobilePage.getByTestId('pairing-waiting-approval')).toBeVisible({
        timeout: 15_000,
      });

      const approveBtn = mainWindow
        .getByTestId('settings-modal')
        .getByRole('button', { name: 'Autorizar' })
        .first();
      await expect(approveBtn).toBeVisible({ timeout: 10_000 });
      await approveBtn.click();
      await mainWindow.getByTestId('close-settings-btn').click();

      await expect(mobilePage.getByTestId('volume-increase-btn')).toBeVisible({ timeout: 15_000 });
      await mobilePage.getByTestId('volume-increase-btn').click();
      await expect(mainWindow.getByTestId('volume-value')).toHaveText('55%');

      await mobilePage.getByTestId('preset-card-1B').click();
      await expect(mainWindow.getByTestId('preset-card-1B')).toHaveAttribute(
        'data-status',
        'command_sent_unconfirmed',
      );
      await mobileContext.close();
    } finally {
      await browser.close();
    }

    const corePid = readLatestCorePid(path.join(userDataDir, 'logs', 'desktop-main.log'));
    await closeManagedElectron(electronApp);
    if (corePid !== null) {
      await waitForPredicate(() => !isPidRunning(corePid));
    }
  });
});
