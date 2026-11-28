import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(desktopRoot, 'release');
const unpackedDir = path.join(releaseDir, 'win-unpacked');
const unpackedExe = path.join(unpackedDir, 'MG Control.exe');

async function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

const installers = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).filter((file) => file.endsWith('.exe'))
  : [];
assert.ok(installers.length > 0, `Nenhum instalador .exe encontrado em ${releaseDir}`);
for (const installer of installers) {
  assert.ok(fs.statSync(path.join(releaseDir, installer)).size > 0, `Instalador vazio: ${installer}`);
}

const requiredFiles = [
  unpackedExe,
  path.join(unpackedDir, 'resources', 'core', 'local-core.cjs'),
  path.join(unpackedDir, 'resources', 'frontend', 'index.html'),
  path.join(unpackedDir, 'resources', 'app.asar'),
];
for (const filePath of requiredFiles) {
  assert.ok(fs.existsSync(filePath), `Artefato obrigatório ausente: ${filePath}`);
  assert.ok(fs.statSync(filePath).size > 0, `Artefato obrigatório vazio: ${filePath}`);
}

const frontendMapFiles = walkFiles(path.join(unpackedDir, 'resources', 'frontend')).filter((file) =>
  file.endsWith('.map'),
);
assert.equal(frontendMapFiles.length, 0, `Arquivos .map encontrados no pacote: ${frontendMapFiles.join(', ')}`);

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-packaged-smoke-'));
const cleanEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string' && !key.startsWith('ELECTRON_RUN_AS_NODE') && key !== 'VITEST') {
    cleanEnv[key] = value;
  }
}

let launchedApp = null;
try {
  const port = await allocateFreePort();
  launchedApp = await electron.launch({
    executablePath: unpackedExe,
    env: {
      ...cleanEnv,
      MG_DATA_DIR: tempUserData,
      MG_PORT: String(port),
      QUICKTONE_MIDI_ADAPTER: 'mock',
      QUICKTONE_EXPERIMENTAL_EDIT: '0',
      MG_HEADLESS_EXIT_ON_BOOT_ERROR: '1',
    },
  });

  const mainWindow = await launchedApp.firstWindow();
  await mainWindow.getByTestId('top-bar').waitFor({ state: 'visible', timeout: 20_000 });

  const appInfo = await mainWindow.evaluate(() => window.mgControl?.getAppInfo());
  assert.ok(appInfo, 'window.mgControl.getAppInfo() indisponível no binário empacotado');
  assert.equal(appInfo.isPackaged, true);
  assert.equal(appInfo.appName, 'MG Control');
  assert.equal(appInfo.platform, 'win32');
  assert.equal(appInfo.arch, 'x64');

  const coreStatus = await mainWindow.evaluate(() => window.mgControl?.getCoreStatus());
  assert.ok(coreStatus, 'window.mgControl.getCoreStatus() indisponível');
  assert.equal(coreStatus.status, 'running');
  assert.equal(coreStatus.port, port);

  const healthRes = await fetch(`${coreStatus.baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);

  const logContent = fs.readFileSync(path.join(tempUserData, 'logs', 'desktop-main.log'), 'utf8');
  const pidMatches = [...logContent.matchAll(/\(PID (\d+), LAN:/g)];
  assert.ok(pidMatches.length > 0, 'PID do Local Core não registrado no desktop-main.log');
  const corePid = Number(pidMatches[pidMatches.length - 1][1]);

  await launchedApp.close();
  launchedApp = null;

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidRunning(corePid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isPidRunning(corePid), false, `PID órfão detectado após fechar executável: ${corePid}`);
  console.log(
    `[smoke-packaged] PASS: ${unpackedExe} (isPackaged=true, installer=${installers[0]}, zero .map, zero orphan PID)`,
  );
} finally {
  if (launchedApp) {
    await launchedApp.close().catch(() => undefined);
  }
  fs.rmSync(tempUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
