import React from 'react';
import type {
  ConfirmedDeviceState,
  DeviceSyncStatus,
  MidiConnectionState,
  SentCommandRecord,
} from '@quicktone/shared';
import type { WsConnectionStatus } from '../api/client';

interface ConnectionBadgeProps {
  connectionState: MidiConnectionState;
  connectedPortName: string | null;
  wsStatus: WsConnectionStatus;
  syncStatus: DeviceSyncStatus;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  deviceFirmwareVersion?: string | null;
}

const MIDI_STATE_MAP: Record<
  MidiConnectionState,
  { label: string; dotClass: string; textClass: string }
> = {
  connected: {
    label: 'MIDI Conectado',
    dotClass: 'bg-[#22C55E]',
    textClass: 'text-[#F3F4F6]',
  },
  connecting: {
    label: 'Conectando...',
    dotClass: 'bg-[#F59E0B]',
    textClass: 'text-[#F59E0B]',
  },
  reconnecting: {
    label: 'Reconectando...',
    dotClass: 'bg-[#F59E0B]',
    textClass: 'text-[#F59E0B]',
  },
  error: {
    label: 'Erro MIDI',
    dotClass: 'bg-[#EF4444]',
    textClass: 'text-[#EF4444]',
  },
  disconnected: {
    label: 'MIDI Desconectado',
    dotClass: 'bg-[#525866]',
    textClass: 'text-[#8E95A2]',
  },
};

const WS_STATE_MAP: Record<WsConnectionStatus, { label: string; dotClass: string }> = {
  connected: { label: 'WS Online', dotClass: 'bg-[#22C55E]' },
  connecting: { label: 'WS...', dotClass: 'bg-[#F59E0B]' },
  reconnecting: { label: 'Reconectando WS...', dotClass: 'bg-[#F59E0B]' },
  disconnected: { label: 'WS Off', dotClass: 'bg-[#EF4444]' },
};

export const ConnectionBadge: React.FC<ConnectionBadgeProps> = ({
  connectionState,
  connectedPortName,
  wsStatus,
  syncStatus,
  confirmedState,
  lastSentCommand,
  deviceFirmwareVersion,
}) => {
  const midiStyle = MIDI_STATE_MAP[connectionState];
  const wsStyle = WS_STATE_MAP[wsStatus];

  let syncText = 'Estado da pedaleira desconhecido';
  let syncContainerClass = 'border-white/10 bg-[#14161A] text-[#8E95A2]';
  let syncDotClass = 'bg-[#525866]';

  if (syncStatus === 'confirmed') {
    syncText = 'Confirmado pela pedaleira';
    syncContainerClass = 'border-[#22C55E]/40 bg-[#22C55E]/10 text-[#22C55E]';
    syncDotClass = 'bg-[#22C55E]';
  } else if (syncStatus === 'command_sent_unconfirmed') {
    syncText = 'Comando enviado (aguardando confirmação)';
    syncContainerClass = 'border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]';
    syncDotClass = 'bg-[#F59E0B]';
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums">
      <div
        data-testid="midi-connection-badge"
        data-connection-state={connectionState}
        className="inline-flex items-center gap-1.5 rounded border border-white/[0.08] bg-[#090A0C] px-2.5 py-1"
      >
        <span className={`h-2 w-2 rounded-full ${midiStyle.dotClass}`} />
        <span className={midiStyle.textClass}>
          {midiStyle.label}
          {connectionState === 'connected' && connectedPortName ? ` · ${connectedPortName}` : ''}
        </span>
        {connectionState === 'connected' && deviceFirmwareVersion ? (
          <span className="hidden text-[#8E95A2] xl:inline">({deviceFirmwareVersion})</span>
        ) : null}
      </div>

      <div
        data-testid="ws-connection-badge"
        data-ws-status={wsStatus}
        className="inline-flex items-center gap-1.5 rounded border border-white/[0.08] bg-[#090A0C] px-2 py-1 text-[#8E95A2]"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${wsStyle.dotClass}`} />
        <span>{wsStyle.label}</span>
      </div>

      <div
        data-testid="device-sync-badge"
        data-sync-status={syncStatus}
        className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 ${syncContainerClass}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${syncDotClass}`} />
        <span>{syncText}</span>
      </div>

      <div
        data-testid="confirmed-preset-indicator"
        className="hidden items-center gap-1.5 rounded border border-white/[0.08] bg-[#090A0C] px-2.5 py-1 text-[#8E95A2] sm:inline-flex"
      >
        <span>ATIVO:</span>
        <span className="font-semibold text-[#F3F4F6]">
          {confirmedState.presetId ??
            (lastSentCommand?.presetId ? `${lastSentCommand.presetId}*` : '—')}
        </span>
      </div>
    </div>
  );
};
