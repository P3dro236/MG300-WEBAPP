import React from 'react';
import type {
  ConfirmedDeviceState,
  DeviceSyncStatus,
  MidiConnectionState,
  SentCommandRecord,
} from '@quicktone/shared';
import type { WsConnectionStatus } from '../api/client';
import { ConnectionBadge } from './ConnectionBadge';

interface TopBarProps {
  connectionState: MidiConnectionState;
  connectedPortName: string | null;
  wsStatus: WsConnectionStatus;
  syncStatus: DeviceSyncStatus;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  deviceFirmwareVersion?: string | null;
  isConnectingMidi: boolean;
  onConnectMidi: () => void;
  onDisconnectMidi: () => void;
  onOpenSettings: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  connectionState,
  connectedPortName,
  wsStatus,
  syncStatus,
  confirmedState,
  lastSentCommand,
  deviceFirmwareVersion,
  isConnectingMidi,
  onConnectMidi,
  onDisconnectMidi,
  onOpenSettings,
}) => {
  const isConnected = connectionState === 'connected';

  return (
    <header
      data-testid="top-bar"
      className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#0D0E10]/95 backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-5">
        <div className="flex items-center gap-2.5">
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="shrink-0 text-[#F59E0B]"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8" cy="14" r="1.5" />
            <circle cx="16" cy="14" r="1.5" />
            <line x1="7" y1="8.5" x2="17" y2="8.5" />
          </svg>
          <div className="flex items-baseline gap-2">
            <span className="font-sans text-sm font-bold tracking-[0.08em] text-[#F3F4F6]">
              QUICKTONE
            </span>
            <span className="font-mono text-[11px] text-[#8E95A2]">NUX MG-300</span>
          </div>
        </div>

        <div className="order-3 w-full lg:order-2 lg:w-auto">
          <ConnectionBadge
            connectionState={connectionState}
            connectedPortName={connectedPortName}
            wsStatus={wsStatus}
            syncStatus={syncStatus}
            confirmedState={confirmedState}
            lastSentCommand={lastSentCommand}
            deviceFirmwareVersion={deviceFirmwareVersion}
          />
        </div>

        <div className="order-2 flex items-center gap-2 lg:order-3">
          <button
            type="button"
            data-testid="midi-toggle-btn"
            onClick={isConnected ? onDisconnectMidi : onConnectMidi}
            disabled={isConnectingMidi}
            className={`inline-flex min-h-[38px] items-center rounded border px-3 font-mono text-xs font-medium transition-colors duration-150 ${
              isConnected
                ? 'border-white/15 bg-[#1B1E24] text-[#F3F4F6] hover:border-white/25'
                : 'border-[#F59E0B]/50 bg-[#1B1E24] text-[#F59E0B] hover:border-[#F59E0B]'
            } disabled:opacity-50`}
          >
            {isConnected ? 'Desconectar' : isConnectingMidi ? 'Conectando...' : 'Conectar MIDI'}
          </button>

          <button
            type="button"
            data-testid="open-settings-btn"
            aria-label="Abrir configurações"
            onClick={onOpenSettings}
            className="inline-flex min-h-[38px] min-w-[38px] items-center justify-center gap-1.5 rounded border border-white/10 bg-[#14161A] px-2.5 font-mono text-xs text-[#F3F4F6] transition-colors duration-150 hover:border-white/25 hover:bg-[#1B1E24]"
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="hidden sm:inline">Ajustes</span>
          </button>
        </div>
      </div>
    </header>
  );
};
