import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LocalCoreSupervisor } from '../core-supervisor.js';
import { ensureDesktopDirectories, resolveDesktopPaths } from '../paths.js';

let bundleTempDir = '';
let builtCoreBundlePath = '';
let mockStaticDir = '';
const activeSupervisors: LocalCoreSupervisor[] = [];
const tempDirs: string[] = [];

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for supervisor condition.`);
}

beforeAll(async () => {
  bundleTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-core-bundle-'));
  builtCoreBundlePath = path.join(bundleTempDir, 'local-core.cjs');
  mockStaticDir = path.join(bundleTempDir, 'static');
  fs.mkdirSync(mockStaticDir, { recursive: true });
  fs.writeFileSync(
    path.join(mockStaticDir, 'index.html'),
    '<!doctype html><html><body>MG Control Shell Test</body></html>',
    'utf8',
  );

  const backendEntry = path.resolve(__dirname, '../../../backend/src/index.ts');
  await esbuild.build({
    entryPoints: [backendEntry],
    outfile: builtCoreBundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    banner: {
      js: "var __mgImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    },
    define: {
      'import.meta.url': '__mgImportMetaUrl',
    },
  });
}, 30_000);

afterEach(async () => {
  for (const supervisor of activeSupervisors.splice(0)) {
    await supervisor.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (bundleTempDir) {
    fs.rmSync(bundleTempDir, { recursive: true, force: true });
  }
});

describe('LocalCoreSupervisor real process lifecycle', () => {
  it('starts local-core.cjs with isolated MG_DATA_DIR, persists data, and shuts down without orphan PID', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sup-data-'));
    tempDirs.push(userDataDir);

    const paths = resolveDesktopPaths({
      isPackaged: false,
      userDataDir,
      coreEntryPath: builtCoreBundlePath,
      staticDir: mockStaticDir,
    });
    ensureDesktopDirectories(paths);

    const repoMidiLogPath = path.resolve(__dirname, '../../../../logs/midi-diagnostics.log');
    const repoMidiLogBefore = fs.existsSync(repoMidiLogPath)
      ? fs.statSync(repoMidiLogPath).mtimeMs
      : null;

    const supervisor = new LocalCoreSupervisor({
      paths,
      appVersion: '1.0.0',
      preferredPort: 3201,
      healthCheckIntervalMs: 60_000,
      extraEnv: {
        VITEST: '',
        NODE_ENV: 'production',
        QUICKTONE_MIDI_ADAPTER: 'mock',
        QUICKTONE_EXPERIMENTAL_EDIT: '0',
      },
    });
    activeSupervisors.push(supervisor);

    const status = await supervisor.start();
    const corePid = supervisor.getCorePid();
    expect(status.status).toBe('running');
    expect(status.port).toBe(3201);
    expect(status.baseUrl).toBe('http://127.0.0.1:3201');
    expect(corePid).toBeTypeOf('number');
    expect(isPidRunning(corePid!)).toBe(true);

    const healthRes = await fetch(`${status.baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string };
    expect(healthJson.status).toBe('ok');

    const volRes = await fetch(`${status.baseUrl}/api/volume`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: 55 }),
    });
    expect(volRes.status).toBe(200);

    // Verify MIDI diagnostics log resolves inside MG_DATA_DIR instead of repo root
    expect(fs.existsSync(paths.midiLogFilePath)).toBe(true);
    const repoMidiLogAfter = fs.existsSync(repoMidiLogPath)
      ? fs.statSync(repoMidiLogPath).mtimeMs
      : null;
    expect(repoMidiLogAfter).toBe(repoMidiLogBefore);

    // Export sanitized diagnostics report
    const diag = supervisor.exportDiagnostics();
    expect(diag.sanitized).toBe(true);
    expect(fs.existsSync(diag.exportedPath)).toBe(true);

    // Clean stop terminates child process cleanly with zero orphan PID
    await supervisor.stop();
    expect(supervisor.getStatus().status).toBe('stopped');
    expect(supervisor.getCorePid()).toBeNull();
    await waitForCondition(() => !isPidRunning(corePid!), 5_000);
    expect(isPidRunning(corePid!)).toBe(false);
  }, 25_000);

  it('falls back cleanly when preferred port is occupied and auto-recovers after unexpected crash', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sup-fallback-'));
    tempDirs.push(userDataDir);

    const occupiedServer = net.createServer();
    await new Promise<void>((resolve) => {
      occupiedServer.listen(0, '0.0.0.0', () => resolve());
    });
    const occupiedPort = (occupiedServer.address() as net.AddressInfo).port;

    try {
      const paths = resolveDesktopPaths({
        isPackaged: false,
        userDataDir,
        coreEntryPath: builtCoreBundlePath,
        staticDir: mockStaticDir,
      });
      ensureDesktopDirectories(paths);

      const supervisor = new LocalCoreSupervisor({
        paths,
        appVersion: '1.0.0',
        preferredPort: occupiedPort,
        healthCheckIntervalMs: 60_000,
        extraEnv: {
          QUICKTONE_MIDI_ADAPTER: 'mock',
          QUICKTONE_EXPERIMENTAL_EDIT: '0',
        },
      });
      activeSupervisors.push(supervisor);

      const initialStatus = await supervisor.start();
      expect(initialStatus.port).not.toBe(occupiedPort);
      expect(initialStatus.port).toBeGreaterThanOrEqual(occupiedPort + 1);
      expect(initialStatus.port).toBeLessThanOrEqual(occupiedPort + 20);

      const firstPid = supervisor.getCorePid()!;
      process.kill(firstPid, 'SIGKILL');

      await waitForCondition(() => {
        const st = supervisor.getStatus();
        const pid = supervisor.getCorePid();
        return st.status === 'running' && st.restartCount >= 1 && pid !== null && pid !== firstPid;
      }, 15_000);

      const recoveredStatus = supervisor.getStatus();
      const recoveredHealth = await fetch(`${recoveredStatus.baseUrl}/api/health`);
      expect(recoveredHealth.status).toBe(200);

      const secondPid = supervisor.getCorePid()!;
      await supervisor.stop();
      await waitForCondition(() => !isPidRunning(secondPid), 5_000);
    } finally {
      await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
    }
  }, 30_000);

  it('restarts once after 3 consecutive /api/health failures and enters degraded after 3 auto-restarts in 60s', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sup-health-'));
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sup-stub-'));
    tempDirs.push(userDataDir, scriptDir);

    const bootCountFile = path.join(scriptDir, 'boot-count.txt');
    fs.writeFileSync(bootCountFile, '0', 'utf8');
    const stubCorePath = path.join(scriptDir, 'stub-core.cjs');
    fs.writeFileSync(
      stubCorePath,
      `
const fs = require('node:fs');
const http = require('node:http');
const bootFile = ${JSON.stringify(bootCountFile)};
const bootIndex = Number(fs.readFileSync(bootFile, 'utf8')) + 1;
fs.writeFileSync(bootFile, String(bootIndex), 'utf8');

let healthCalls = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    healthCalls += 1;
    if (bootIndex === 1 && healthCalls >= 2) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'degraded' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'quicktone-web-controller',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 1,
      midiConnection: 'connected',
      syncStatus: 'confirmed',
    }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write('__MG_CORE_BOOTSTRAP__:' + JSON.stringify({
    event: 'ready',
    contractVersion: '1.0',
    host: '127.0.0.1',
    port,
    lanUrls: ['http://192.0.2.10:' + port],
    pid: process.pid,
    dataDir: process.env.MG_DATA_DIR || process.cwd(),
    startedAt: new Date().toISOString(),
  }) + '\\n');
});

const shutdown = () => server.close(() => process.exit(0));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('shutdown')) shutdown();
});
process.stdin.on('end', shutdown);
process.stdin.resume();
`,
      'utf8',
    );

    const paths = resolveDesktopPaths({
      isPackaged: false,
      userDataDir,
      coreEntryPath: stubCorePath,
      staticDir: mockStaticDir,
    });
    ensureDesktopDirectories(paths);

    const supervisor = new LocalCoreSupervisor({
      paths,
      appVersion: '1.0.0',
      preferredPort: 0,
      healthCheckIntervalMs: 80,
      maxLogBytes: 512,
    });
    activeSupervisors.push(supervisor);

    await supervisor.start();
    const firstPid = supervisor.getCorePid()!;

    // 3 health check failures on boot 1 must trigger strictly ONE restart (restartCount === 1)
    await waitForCondition(() => {
      const st = supervisor.getStatus();
      const pid = supervisor.getCorePid();
      return st.status === 'running' && st.restartCount === 1 && pid !== null && pid !== firstPid;
    }, 15_000);
    expect(supervisor.getStatus().restartCount).toBe(1);
    expect(isPidRunning(firstPid)).toBe(false);

    // Manual restart() swaps PID cleanly with zero orphan process and rotates desktop-main.log
    const pidBeforeManual = supervisor.getCorePid()!;
    const manualStatus = await supervisor.restart();
    const pidAfterManual = supervisor.getCorePid()!;
    expect(manualStatus.status).toBe('running');
    expect(manualStatus.restartCount).toBe(2);
    expect(pidAfterManual).not.toBe(pidBeforeManual);
    await waitForCondition(() => !isPidRunning(pidBeforeManual), 5_000);
    expect(fs.existsSync(`${paths.desktopLogFilePath}.prev`)).toBe(true);

    // Trigger 4 rapid unexpected crashes after clean manual restart -> caps at 3 auto-restarts in 60s then degraded
    for (let crashIndex = 0; crashIndex < 3; crashIndex += 1) {
      const targetRestartCount = 2 + crashIndex + 1;
      const pidToKill = supervisor.getCorePid()!;
      process.kill(pidToKill, 'SIGKILL');
      await waitForCondition(() => {
        const st = supervisor.getStatus();
        const pid = supervisor.getCorePid();
        return st.status === 'running' && st.restartCount === targetRestartCount && pid !== null && pid !== pidToKill;
      }, 15_000);
    }

    const finalPidBeforeDegraded = supervisor.getCorePid()!;
    process.kill(finalPidBeforeDegraded, 'SIGKILL');
    await waitForCondition(() => supervisor.getStatus().status === 'degraded', 10_000);
    expect(supervisor.getStatus().restartCount).toBe(5);
    expect(supervisor.getCorePid()).toBeNull();
    expect(supervisor.getStatus().baseUrl).toBeNull();

    await supervisor.stop();
  }, 40_000);
});
