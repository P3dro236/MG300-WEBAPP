import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AiGearConfig,
  type AiToneApplyRequest,
  type AiToneApplyResponse,
  type AppErrorRecord,
  type ControllerState,
  type ExperimentalEditState,
  type PairingStatusResponse,
  type Preset,
  type PresetsResponse,
  type UpdateAiGearRequest,
  filterVisibleLibraryPresets,
  isPlaceholderPreset,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';
import {
  QuickToneApiClient,
  QuickToneApiError,
  QuickToneWsManager,
  type WsConnectionStatus,
  createInitialControllerState,
} from '../api/client';
import type { PresetFilter, PresetViewMode } from '../components/PresetGrid';
import {
  loadPersistedAppData,
  mergePresetsSafely,
  savePersistedAppData,
} from '../utils/storage';

function mergeControllerStateSafely(
  prev: ControllerState,
  incoming: ControllerState,
): ControllerState {
  if (
    prev.lastSentCommand?.confirmedByDevice &&
    incoming.lastSentCommand &&
    prev.lastSentCommand.commandId === incoming.lastSentCommand.commandId &&
    !incoming.lastSentCommand.confirmedByDevice
  ) {
    return prev;
  }
  return incoming;
}

export interface UseControllerSessionOptions {
  client: QuickToneApiClient;
  pairingChecked: boolean;
  isAuthorized: boolean;
  reconnectBaseDelayMs?: number;
  onPairingSnapshot: (snapshot: {
    activeSession: PairingStatusResponse['activeSession'];
    pendingRequests: PairingStatusResponse['pendingRequests'];
    activeChallenge: PairingStatusResponse['activeChallenge'];
    trustedDevices?: PairingStatusResponse['trustedDevices'];
  }) => void;
  onAuthRevoked: (reason: 'expired' | 'revoked' | 'none') => void;
}

export function useControllerSession({
  client,
  pairingChecked,
  isAuthorized,
  reconnectBaseDelayMs,
  onPairingSnapshot,
  onAuthRevoked,
}: UseControllerSessionOptions) {
  const initialPersisted = useMemo(() => loadPersistedAppData(), []);

  const [controllerState, setControllerState] = useState<ControllerState>(() =>
    createInitialControllerState(),
  );
  const [hasLoadedInitialState, setHasLoadedInitialState] = useState(false);
  const [presetsResponse, setPresetsResponse] = useState<PresetsResponse>(() => ({
    presets: initialPersisted.presets,
    directory: null,
    directoryStatus: 'ok',
    warnings: [],
  }));
  const [allSlotPresets, setAllSlotPresets] = useState<Preset[]>(() => initialPersisted.presets);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('connecting');
  const [filter, setFilter] = useState<PresetFilter>(initialPersisted.preferences.filter);
  const [viewMode, setViewMode] = useState<PresetViewMode>(initialPersisted.preferences.viewMode);
  const [masterVolume, setMasterVolume] = useState<number>(
    initialPersisted.preferences.lastVolume ?? 50,
  );
  const [uiError, setUiError] = useState<AppErrorRecord | null>(null);
  const [isConnectingMidi, setIsConnectingMidi] = useState(false);
  const [isReloadingPresets, setIsReloadingPresets] = useState(false);
  const [wsReconnectEpoch, setWsReconnectEpoch] = useState(0);
  const [aiGear, setAiGear] = useState<AiGearConfig | null>(null);

  const initialLoadInFlightRef = useRef<Promise<void> | null>(null);
  const lastVolumeCommandAtRef = useRef<number>(0);
  const isDraggingVolumeRef = useRef<boolean>(false);
  const latestDraggedVolumeRef = useRef<number | null>(null);
  const pendingVolumeRef = useRef<{ volume: number } | null>(null);
  const volumeInFlightRef = useRef<boolean>(false);
  const experimentalListenersRef = useRef(
    new Set<(state: ExperimentalEditState) => void>(),
  );

  const latestPresetsRef = useRef<Preset[]>(presetsResponse.presets);
  latestPresetsRef.current = presetsResponse.presets;
  const latestPrefsRef = useRef({
    filter,
    viewMode,
    lastVolume: masterVolume,
  });
  latestPrefsRef.current = {
    filter,
    viewMode,
    lastVolume: masterVolume,
  };

  const persistState = useCallback(
    (nextPresets: Preset[], nextPrefs?: Partial<typeof latestPrefsRef.current>): void => {
      savePersistedAppData({
        version: 1,
        updatedAt: new Date().toISOString(),
        presets: nextPresets,
        preferences: {
          ...latestPrefsRef.current,
          ...nextPrefs,
        },
      });
    },
    [],
  );

  const applyMergedPresets = useCallback(
    (incomingPresets: readonly Preset[]): void => {
      const realIncoming = incomingPresets.filter((p) => !isPlaceholderPreset(p));
      if (realIncoming.length > 0) {
        setAllSlotPresets(realIncoming);
      }
      setPresetsResponse((prev) => {
        const merged = mergePresetsSafely(prev.presets, incomingPresets);
        persistState(merged);
        return {
          ...prev,
          presets: merged,
        };
      });
    },
    [persistState],
  );

  const subscribeExperimentalSync = useCallback(
    (listener: (state: ExperimentalEditState) => void): (() => void) => {
      experimentalListenersRef.current.add(listener);
      return () => {
        experimentalListenersRef.current.delete(listener);
      };
    },
    [],
  );

  const loadInitialData = useCallback(async (): Promise<void> => {
    if (initialLoadInFlightRef.current) {
      return initialLoadInFlightRef.current;
    }

    const promise = (async () => {
      try {
        const [status, presets, gearResponse] = await Promise.all([
          client.getState(),
          client.getPresets(),
          client.getAiGear().catch(() => ({ gear: null })),
        ]);
        setControllerState(status);
        setHasLoadedInitialState(true);
        setAiGear(gearResponse.gear ?? null);

        const realIncoming = presets.presets.filter((p) => !isPlaceholderPreset(p));
        if (realIncoming.length > 0) {
          setAllSlotPresets(realIncoming);
        }
        const merged = mergePresetsSafely(latestPresetsRef.current, presets.presets);
        setPresetsResponse({
          presets: merged,
          directory: null,
          directoryStatus: 'ok',
          warnings: presets.warnings,
        });

        const isInteracting =
          isDraggingVolumeRef.current ||
          volumeInFlightRef.current ||
          pendingVolumeRef.current !== null ||
          Date.now() - lastVolumeCommandAtRef.current < 800;

        if (
          !isInteracting &&
          status.confirmedState.volume !== null &&
          (status.confirmedState.volumeTarget === null ||
            status.confirmedState.volumeTarget === 'master_cc64')
        ) {
          setMasterVolume(status.confirmedState.volume);
          persistState(merged, { lastVolume: status.confirmedState.volume });
        } else {
          persistState(merged);
        }

        if (status.lastError) {
          setUiError(status.lastError);
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (
          code === 'PAIRING_REQUIRED' ||
          code === 'SESSION_EXPIRED' ||
          code === 'SESSION_REVOKED'
        ) {
          onAuthRevoked(
            code === 'SESSION_EXPIRED'
              ? 'expired'
              : code === 'SESSION_REVOKED'
                ? 'revoked'
                : 'none',
          );
          return;
        }
        setUiError({
          code: err instanceof QuickToneApiError ? err.code : 'BACKEND_UNREACHABLE',
          message:
            err instanceof QuickToneApiError
              ? err.message
              : 'Falha ao carregar estado inicial do servidor.',
          timestamp: new Date().toISOString(),
        });
      }
    })().finally(() => {
      if (initialLoadInFlightRef.current === promise) {
        initialLoadInFlightRef.current = null;
      }
    });

    initialLoadInFlightRef.current = promise;
    return promise;
  }, [client, onAuthRevoked, persistState]);

  useEffect(() => {
    if (!pairingChecked || !isAuthorized) {
      return;
    }

    void loadInitialData();

    const ws = new QuickToneWsManager({
      reconnectBaseDelayMs,
      onStatusChange: setWsStatus,
      onReconnected: () => {
        setWsReconnectEpoch((prev) => prev + 1);
        void loadInitialData();
      },
      onAuthRevoked: (reason) => {
        onAuthRevoked(reason === 'expired' ? 'expired' : 'revoked');
      },
      onMessage: (message) => {
        if (message.type === 'state_sync') {
          setControllerState(message.state);
          setHasLoadedInitialState(true);
          if (message.presets && message.presets.length > 0) {
            applyMergedPresets(message.presets);
          }

          const isInteracting =
            isDraggingVolumeRef.current ||
            volumeInFlightRef.current ||
            pendingVolumeRef.current !== null ||
            Date.now() - lastVolumeCommandAtRef.current < 800;

          const sentVolCmd = message.state.lastSentCommand;
          const hasUnconfirmedSentVol =
            sentVolCmd?.type === 'volume_change' &&
            !sentVolCmd.confirmedByDevice &&
            sentVolCmd.volume !== undefined &&
            (sentVolCmd.volumeTarget === undefined ||
              sentVolCmd.volumeTarget === 'master_cc64');

          const confirmedVol = message.state.confirmedState.volume;
          const targetIsMaster =
            message.state.confirmedState.volumeTarget === null ||
            message.state.confirmedState.volumeTarget === 'master_cc64';

          if (!isInteracting) {
            if (hasUnconfirmedSentVol && sentVolCmd.volume !== undefined) {
              setMasterVolume(sentVolCmd.volume);
              persistState(latestPresetsRef.current, { lastVolume: sentVolCmd.volume });
            } else if (confirmedVol !== null && targetIsMaster) {
              setMasterVolume(confirmedVol);
              persistState(latestPresetsRef.current, { lastVolume: confirmedVol });
            }
          }

          if (message.state.lastError) {
            setUiError(message.state.lastError);
          }
        } else if (message.type === 'presets_updated') {
          if (message.presets.length > 0) {
            applyMergedPresets(message.presets);
          }
        } else if (message.type === 'pairing_updated') {
          onPairingSnapshot({
            activeSession: message.activeSession,
            pendingRequests: message.pendingRequests,
            activeChallenge: message.activeChallenge,
            ...(message.trustedDevices !== undefined
              ? { trustedDevices: message.trustedDevices }
              : {}),
          });
        } else if (message.type === 'experimental_state_sync') {
          for (const listener of experimentalListenersRef.current) {
            listener(message.state);
          }
        } else if (message.type === 'gear_updated') {
          setAiGear(message.gear);
        } else if (message.type === 'error') {
          setUiError(message.error);
        }
      },
    });

    ws.connect();
    return () => {
      ws.disconnect(true);
    };
  }, [
    pairingChecked,
    isAuthorized,
    loadInitialData,
    applyMergedPresets,
    persistState,
    reconnectBaseDelayMs,
    onPairingSnapshot,
    onAuthRevoked,
  ]);

  const handleChangeFilter = useCallback(
    (nextFilter: PresetFilter): void => {
      setFilter(nextFilter);
      persistState(latestPresetsRef.current, { filter: nextFilter });
    },
    [persistState],
  );

  const handleChangeViewMode = useCallback(
    (nextMode: PresetViewMode): void => {
      setViewMode(nextMode);
      persistState(latestPresetsRef.current, { viewMode: nextMode });
    },
    [persistState],
  );

  const handleConnectMidi = useCallback(
    async (portName?: string): Promise<void> => {
      setIsConnectingMidi(true);
      setUiError(null);
      try {
        const nextState = await client.connectMidi(portName ? { portName } : {});
        if (nextState) {
          setControllerState(nextState);
        }
      } catch (err) {
        setUiError({
          code: err instanceof QuickToneApiError ? err.code : 'MIDI_CONNECT_ERROR',
          message:
            err instanceof QuickToneApiError ? err.message : 'Falha ao conectar porta MIDI.',
          timestamp: new Date().toISOString(),
        });
      } finally {
        setIsConnectingMidi(false);
      }
    },
    [client],
  );

  const handleDisconnectMidi = useCallback(async (): Promise<void> => {
    setUiError(null);
    try {
      const nextState = await client.disconnectMidi();
      if (nextState) {
        setControllerState(nextState);
      }
    } catch (err) {
      setUiError({
        code: err instanceof QuickToneApiError ? err.code : 'MIDI_DISCONNECT_ERROR',
        message:
          err instanceof QuickToneApiError ? err.message : 'Falha ao desconectar pedaleira.',
        timestamp: new Date().toISOString(),
      });
    }
  }, [client]);

  const handleSelectPreset = useCallback(
    async (preset: Preset): Promise<void> => {
      setUiError(null);
      try {
        const result = await client.selectPreset({
          presetId: preset.id,
          slotIndex: preset.slotIndex,
        });
        if (result.state) {
          const nextState = result.state;
          setControllerState((prev) => mergeControllerStateSafely(prev, nextState));
        }
      } catch (err) {
        setUiError({
          code: err instanceof QuickToneApiError ? err.code : 'PRESET_SELECT_ERROR',
          message:
            err instanceof QuickToneApiError ? err.message : 'Falha ao carregar timbre.',
          timestamp: new Date().toISOString(),
        });
      }
    },
    [client],
  );

  const flushVolumeQueue = useCallback(async (): Promise<void> => {
    if (volumeInFlightRef.current) return;
    volumeInFlightRef.current = true;
    try {
      while (pendingVolumeRef.current) {
        const nextReq = pendingVolumeRef.current;
        pendingVolumeRef.current = null;
        try {
          const result = await client.updateVolume({
            volume: nextReq.volume,
            target: 'master_cc64',
          });
          if (result.state && !pendingVolumeRef.current && !isDraggingVolumeRef.current) {
            const nextState = result.state;
            setControllerState((prev) => mergeControllerStateSafely(prev, nextState));
          }
          if (pendingVolumeRef.current) {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        } catch (err) {
          setUiError({
            code: err instanceof QuickToneApiError ? err.code : 'VOLUME_UPDATE_ERROR',
            message:
              err instanceof QuickToneApiError ? err.message : 'Falha ao ajustar volume.',
            timestamp: new Date().toISOString(),
          });
          break;
        }
      }
    } finally {
      volumeInFlightRef.current = false;
    }
  }, [client]);

  const handleChangeVolume = useCallback(
    async (volume: number): Promise<void> => {
      const clamped = Math.max(0, Math.min(100, Math.round(volume)));
      lastVolumeCommandAtRef.current = Date.now();
      if (isDraggingVolumeRef.current) {
        latestDraggedVolumeRef.current = clamped;
      } else {
        setMasterVolume(clamped);
        persistState(latestPresetsRef.current, { lastVolume: clamped });
      }
      pendingVolumeRef.current = { volume: clamped };
      await flushVolumeQueue();
    },
    [flushVolumeQueue, persistState],
  );

  const handleVolumeInteractionStart = useCallback((): void => {
    isDraggingVolumeRef.current = true;
  }, []);

  const handleVolumeInteractionEnd = useCallback((): void => {
    isDraggingVolumeRef.current = false;
    lastVolumeCommandAtRef.current = Date.now();
    if (latestDraggedVolumeRef.current !== null) {
      const finalVolume = latestDraggedVolumeRef.current;
      latestDraggedVolumeRef.current = null;
      setMasterVolume(finalVolume);
      persistState(latestPresetsRef.current, { lastVolume: finalVolume });
    }
  }, [persistState]);

  const handleReloadPresets = useCallback(async (): Promise<void> => {
    setIsReloadingPresets(true);
    setUiError(null);
    try {
      const result = await client.reloadPresets();
      if (result.state) {
        const nextState = result.state;
        setControllerState((prev) => mergeControllerStateSafely(prev, nextState));
      }
      if (result.presetsResponse && result.presetsResponse.presets.length > 0) {
        applyMergedPresets(result.presetsResponse.presets);
      }
    } catch (err) {
      setUiError({
        code: err instanceof QuickToneApiError ? err.code : 'PRESETS_RELOAD_ERROR',
        message:
          err instanceof QuickToneApiError ? err.message : 'Falha ao sincronizar timbres.',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsReloadingPresets(false);
    }
  }, [client, applyMergedPresets]);

  const saveAiGear = useCallback(
    async (payload: UpdateAiGearRequest): Promise<AiGearConfig> => {
      const res = await client.updateAiGear(payload);
      setAiGear(res.gear);
      if (!res.gear) {
        throw new Error('Configuração de equipamento não retornada pelo servidor.');
      }
      return res.gear;
    },
    [client],
  );

  const applyAiTone = useCallback(
    async (payload: AiToneApplyRequest): Promise<AiToneApplyResponse> => {
      const result = await client.applyAiTone(payload);
      if (result.experimentalState) {
        for (const listener of experimentalListenersRef.current) {
          listener(result.experimentalState);
        }
      }

      if (result.saveResult.verified) {
        const coord = slotIndexToBankCoordinate(result.slotIndex);
        const blockModels = result.experimentalState?.blockModels;
        const blocksEnabled = result.experimentalState?.blocksEnabled ?? [];
        const isBlockOn = (id: number): boolean => {
          if (blockModels && Object.prototype.hasOwnProperty.call(blockModels, String(id))) {
            return (blockModels[String(id)] ?? 0) > 0;
          }
          if (id >= 1 && id <= 8) {
            return Boolean(blocksEnabled[id - 1]);
          }
          if (id === 9) {
            return Boolean(result.experimentalState?.cabEnabled);
          }
          return false;
        };

        const updatedPreset: Preset = {
          id: result.displayBank,
          slotIndex: result.slotIndex,
          bankType: 'user',
          bankNumber: coord.bankNumber,
          patchLetter: coord.patchLetter,
          displayBank: result.displayBank,
          name: result.presetName,
          patchVolume: result.experimentalState?.patchVolume ?? result.calibration.appliedPatchVolume,
          irVolume: result.experimentalState?.irVolume ?? result.calibration.appliedIrVolume,
          origin: 'hardware',
          signalChain: {
            compEnabled: isBlockOn(1),
            efxEnabled: isBlockOn(2),
            ampEnabled: isBlockOn(3),
            eqEnabled: isBlockOn(4),
            nrEnabled: isBlockOn(5),
            modEnabled: isBlockOn(6),
            dlyEnabled: isBlockOn(7),
            rvbEnabled: isBlockOn(8),
            irEnabled: isBlockOn(9),
          },
          isDuplicate: false,
          updatedAt: result.saveResult.savedAt,
          midiMapping: {
            protocol: 'mg300-cc60',
            channel: 0,
            ccNumber: 60,
            ccValue: result.slotIndex,
          },
        };

        setAllSlotPresets((prev) => {
          const next = prev.filter((p) => p.slotIndex !== updatedPreset.slotIndex);
          next.push(updatedPreset);
          return next.sort((a, b) => a.slotIndex - b.slotIndex);
        });

        setPresetsResponse((prev) => {
          const merged = mergePresetsSafely(prev.presets, [updatedPreset]);
          persistState(merged);
          return {
            ...prev,
            presets: merged,
          };
        });
      }

      return result;
    },
    [client, persistState],
  );

  const visiblePresets = useMemo(
    () => filterVisibleLibraryPresets(presetsResponse.presets),
    [presetsResponse.presets],
  );

  const activePreset = useMemo(() => {
    const allPool = presetsResponse.presets;
    const pendingCmd =
      controllerState.lastSentCommand?.type === 'preset_select' &&
      !controllerState.lastSentCommand.confirmedByDevice
        ? controllerState.lastSentCommand
        : null;

    if (pendingCmd) {
      return (
        allPool.find(
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
        allPool.find(
          (p) =>
            (confirmedId !== null && p.id === confirmedId) ||
            (confirmedSlot !== null && p.slotIndex === confirmedSlot),
        ) ?? null
      );
    }

    return null;
  }, [
    presetsResponse.presets,
    controllerState.confirmedState.presetId,
    controllerState.confirmedState.slotIndex,
    controllerState.lastSentCommand,
  ]);

  return {
    controllerState,
    hasLoadedInitialState,
    presetsResponse,
    visiblePresets,
    allSlotPresets,
    activePreset,
    wsStatus,
    filter,
    viewMode,
    masterVolume,
    uiError,
    isConnectingMidi,
    isReloadingPresets,
    wsReconnectEpoch,
    aiGear,
    setUiError,
    handleChangeFilter,
    handleChangeViewMode,
    handleConnectMidi,
    handleDisconnectMidi,
    handleSelectPreset,
    handleChangeVolume,
    handleVolumeInteractionStart,
    handleVolumeInteractionEnd,
    handleReloadPresets,
    saveAiGear,
    applyAiTone,
    subscribeExperimentalSync,
  };
}
