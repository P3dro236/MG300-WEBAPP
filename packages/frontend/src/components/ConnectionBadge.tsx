import React from 'react';
import type {
  DeviceSyncStatus,
  MidiAdapterMode,
  MidiConnectionState,
} from '@quicktone/shared';
import type { WsConnectionStatus } from '../api/client';

interface ConnectionBadgeProps {
  connectionState: MidiConnectionState;
  midiAdapterMode?: MidiAdapterMode;
  connectedPortName: string | null;
  wsStatus: WsConnectionStatus;
  syncStatus: DeviceSyncStatus;
  hasLoadedInitialState?: boolean;
}

const MIDI_STATE_MAP: Record<
  MidiConnectionState,
  { label: string; dotClass: string; textClass: string; badgeClass: string }
> = {
  connected: {
    label: 'MG-300 Conectada',
    dotClass: 'bg-status-confirmed',
    textClass: 'text-text-primary',
    badgeClass: 'border-status-confirmed-border bg-status-confirmed-bg',
  },
  connecting: {
    label: 'Conectando…',
    dotClass: 'bg-status-warning',
    textClass: 'text-status-warning',
    badgeClass: 'border-status-warning-border bg-status-warning-bg',
  },
  reconnecting: {
    label: 'Reconectando…',
    dotClass: 'bg-status-warning',
    textClass: 'text-status-warning',
    badgeClass: 'border-status-warning-border bg-status-warning-bg',
  },
  error: {
    label: 'Erro na conexão',
    dotClass: 'bg-status-error-led',
    textClass: 'text-status-error',
    badgeClass: 'border-status-error-border bg-status-error-bg',
  },
  disconnected: {
    label: 'Pedaleira desconectada',
    dotClass: 'bg-text-disabled',
    textClass: 'text-text-muted',
    badgeClass: 'border-border-subtle bg-bg-surface',
  },
};

const WS_ERROR_LABELS: Partial<Record<WsConnectionStatus, string>> = {
  connecting: 'Conectando servidor…',
  reconnecting: 'Reconectando servidor…',
  disconnected: 'Servidor offline',
};

export const ConnectionBadge: React.FC<ConnectionBadgeProps> = ({
  connectionState,
  midiAdapterMode = 'hardware',
  connectedPortName,
  wsStatus,
  syncStatus,
  hasLoadedInitialState = true,
}) => {
  const effectiveMidiState: MidiConnectionState = !hasLoadedInitialState
    ? 'connecting'
    : connectionState;
  const isMockConnected =
    hasLoadedInitialState &&
    midiAdapterMode === 'mock' &&
    effectiveMidiState === 'connected';
  const midiStyle = isMockConnected
    ? {
        label: 'Modo Simulação (MOCK) · Sem hardware USB',
        dotClass: 'bg-status-warning',
        textClass: 'text-status-warning',
        badgeClass: 'border-status-warning-border bg-status-warning-bg',
      }
    : MIDI_STATE_MAP[effectiveMidiState];
  const wsWarningLabel = wsStatus !== 'connected' ? WS_ERROR_LABELS[wsStatus] : null;

  return (
    <div
      aria-live="polite"
      data-testid="device-sync-badge"
      data-sync-status={syncStatus}
      className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums"
    >
      <div
        data-testid="midi-connection-badge"
        data-connection-state={effectiveMidiState}
        data-midi-mode={midiAdapterMode}
        className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 ${midiStyle.badgeClass}`}
      >
        <span className={`h-2 w-2 rounded-full ${midiStyle.dotClass}`} aria-hidden="true" />
        <span className={midiStyle.textClass}>
          {!hasLoadedInitialState
            ? 'Verificando pedaleira…'
            : wsStatus !== 'connected' && effectiveMidiState === 'disconnected'
              ? 'Sem servidor local'
              : midiStyle.label}
          {!isMockConnected && effectiveMidiState === 'connected' && connectedPortName
            ? ` · ${connectedPortName}`
            : ''}
        </span>
      </div>

      <div
        data-testid="ws-connection-badge"
        data-ws-status={wsStatus}
        className={
          wsWarningLabel
            ? 'inline-flex items-center gap-1.5 rounded border border-status-error-border bg-status-error-bg px-2 py-1 text-status-error'
            : 'sr-only'
        }
      >
        {wsWarningLabel ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-status-error-led" aria-hidden="true" />
            <span>{wsWarningLabel}</span>
          </>
        ) : (
          <span>Servidor conectado</span>
        )}
      </div>
    </div>
  );
};
