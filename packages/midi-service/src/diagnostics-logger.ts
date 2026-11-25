import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DiagnosticLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface MidiDiagnosticsLoggerOptions {
  logFilePath?: string | null;
  maxBytes?: number;
  enabled?: boolean;
}

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB

function resolveDefaultLogFilePath(): string {
  const fromEnv = process.env.QUICKTONE_MIDI_LOG_FILE?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  // Anchor to repository root (<repo>/packages/midi-service/src -> <repo>/logs/midi-diagnostics.log)
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(currentDir, '..', '..', '..');
  return path.join(repoRoot, 'logs', 'midi-diagnostics.log');
}

function isTestRuntime(): boolean {
  return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
}

export function formatHexBytes(bytes: readonly number[], maxBytes = 32): string {
  const slice = bytes.slice(0, maxBytes);
  const hex = slice.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ');
  return bytes.length > maxBytes ? `${hex} ... (${bytes.length}B total)` : hex;
}

export class MidiDiagnosticsLogger {
  private readonly logFilePath: string | null;
  private readonly maxBytes: number;
  private readonly enabled: boolean;
  private dirEnsured = false;

  constructor(options: MidiDiagnosticsLoggerOptions = {}) {
    const explicitPath = options.logFilePath;
    if (explicitPath === null) {
      this.logFilePath = null;
      this.enabled = false;
    } else if (explicitPath !== undefined) {
      this.logFilePath = path.resolve(explicitPath);
      this.enabled = options.enabled ?? true;
    } else {
      this.logFilePath = resolveDefaultLogFilePath();
      this.enabled = options.enabled ?? !isTestRuntime();
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  }

  public getLogFilePath(): string | null {
    return this.logFilePath;
  }

  public isEnabled(): boolean {
    return this.enabled && this.logFilePath !== null;
  }

  public debug(scope: string, message: string, details?: Record<string, unknown>): void {
    this.write('DEBUG', scope, message, details);
  }

  public info(scope: string, message: string, details?: Record<string, unknown>): void {
    this.write('INFO', scope, message, details);
  }

  public warn(scope: string, message: string, details?: Record<string, unknown>): void {
    this.write('WARN', scope, message, details);
  }

  public error(scope: string, message: string, details?: Record<string, unknown>): void {
    this.write('ERROR', scope, message, details);
  }

  public write(
    level: DiagnosticLogLevel,
    scope: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (!this.enabled || !this.logFilePath) {
      return;
    }

    try {
      if (!this.dirEnsured) {
        fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
        this.dirEnsured = true;
      }
      this.rotateIfNeeded(this.logFilePath);

      const timestamp = new Date().toISOString();
      const safeMessage = message.replace(/\r?\n/g, ' \\n ');
      let serializedDetails = '';
      if (details && Object.keys(details).length > 0) {
        try {
          serializedDetails = ` | ${JSON.stringify(details)}`;
        } catch {
          serializedDetails = ' | {"serializationError":true}';
        }
      }

      const line = `[${timestamp}] [${level}] [${scope}] ${safeMessage}${serializedDetails}\n`;
      fs.appendFileSync(this.logFilePath, line, 'utf8');
    } catch {
      this.dirEnsured = false;
      // Diagnostic logging must never break MIDI or HTTP execution
    }
  }

  private rotateIfNeeded(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < this.maxBytes) {
        return;
      }
      const parsed = path.parse(filePath);
      const backupPath = path.join(parsed.dir, `${parsed.name}.prev${parsed.ext || '.log'}`);
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Ignore ENOENT or cleanup failure before rename
      }
      fs.renameSync(filePath, backupPath);
    } catch {
      // Ignore ENOENT or rotation failures
    }
  }
}

let sharedDiagnosticsLogger: MidiDiagnosticsLogger | null = null;

export function getSharedMidiDiagnosticsLogger(): MidiDiagnosticsLogger {
  if (!sharedDiagnosticsLogger) {
    sharedDiagnosticsLogger = new MidiDiagnosticsLogger();
  }
  return sharedDiagnosticsLogger;
}
