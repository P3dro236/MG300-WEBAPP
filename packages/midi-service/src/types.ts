import {
  type AppErrorRecord,
  type ConfirmedDeviceState,
  type DeviceSyncStatus,
  MG300_USB_IDENTITY,
  type MidiAdapterMode,
  type MidiConnectionState,
  type MidiErrorCode,
  type MidiPortInfo,
  type SentCommandRecord,
  type VolumeTarget,
} from '@quicktone/shared';
import type { MidiDiagnosticsLogger } from './diagnostics-logger.js';

export class MidiServiceError extends Error {
  public readonly code: MidiErrorCode;
  public readonly timestamp: string;

  constructor(code: MidiErrorCode, message: string) {
    super(message);
    this.name = 'MidiServiceError';
    this.code = code;
    this.timestamp = new Date().toISOString();
  }

  public toErrorRecord(): AppErrorRecord {
    return {
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
    };
  }
}

export interface IMidiAdapter {
  readonly isMock?: boolean;
  listPorts(): Promise<MidiPortInfo[]>;
  openPort(portName: string): Promise<{ portName: string }>;
  closePort(): Promise<void>;
  isConnected(): boolean;
  getConnectedPortName(): string | null;
  sendBytes(bytes: number[]): Promise<void>;
  onIncomingMessage(listener: (bytes: number[]) => void): () => void;
  onDisconnect(listener: (reason?: string) => void): () => void;
}

export interface MidiServiceOptions {
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  strictMg300Safety?: boolean;
  defaultChannel?: number;
  defaultVolumeTarget?: VolumeTarget;
  enableSysExQueries?: boolean;
  /** Experimental branch only: allow the allowlisted real-time CCs and the 0x0E write to slot 4D. */
  experimentalEdit?: boolean;
  logger?: MidiDiagnosticsLogger;
}

export interface MidiServiceStateSnapshot {
  connectionState: MidiConnectionState;
  midiAdapterMode: MidiAdapterMode;
  connectedPortName: string | null;
  availablePorts: MidiPortInfo[];
  syncStatus: DeviceSyncStatus;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  volumeTarget: VolumeTarget;
  deviceFirmwareVersion: string | null;
  lastError: AppErrorRecord | null;
}

export function isMg300PortName(portName: string): boolean {
  const normalized = portName.toUpperCase();
  return MG300_USB_IDENTITY.portNamePatterns.some((pattern) =>
    normalized.includes(pattern.toUpperCase()),
  );
}
