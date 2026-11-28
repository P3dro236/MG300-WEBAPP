import React from 'react';
import { Settings } from 'lucide-react';
import type {
  DeviceSyncStatus,
  MidiAdapterMode,
  MidiConnectionState,
} from '@quicktone/shared';
import type { WsConnectionStatus } from '../api/client';
import { BrandLogo } from './BrandLogo';
import { ConnectionBadge } from './ConnectionBadge';

interface TopBarProps {
  connectionState: MidiConnectionState;
  midiAdapterMode?: MidiAdapterMode;
  connectedPortName: string | null;
  wsStatus: WsConnectionStatus;
  syncStatus: DeviceSyncStatus;
  hasLoadedInitialState?: boolean;
  isConnectingMidi: boolean;
  onConnectMidi: () => void;
  onDisconnectMidi: () => void;
  onOpenSettings: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  connectionState,
  midiAdapterMode,
  connectedPortName,
  wsStatus,
  syncStatus,
  hasLoadedInitialState = true,
  isConnectingMidi,
  onConnectMidi,
  onDisconnectMidi,
  onOpenSettings,
}) => {
  const isConnected = connectionState === 'connected';

  return (
    <header
      data-testid="top-bar"
      className="sticky top-0 z-[var(--z-sticky)] border-b border-border-subtle bg-bg-base/95 backdrop-blur-sm"
    >
      <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
        <div className="flex items-center gap-3">
          <BrandLogo size="sm" />
        </div>

        <div className="order-3 w-full md:order-2 md:w-auto">
          <ConnectionBadge
            connectionState={connectionState}
            midiAdapterMode={midiAdapterMode}
            connectedPortName={connectedPortName}
            wsStatus={wsStatus}
            syncStatus={syncStatus}
            hasLoadedInitialState={hasLoadedInitialState}
          />
        </div>

        <div className="order-2 flex items-center gap-2 md:order-3">
          <button
            type="button"
            data-testid="midi-toggle-btn"
            onClick={isConnected ? onDisconnectMidi : onConnectMidi}
            disabled={isConnectingMidi}
            className={`inline-flex min-h-[44px] items-center rounded-[var(--radius-md)] border px-3 font-sans text-xs font-medium transition-colors duration-150 lg:min-h-[38px] cursor-pointer ${
              isConnected
                ? 'border-border-strong bg-bg-elevated text-text-primary hover:border-border-hover'
                : 'border-accent-border bg-bg-elevated text-accent hover:border-accent'
            } disabled:opacity-50`}
          >
            {isConnected
              ? 'Desconectar'
              : isConnectingMidi
                ? 'Conectando…'
                : 'Conectar pedaleira'}
          </button>

          <button
            type="button"
            data-testid="open-settings-btn"
            aria-label="Configurações"
            onClick={onOpenSettings}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-bg-surface px-2.5 font-sans text-xs font-medium text-text-primary transition-colors duration-150 hover:border-border-hover hover:bg-bg-elevated lg:min-h-[38px] lg:min-w-[38px] cursor-pointer"
          >
            <Settings className="h-4 w-4 text-text-muted" strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden sm:inline">Configurações</span>
          </button>
        </div>
      </div>
    </header>
  );
};
