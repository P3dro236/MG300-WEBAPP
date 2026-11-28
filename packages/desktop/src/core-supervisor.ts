import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  type DiagnosticsExportResultV1,
  DiagnosticsExportResultV1Schema,
  HealthResponseSchema,
  type LocalCoreBootstrapEventV1,
  LocalCoreBootstrapEventV1Schema,
  type LocalCoreLifecycleStateV1,
  type LocalCoreStatusV1,
  LocalCoreStatusV1Schema,
} from '@quicktone/shared';
import { type DesktopPaths, writeFileAtomicSync } from './paths.js';
import { sanitizeDiagnosticPayload, sanitizeLogText } from './sanitizer.js';

const BOOTSTRAP_PREFIX = '__MG_CORE_BOOTSTRAP__:';
const DEFAULT_MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const CRASH_WINDOW_MS = 60_000;
const MAX_AUTO_RESTARTS_IN_WINDOW = 3;

export interface LocalCoreSupervisorOptions {
  paths: DesktopPaths;
  appVersion: string;
  host?: string;
  preferredPort?: number;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  healthCheckIntervalMs?: number;
  maxLogBytes?: number;
  nodeExecutablePath?: string;
  extraEnv?: Record<string, string>;
  onStatusChange?: (status: LocalCoreStatusV1) => void;
}

type SupervisedCoreChild = ChildProcessByStdio<Writable, Readable, Readable>;

function tailSanitizedLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-maxLines).map((line) => sanitizeLogText(line));
}

function flushLinesFromBuffer(
  buffer: string,
  chunk: Buffer | string,
  onLine: (line: string) => void,
): string {
  let next = buffer + chunk.toString('utf8');
  let idx = next.indexOf('\n');
  while (idx !== -1) {
    const line = next.slice(0, idx);
    next = next.slice(idx + 1);
    onLine(line);
    idx = next.indexOf('\n');
  }
  return next;
}

export class LocalCoreSupervisor {
  private readonly paths: DesktopPaths;
  private readonly appVersion: string;
  private readonly host: string;
  private readonly preferredPort: number;
  private readonly startupTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly maxLogBytes: number;
  private readonly nodeExecutablePath: string;
  private readonly extraEnv: Record<string, string>;
  private readonly onStatusChange?: (status: LocalCoreStatusV1) => void;
  private readonly intentionallyTerminatedChildren = new WeakSet<SupervisedCoreChild>();

  private child: SupervisedCoreChild | null = null;
  private status: LocalCoreLifecycleStateV1 = 'stopped';
  private port: number | null = null;
  private baseUrl: string | null = null;
  private lanUrls: string[] = [];
  private restartCount = 0;
  private lastError: string | null = null;
  private stopping = false;
  private activeStartPromise: Promise<LocalCoreStatusV1> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthCheckInFlight = false;
  private crashTimestampsMs: number[] = [];
  private consecutiveHealthFailures = 0;

  constructor(options: LocalCoreSupervisorOptions) {
    this.paths = options.paths;
    this.appVersion = options.appVersion;
    this.host = options.host ?? '0.0.0.0';
    this.preferredPort = options.preferredPort ?? 3001;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_500;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 5_000;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_FILE_BYTES;
    this.nodeExecutablePath = options.nodeExecutablePath ?? process.execPath;
    this.extraEnv = options.extraEnv ?? {};
    this.onStatusChange = options.onStatusChange;
  }

  getCorePid(): number | null {
    return this.child?.pid ?? null;
  }

  getStatus(): LocalCoreStatusV1 {
    return LocalCoreStatusV1Schema.parse({
      status: this.status,
      port: this.port,
      baseUrl: this.baseUrl,
      lanUrls: this.lanUrls,
      restartCount: this.restartCount,
      lastError: this.lastError,
    });
  }

  logLine(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      const logPath = this.paths.desktopLogFilePath;
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      if (fs.existsSync(logPath) && fs.statSync(logPath).size >= this.maxLogBytes) {
        const rotatedPath = `${logPath}.prev`;
        fs.rmSync(rotatedPath, { force: true });
        fs.renameSync(logPath, rotatedPath);
      }
      const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${sanitizeLogText(message)}\n`;
      fs.appendFileSync(logPath, line, 'utf8');
    } catch {
      // Avoid cascading failure if diagnostics file is locked externally
    }
  }

  private emitStatus(): LocalCoreStatusV1 {
    const snapshot = this.getStatus();
    this.onStatusChange?.(snapshot);
    return snapshot;
  }

  private setStatus(next: LocalCoreLifecycleStateV1): void {
    this.status = next;
    this.emitStatus();
  }

  async start(): Promise<LocalCoreStatusV1> {
    if (this.activeStartPromise) {
      return this.activeStartPromise;
    }
    if (this.status === 'running' && this.child && this.child.exitCode === null) {
      return this.getStatus();
    }

    this.stopping = false;
    this.clearTimers();
    this.setStatus(this.restartCount > 0 ? 'restarting' : 'starting');

    const startPromise = this.spawnAndAwaitReady().finally(() => {
      if (this.activeStartPromise === startPromise) {
        this.activeStartPromise = null;
      }
    });
    this.activeStartPromise = startPromise;
    return startPromise;
  }

  async restart(): Promise<LocalCoreStatusV1> {
    this.logLine('info', 'Solicitado reinício manual do Local Core.');
    await this.stopInternal({ resetCrashWindow: true, targetFinalStatus: 'restarting' });
    this.restartCount += 1;
    return this.start();
  }

  async stop(): Promise<void> {
    this.logLine('info', 'Encerrando Local Core Supervisor.');
    await this.stopInternal({ resetCrashWindow: true, targetFinalStatus: 'stopped' });
  }

  exportDiagnostics(destinationDir?: string): DiagnosticsExportResultV1 {
    const outDir = destinationDir ? path.resolve(destinationDir) : this.paths.diagnosticsDir;
    const timestampTag = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `mg-control-diagnostics-${timestampTag}.json`);

    const includedFiles: string[] = [];
    const desktopLogs = tailSanitizedLines(this.paths.desktopLogFilePath, 400);
    if (desktopLogs.length > 0) {
      includedFiles.push('desktop-main.log');
    }
    const midiLogs = tailSanitizedLines(this.paths.midiLogFilePath, 400);
    if (midiLogs.length > 0) {
      includedFiles.push('midi-diagnostics.log');
    }

    const exportedAt = new Date().toISOString();
    const payload = sanitizeDiagnosticPayload({
      exportedAt,
      appVersion: this.appVersion,
      platform: 'win32',
      arch: 'x64',
      coreStatus: this.getStatus(),
      logs: {
        desktopMain: desktopLogs,
        midiDiagnostics: midiLogs,
      },
    });

    writeFileAtomicSync(outPath, JSON.stringify(payload, null, 2));

    return DiagnosticsExportResultV1Schema.parse({
      exportedPath: outPath,
      includedFiles,
      sanitized: true,
      exportedAt,
    });
  }

  private clearTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async spawnAndAwaitReady(): Promise<LocalCoreStatusV1> {
    if (!fs.existsSync(this.paths.coreEntryPath)) {
      const msg = `Bundle do Local Core não encontrado em ${this.paths.coreEntryPath}`;
      if (!this.stopping) {
        this.lastError = sanitizeLogText(msg);
        this.setStatus('degraded');
      }
      throw new Error(msg);
    }

    fs.mkdirSync(this.paths.dataSubDir, { recursive: true });
    fs.mkdirSync(this.paths.logsDir, { recursive: true });
    fs.mkdirSync(this.paths.backupsDir, { recursive: true });

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: this.host,
      PORT: String(this.preferredPort),
      MG_PORT: String(this.preferredPort),
      MG_ALLOW_PORT_FALLBACK: '1',
      MG_CORE_IPC_STDIN: '1',
      MG_DATA_DIR: this.paths.dataDir,
      MG_STATIC_DIR: this.paths.staticDir,
      QUICKTONE_MIDI_LOG_FILE: this.paths.midiLogFilePath,
      ...this.extraEnv,
    };

    const child = spawn(this.nodeExecutablePath, [this.paths.coreEntryPath], {
      cwd: this.paths.dataDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child = child;
    this.lastError = null;
    this.consecutiveHealthFailures = 0;

    let bootstrapEvent: LocalCoreBootstrapEventV1;
    try {
      bootstrapEvent = await this.waitForBootstrap(child);
    } catch (err) {
      await this.terminateChildProcess(child);
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopping) {
        return this.getStatus();
      }
      this.lastError = sanitizeLogText(err instanceof Error ? err.message : String(err));
      this.logLine('error', `Falha no bootstrap do Local Core: ${this.lastError}`);
      this.setStatus('degraded');
      throw err;
    }

    if (this.stopping) {
      await this.terminateChildProcess(child);
      if (this.child === child) {
        this.child = null;
      }
      return this.getStatus();
    }

    const baseUrl = `http://127.0.0.1:${bootstrapEvent.port}`;
    const healthy = await this.probeHealth(baseUrl);
    if (this.stopping) {
      await this.terminateChildProcess(child);
      if (this.child === child) {
        this.child = null;
      }
      return this.getStatus();
    }
    if (!healthy) {
      const msg = `Local Core respondeu bootstrap na porta ${bootstrapEvent.port}, mas /api/health falhou.`;
      this.lastError = msg;
      this.logLine('error', msg);
      await this.terminateChildProcess(child);
      if (this.child === child) {
        this.child = null;
      }
      this.setStatus('degraded');
      throw new Error(msg);
    }

    this.port = bootstrapEvent.port;
    this.baseUrl = baseUrl;
    this.lanUrls = bootstrapEvent.lanUrls;
    this.lastError = null;
    this.setStatus('running');
    this.logLine(
      'info',
      `Local Core online em ${baseUrl} (PID ${bootstrapEvent.pid}, LAN: ${bootstrapEvent.lanUrls.length} URL(s)).`,
    );

    this.attachRunningChildListeners(child);
    this.startHealthPolling();

    return this.getStatus();
  }

  private waitForBootstrap(child: SupervisedCoreChild): Promise<LocalCoreBootstrapEventV1> {
    return new Promise((resolve, reject) => {
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let settled = false;

      const finish = (cb: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('exit', onExitBeforeReady);
        child.off('error', onErrorBeforeReady);
        cb();
      };

      const timeoutHandle = setTimeout(() => {
        finish(() => {
          reject(
            new Error(`Timeout (${this.startupTimeoutMs}ms) aguardando bootstrap do Local Core.`),
          );
        });
      }, this.startupTimeoutMs);

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        if (trimmed.startsWith(BOOTSTRAP_PREFIX)) {
          const rawJson = trimmed.slice(BOOTSTRAP_PREFIX.length);
          try {
            const parsed = LocalCoreBootstrapEventV1Schema.parse(JSON.parse(rawJson));
            finish(() => resolve(parsed));
          } catch (err) {
            finish(() =>
              reject(
                new Error(
                  `Payload de bootstrap inválido do Local Core: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
              ),
            );
          }
          return;
        }
        this.logLine('info', `[core] ${trimmed}`);
      };

      const onStdout = (chunk: Buffer | string): void => {
        stdoutBuffer = flushLinesFromBuffer(stdoutBuffer, chunk, (line) => {
          if (!settled) {
            handleLine(line);
          }
        });
      };

      const onStderr = (chunk: Buffer | string): void => {
        stderrBuffer = flushLinesFromBuffer(stderrBuffer, chunk, (line) => {
          const trimmed = line.trim();
          if (trimmed) {
            this.logLine('warn', `[core:err] ${trimmed}`);
          }
        });
      };

      const onExitBeforeReady = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(() => {
          reject(
            new Error(
              `Local Core encerrou antes de ficar pronto (code=${String(code)}, signal=${String(signal)}).`,
            ),
          );
        });
      };

      const onErrorBeforeReady = (err: Error): void => {
        finish(() => reject(err));
      };

      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.once('exit', onExitBeforeReady);
      child.once('error', onErrorBeforeReady);
    });
  }

  private attachRunningChildListeners(child: SupervisedCoreChild): void {
    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer = flushLinesFromBuffer(stdoutBuffer, chunk, (line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith(BOOTSTRAP_PREFIX)) {
          this.logLine('info', `[core] ${trimmed}`);
        }
      });
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBuffer = flushLinesFromBuffer(stderrBuffer, chunk, (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          this.logLine('warn', `[core:err] ${trimmed}`);
        }
      });
    });

    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.intentionallyTerminatedChildren.has(child) || this.stopping) {
        return;
      }

      this.clearTimers();
      this.port = null;
      this.baseUrl = null;
      this.lanUrls = [];
      this.lastError = `Local Core encerrou inesperadamente (code=${String(code)}, signal=${String(signal)}).`;
      this.logLine('error', this.lastError);
      this.scheduleAutoRestart();
    });
  }

  private startHealthPolling(): void {
    if (this.healthCheckIntervalMs <= 0) {
      return;
    }
    this.healthTimer = setInterval(() => {
      if (this.stopping || !this.baseUrl || this.status !== 'running' || this.healthCheckInFlight) {
        return;
      }
      void this.checkRunningHealth();
    }, this.healthCheckIntervalMs);
    this.healthTimer.unref();
  }

  private async checkRunningHealth(): Promise<void> {
    if (!this.baseUrl || this.stopping || this.healthCheckInFlight) {
      return;
    }

    this.healthCheckInFlight = true;
    try {
      const ok = await this.probeHealth(this.baseUrl);
      if (this.stopping) {
        return;
      }
      if (ok) {
        this.consecutiveHealthFailures = 0;
        return;
      }

      this.consecutiveHealthFailures += 1;
      this.logLine(
        'warn',
        `Health check do Local Core falhou (${this.consecutiveHealthFailures}/3).`,
      );
      if (this.consecutiveHealthFailures >= 3 && !this.stopping) {
        this.lastError = 'Local Core parou de responder ao health check.';
        const currentChild = this.child;
        this.child = null;
        this.port = null;
        this.baseUrl = null;
        this.lanUrls = [];
        this.clearTimers();

        if (currentChild) {
          this.intentionallyTerminatedChildren.add(currentChild);
          await this.terminateChildProcess(currentChild);
        }
        if (!this.stopping) {
          this.scheduleAutoRestart();
        }
      }
    } finally {
      this.healthCheckInFlight = false;
    }
  }

  private scheduleAutoRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const now = Date.now();
    this.crashTimestampsMs = this.crashTimestampsMs.filter((ts) => now - ts <= CRASH_WINDOW_MS);

    if (this.crashTimestampsMs.length >= MAX_AUTO_RESTARTS_IN_WINDOW) {
      this.logLine(
        'error',
        `Limite de ${MAX_AUTO_RESTARTS_IN_WINDOW} reinícios em 60s atingido; entrando em modo degradado.`,
      );
      this.setStatus('degraded');
      return;
    }

    this.crashTimestampsMs.push(now);
    const attempt = this.crashTimestampsMs.length;
    const delayMs = Math.min(4_000, 400 * 2 ** (attempt - 1));
    this.restartCount += 1;
    this.setStatus('restarting');
    this.logLine(
      'warn',
      `Agendando reinício automático #${attempt} do Local Core em ${delayMs}ms.`,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) {
        return;
      }
      void this.start().catch((err) => {
        if (!this.stopping) {
          this.lastError = sanitizeLogText(err instanceof Error ? err.message : String(err));
          this.setStatus('degraded');
        }
      });
    }, delayMs);
    this.restartTimer.unref();
  }

  private async probeHealth(baseUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    timeout.unref();
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        return false;
      }
      const json: unknown = await response.json();
      const parsed = HealthResponseSchema.safeParse(json);
      return parsed.success && parsed.data.status === 'ok';
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async stopInternal(options: {
    resetCrashWindow: boolean;
    targetFinalStatus: 'stopped' | 'restarting';
  }): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    if (options.resetCrashWindow) {
      this.crashTimestampsMs = [];
    }

    const activeChild = this.child;
    this.child = null;
    if (activeChild) {
      this.intentionallyTerminatedChildren.add(activeChild);
      await this.terminateChildProcess(activeChild);
    }

    if (this.activeStartPromise) {
      await this.activeStartPromise.catch(() => undefined);
    }

    this.port = null;
    this.baseUrl = null;
    this.lanUrls = [];
    this.setStatus(options.targetFinalStatus);
  }

  private async terminateChildProcess(child: SupervisedCoreChild): Promise<void> {
    if (child.exitCode !== null || child.killed) {
      return;
    }

    this.intentionallyTerminatedChildren.add(child);

    const exitedCleanly = new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, this.shutdownGraceMs);
      timer.unref();

      child.once('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });

    try {
      if (child.stdin.writable) {
        child.stdin.write('{"cmd":"shutdown"}\n');
        child.stdin.end();
      }
    } catch {
      // Ignore broken stdin pipe during concurrent exit
    }

    if (await exitedCleanly) {
      return;
    }

    if (process.platform !== 'win32') {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore if already dead
      }
    }

    if (child.pid !== undefined && process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
      });
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore if already dead
      }
    }
  }
}
