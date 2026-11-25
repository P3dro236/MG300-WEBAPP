import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppErrorRecord,
  ControllerState,
  Preset,
  PresetsResponse,
  VolumeTarget,
} from '@quicktone/shared';
import {
  createInitialControllerState,
  getStoredLanToken,
  QuickToneApiClient,
  QuickToneWsManager,
  setStoredLanToken,
  type WsConnectionStatus,
} from './api/client';
import { TopBar } from './components/TopBar';
import { ErrorBanner } from './components/ErrorBanner';
import { StageDisplay } from './components/StageDisplay';
import { VolumeSlider } from './components/VolumeSlider';
import {
  type PresetFilter,
  PresetGrid,
  type PresetViewMode,
} from './components/PresetGrid';
import { SettingsModal } from './components/SettingsModal';

function resolveInitialViewMode(): PresetViewMode {
  if (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 640) {
    return 'stage';
  }
  return 'matrix';
}

export interface AppProps {
  reconnectBaseDelayMs?: number;
}

export function App({ reconnectBaseDelayMs }: AppProps = {}): React.ReactElement {
  const [controllerState, setControllerState] = useState<ControllerState>(() =>
    createInitialControllerState(),
  );
  const [presetsResponse, setPresetsResponse] = useState<PresetsResponse>({
    presets: [],
    directory: null,
    directoryStatus: 'unconfigured',
    warnings: [],
  });
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('connecting');
  const [filter, setFilter] = useState<PresetFilter>('all');
  const [viewMode, setViewMode] = useState<PresetViewMode>(resolveInitialViewMode);
  const [localVolume, setLocalVolume] = useState<number>(50);
  const [uiError, setUiError] = useState<AppErrorRecord | null>(null);
  const [isConnectingMidi, setIsConnectingMidi] = useState(false);
  const [isReloadingPresets, setIsReloadingPresets] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [lanToken, setLanToken] = useState<string>(() => getStoredLanToken());

  const apiClientRef = useRef<QuickToneApiClient | null>(null);
  if (!apiClientRef.current) {
    apiClientRef.current = new QuickToneApiClient({ token: lanToken });
  }
  const wsManagerRef = useRef<QuickToneWsManager | null>(null);
  const lastVolumeCommandAtRef = useRef<number>(0);
  const pendingVolumeRef = useRef<{ volume: number; target: VolumeTarget } | null>(null);
  const volumeInFlightRef = useRef<boolean>(false);
  const volumeTargetRef = useRef<VolumeTarget>(controllerState.volumeTarget);
  volumeTargetRef.current = controllerState.volumeTarget;

  const authBlocked = controllerState.authRequired && lanToken.trim().length === 0;

  const loadInitialData = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    try {
      const [status, presets] = await Promise.all([
        client.getState(),
        client.getPresets(),
      ]);
      setControllerState(status);
      setPresetsResponse(presets);

      if (
        status.confirmedState.volume !== null &&
        status.confirmedState.volumeTarget === status.volumeTarget &&
        Date.now() - lastVolumeCommandAtRef.current > 800
      ) {
        setLocalVolume(status.confirmedState.volume);
      } else if (
        status.lastSentCommand?.volume !== undefined &&
        status.lastSentCommand.volumeTarget === status.volumeTarget
      ) {
        setLocalVolume(status.lastSentCommand.volume);
      }

      if (status.lastError) {
        setUiError(status.lastError);
      }
    } catch (err) {
      setUiError({
        code: 'BACKEND_UNREACHABLE',
        message:
          err instanceof Error
            ? err.message
            : 'Falha ao carregar estado inicial do servidor.',
        timestamp: new Date().toISOString(),
      });
    }
  }, []);

  useEffect(() => {
    void loadInitialData();

    if (authBlocked) {
      setWsStatus('disconnected');
      setUiError((prev) =>
        prev?.code === 'AUTH_REQUIRED'
          ? prev
          : {
              code: 'AUTH_REQUIRED',
              message:
                'Token/PIN LAN obrigatório no servidor. Informe o token em Ajustes para sincronizar e controlar a pedaleira.',
              timestamp: new Date().toISOString(),
            },
      );
      return;
    }

    const ws = new QuickToneWsManager({
      token: lanToken,
      reconnectBaseDelayMs,
      onStatusChange: (status) => {
        setWsStatus(status);
      },
      onReconnected: () => {
        void loadInitialData();
      },
      onMessage: (message) => {
        if (message.type === 'state_sync') {
          setControllerState(message.state);
          if (message.presets) {
            const incomingPresets = message.presets;
            setPresetsResponse((prev) => ({
              ...prev,
              presets: incomingPresets,
              directory: message.state.presetsDirectory,
              directoryStatus: message.state.presetsDirectoryStatus,
            }));
          }

          const vol = message.state.confirmedState.volume;
          const sentVol = message.state.lastSentCommand?.volume;
          const targetMatchesConfirmed =
            message.state.confirmedState.volumeTarget === message.state.volumeTarget;
          const targetMatchesSent =
            message.state.lastSentCommand?.volumeTarget === message.state.volumeTarget;

          if (
            sentVol !== undefined &&
            !message.state.lastSentCommand?.confirmedByDevice &&
            targetMatchesSent
          ) {
            setLocalVolume(sentVol);
          } else if (
            vol !== null &&
            targetMatchesConfirmed &&
            Date.now() - lastVolumeCommandAtRef.current > 800
          ) {
            setLocalVolume(vol);
          }

          if (message.state.lastError) {
            setUiError(message.state.lastError);
          }
        } else if (message.type === 'presets_updated') {
          setPresetsResponse({
            presets: message.presets,
            directory: message.directory,
            directoryStatus: message.directoryStatus,
            warnings: message.warnings,
          });
        } else if (message.type === 'error') {
          setUiError(message.error);
        }
      },
    });

    wsManagerRef.current = ws;
    ws.connect();

    return () => {
      ws.disconnect();
      wsManagerRef.current = null;
    };
  }, [loadInitialData, lanToken, reconnectBaseDelayMs, authBlocked]);

  const handleConnectMidi = useCallback(async (portName?: string): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    setIsConnectingMidi(true);
    setUiError(null);
    try {
      const nextState = await client.connectMidi(portName ? { portName } : {});
      if (nextState) {
        setControllerState(nextState);
      }
    } catch (err) {
      setUiError({
        code: (err as { code?: string }).code ?? 'MIDI_CONNECT_ERROR',
        message: err instanceof Error ? err.message : 'Falha ao conectar porta MIDI.',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsConnectingMidi(false);
    }
  }, []);

  const handleDisconnectMidi = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    setUiError(null);
    try {
      const nextState = await client.disconnectMidi();
      if (nextState) {
        setControllerState(nextState);
      }
    } catch (err) {
      setUiError({
        code: (err as { code?: string }).code ?? 'MIDI_DISCONNECT_ERROR',
        message: err instanceof Error ? err.message : 'Falha ao desconectar MIDI.',
        timestamp: new Date().toISOString(),
      });
    }
  }, []);

  const handleSelectPreset = useCallback(async (preset: Preset): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    setUiError(null);
    try {
      const result = await client.selectPreset({
        presetId: preset.id,
        slotIndex: preset.slotIndex,
      });
      if (result.state) {
        setControllerState(result.state);
      }
    } catch (err) {
      setUiError({
        code: (err as { code?: string }).code ?? 'PRESET_SELECT_ERROR',
        message: err instanceof Error ? err.message : 'Falha ao selecionar preset.',
        timestamp: new Date().toISOString(),
      });
    }
  }, []);

  const flushVolumeQueue = useCallback(async (): Promise<void> => {
    if (volumeInFlightRef.current) {
      return;
    }
    const client = apiClientRef.current;
    if (!client) {
      return;
    }

    volumeInFlightRef.current = true;
    try {
      while (pendingVolumeRef.current) {
        const nextReq = pendingVolumeRef.current;
        pendingVolumeRef.current = null;
        try {
          const result = await client.updateVolume(nextReq);
          // Only apply HTTP state if no newer drag value superseded it while in flight
          if (result.state && !pendingVolumeRef.current) {
            setControllerState(result.state);
          }
        } catch (err) {
          setUiError({
            code: (err as { code?: string }).code ?? 'VOLUME_UPDATE_ERROR',
            message: err instanceof Error ? err.message : 'Falha ao ajustar volume.',
            timestamp: new Date().toISOString(),
          });
          break;
        }
      }
    } finally {
      volumeInFlightRef.current = false;
    }
  }, []);

  const handleChangeVolume = useCallback(
    async (volume: number): Promise<void> => {
      const clamped = Math.max(0, Math.min(100, Math.round(volume)));
      setLocalVolume(clamped);
      lastVolumeCommandAtRef.current = Date.now();
      pendingVolumeRef.current = {
        volume: clamped,
        target: volumeTargetRef.current,
      };
      await flushVolumeQueue();
    },
    [flushVolumeQueue],
  );

  const handleSelectVolumeTarget = useCallback(async (target: VolumeTarget): Promise<void> => {
    const previousTarget = volumeTargetRef.current;
    setControllerState((prev) => ({
      ...prev,
      volumeTarget: target,
    }));
    const client = apiClientRef.current;
    if (!client) return;
    try {
      const nextState = await client.setVolumeTarget(target);
      if (nextState) {
        setControllerState(nextState);
        if (
          nextState.confirmedState.volume !== null &&
          nextState.confirmedState.volumeTarget === target
        ) {
          setLocalVolume(nextState.confirmedState.volume);
        }
      }
    } catch (err) {
      setControllerState((prev) => ({
        ...prev,
        volumeTarget: previousTarget,
      }));
      setUiError({
        code: (err as { code?: string }).code ?? 'VOLUME_TARGET_ERROR',
        message:
          err instanceof Error ? err.message : 'Falha ao selecionar alvo de volume.',
        timestamp: new Date().toISOString(),
      });
    }
  }, []);

  const handleSavePresetsDirectory = useCallback(
    async (directoryPath: string): Promise<void> => {
      const client = apiClientRef.current;
      if (!client) return;
      setUiError(null);
      try {
        const result = await client.configurePresetsDirectory({ directoryPath });
        if (result.state) {
          setControllerState(result.state);
        }
        if (result.presetsResponse) {
          setPresetsResponse(result.presetsResponse);
        }
      } catch (err) {
        setUiError({
          code: (err as { code?: string }).code ?? 'PRESETS_DIR_ERROR',
          message:
            err instanceof Error ? err.message : 'Falha ao configurar pasta QuickTone.',
          timestamp: new Date().toISOString(),
        });
      }
    },
    [],
  );

  const handleToggleFactoryPresets = useCallback(
    async (includeFactoryPresets: boolean): Promise<void> => {
      const client = apiClientRef.current;
      if (!client) return;
      setUiError(null);
      try {
        const result = await client.configurePresetsDirectory({ includeFactoryPresets });
        if (result.state) {
          setControllerState(result.state);
        }
        if (result.presetsResponse) {
          setPresetsResponse(result.presetsResponse);
        }
      } catch (err) {
        setUiError({
          code: (err as { code?: string }).code ?? 'PRESETS_CONFIG_ERROR',
          message:
            err instanceof Error
              ? err.message
              : 'Falha ao atualizar exibição dos presets de fábrica.',
          timestamp: new Date().toISOString(),
        });
      }
    },
    [],
  );

  const handleReloadPresets = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    setIsReloadingPresets(true);
    setUiError(null);
    try {
      const result = await client.reloadPresets();
      if (result.state) {
        setControllerState(result.state);
      }
      if (result.presetsResponse) {
        setPresetsResponse(result.presetsResponse);
      }
    } catch (err) {
      setUiError({
        code: (err as { code?: string }).code ?? 'PRESETS_RELOAD_ERROR',
        message:
          err instanceof Error ? err.message : 'Falha ao sincronizar presets.',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsReloadingPresets(false);
    }
  }, []);

  const handleSaveToken = useCallback((token: string): void => {
    const trimmed = token.trim();
    setStoredLanToken(trimmed);
    setLanToken(trimmed);
    apiClientRef.current?.setToken(trimmed);
    wsManagerRef.current?.setToken(trimmed);
    if (trimmed.length > 0) {
      setUiError((prev) => (prev?.code === 'AUTH_REQUIRED' ? null : prev));
    }
  }, []);

  const activePreset = useMemo(() => {
    const pendingCmd =
      controllerState.lastSentCommand?.type === 'preset_select' &&
      !controllerState.lastSentCommand.confirmedByDevice
        ? controllerState.lastSentCommand
        : null;

    if (pendingCmd) {
      return (
        presetsResponse.presets.find(
          (p) =>
            (pendingCmd.presetId !== undefined && p.id === pendingCmd.presetId) ||
            (pendingCmd.slotIndex !== undefined && p.slotIndex === pendingCmd.slotIndex),
        ) ?? null
      );
    }

    const confirmedId = controllerState.confirmedState.presetId;
    const confirmedSlot = controllerState.confirmedState.slotIndex;
    if (confirmedId !== null || confirmedSlot !== null) {
      return (
        presetsResponse.presets.find(
          (p) =>
            (confirmedId !== null && p.id === confirmedId) ||
            (confirmedSlot !== null && p.slotIndex === confirmedSlot),
        ) ?? null
      );
    }

    return presetsResponse.presets[0] ?? null;
  }, [
    presetsResponse.presets,
    controllerState.confirmedState.presetId,
    controllerState.confirmedState.slotIndex,
    controllerState.lastSentCommand,
  ]);

  const midiDisconnected = controllerState.connectionState !== 'connected';

  return (
    <div className="flex min-h-screen flex-col bg-[#0D0E10] text-[#F3F4F6]">
      <TopBar
        connectionState={controllerState.connectionState}
        connectedPortName={controllerState.connectedPortName}
        wsStatus={wsStatus}
        syncStatus={controllerState.syncStatus}
        confirmedState={controllerState.confirmedState}
        lastSentCommand={controllerState.lastSentCommand}
        deviceFirmwareVersion={controllerState.deviceFirmwareVersion}
        isConnectingMidi={isConnectingMidi}
        onConnectMidi={() => void handleConnectMidi()}
        onDisconnectMidi={() => void handleDisconnectMidi()}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-3 px-3 py-3 sm:gap-4 sm:px-5 sm:py-4">
        <ErrorBanner error={uiError} onDismiss={() => setUiError(null)} />

        <StageDisplay
          activePreset={activePreset}
          syncStatus={controllerState.syncStatus}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
        />

        <VolumeSlider
          volume={localVolume}
          volumeTarget={controllerState.volumeTarget}
          syncStatus={controllerState.syncStatus}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
          disabled={midiDisconnected}
          onChangeVolume={(val) => void handleChangeVolume(val)}
          onSelectTarget={(target) => void handleSelectVolumeTarget(target)}
        />

        <PresetGrid
          presets={presetsResponse.presets}
          filter={filter}
          viewMode={viewMode}
          onChangeFilter={setFilter}
          onChangeViewMode={setViewMode}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
          disabled={midiDisconnected}
          directoryStatus={
            controllerState.presetsDirectoryStatus === 'directory_not_found' ||
            controllerState.presetsDirectoryStatus === 'error'
              ? controllerState.presetsDirectoryStatus
              : presetsResponse.directoryStatus
          }
          presetsDirectory={controllerState.presetsDirectory ?? presetsResponse.directory}
          isReloadingPresets={isReloadingPresets}
          onSelectPreset={(preset) => void handleSelectPreset(preset)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onReloadPresets={() => void handleReloadPresets()}
        />
      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        presetsDirectory={controllerState.presetsDirectory}
        volumeTarget={controllerState.volumeTarget}
        availablePorts={controllerState.availablePorts}
        connectedPortName={controllerState.connectedPortName}
        deviceFirmwareVersion={controllerState.deviceFirmwareVersion}
        lanUrls={controllerState.lanUrls}
        authRequired={controllerState.authRequired}
        currentToken={lanToken}
        includeFactoryPresets={controllerState.includeFactoryPresets ?? true}
        onClose={() => setIsSettingsOpen(false)}
        onSavePresetsDirectory={handleSavePresetsDirectory}
        onToggleFactoryPresets={handleToggleFactoryPresets}
        onSelectVolumeTarget={(target) => void handleSelectVolumeTarget(target)}
        onConnectMidiPort={(portName) => {
          void handleConnectMidi(portName);
        }}
        onSaveToken={handleSaveToken}
      />
    </div>
  );
}

export default App;
