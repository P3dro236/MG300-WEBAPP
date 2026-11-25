import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppErrorRecord,
  ControllerState,
  ExperimentalEditState,
  PairingStatusResponse,
  Preset,
  PresetsResponse,
} from '@quicktone/shared';
import {
  classifyPresetCategory,
  filterVisibleLibraryPresets,
  isPlaceholderPreset,
} from '@quicktone/shared';
import {
  createInitialControllerState,
  QuickToneApiClient,
  QuickToneApiError,
  QuickToneWsManager,
  type WsConnectionStatus,
} from './api/client';
import { TopBar } from './components/TopBar';
import { ErrorBanner } from './components/ErrorBanner';
import { DesktopPairingBanner } from './components/DesktopPairingBanner';
import { MobilePairingGate } from './components/MobilePairingGate';
import { StageDisplay } from './components/StageDisplay';
import { VolumeSlider } from './components/VolumeSlider';
import { ExperimentalEditPanel } from './components/ExperimentalEditPanel';
import {
  type PresetFilter,
  PresetGrid,
  type PresetViewMode,
} from './components/PresetGrid';
import { SettingsModal } from './components/SettingsModal';
import {
  loadPersistedAppData,
  mergePresetsSafely,
  savePersistedAppData,
} from './utils/storage';

export interface AppProps {
  reconnectBaseDelayMs?: number;
}

function readInitialPairingCode(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const url = new URL(window.location.href);
    const pairCode = url.searchParams.get('pair')?.trim() ?? null;
    return pairCode && pairCode.length >= 6 ? pairCode : null;
  } catch {
    return null;
  }
}

function mergeControllerStateSafely(
  prev: ControllerState,
  incoming: ControllerState,
): ControllerState {
  // Never let an in-flight HTTP response regress a command already confirmed via WebSocket
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
function isLikelyLocalhostOrigin(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  const host = window.location.hostname.toLowerCase();
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isValidPairingStatusPayload(value: unknown): value is PairingStatusResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.isLocalDesktop === 'boolean' &&
    typeof record.authenticated === 'boolean' &&
    typeof record.sessionStatus === 'string'
  );
}

export function App({ reconnectBaseDelayMs }: AppProps = {}): React.ReactElement {
  const initialPersisted = useMemo(() => loadPersistedAppData(), []);
  const [initialPairingCode, setInitialPairingCode] = useState<string | null>(() =>
    readInitialPairingCode(),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('pair')) {
        url.searchParams.delete('pair');
        const nextUrl = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState({}, '', nextUrl || '/');
      }
    } catch {
      // Ignore history errors
    }
  }, []);

  const [pairingStatus, setPairingStatus] = useState<PairingStatusResponse>(() => ({
    isLocalDesktop: isLikelyLocalhostOrigin(),
    authenticated: isLikelyLocalhostOrigin(),
    sessionStatus: isLikelyLocalhostOrigin() ? 'desktop' : 'none',
    activeSession: null,
    pendingRequests: [],
    activeChallenge: null,
    lanUrls: [],
  }));
  const [pairingChecked, setPairingChecked] = useState(false);

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
  const [filter, setFilter] = useState<PresetFilter>(
    initialPersisted.preferences.filter,
  );
  const [viewMode, setViewMode] = useState<PresetViewMode>(
    initialPersisted.preferences.viewMode,
  );
  const [localVolume, setLocalVolume] = useState<number>(
    initialPersisted.preferences.lastVolume ?? 50,
  );
  const [uiError, setUiError] = useState<AppErrorRecord | null>(null);
  const [isConnectingMidi, setIsConnectingMidi] = useState(false);
  const [isReloadingPresets, setIsReloadingPresets] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [experimentalSyncState, setExperimentalSyncState] =
    useState<ExperimentalEditState | null>(null);
  const [wsReconnectEpoch, setWsReconnectEpoch] = useState(0);

  const apiClientRef = useRef<QuickToneApiClient | null>(null);
  if (!apiClientRef.current) {
    apiClientRef.current = new QuickToneApiClient();
  }
  const wsManagerRef = useRef<QuickToneWsManager | null>(null);
  const initialLoadInFlightRef = useRef<Promise<void> | null>(null);
  const suppressAutoTrustedLoginRef = useRef<boolean>(false);
  const lastVolumeCommandAtRef = useRef<number>(0);
  const isDraggingVolumeRef = useRef<boolean>(false);
  const pendingVolumeRef = useRef<{ volume: number } | null>(null);
  const volumeInFlightRef = useRef<boolean>(false);

  const latestPresetsRef = useRef<Preset[]>(presetsResponse.presets);
  latestPresetsRef.current = presetsResponse.presets;
  const latestPrefsRef = useRef({
    filter,
    viewMode,
    lastVolume: localVolume,
  });
  latestPrefsRef.current = {
    filter,
    viewMode,
    lastVolume: localVolume,
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

  const refreshPairingStatus = useCallback(
    async (options: { autoTrustedLogin?: boolean } = {}): Promise<PairingStatusResponse> => {
      const client = apiClientRef.current;
      if (!client) {
        return pairingStatus;
      }
      const allowAutoTrusted =
        (options.autoTrustedLogin ?? true) && !suppressAutoTrustedLoginRef.current;
      try {
        let status = await client.getPairingStatus();
        if (isValidPairingStatusPayload(status)) {
          if (
            allowAutoTrusted &&
            !status.isLocalDesktop &&
            !status.authenticated &&
            status.isTrustedDevice &&
            status.sessionStatus !== 'revoked'
          ) {
            try {
              await client.loginTrustedDevice();
              const refreshed = await client.getPairingStatus();
              if (isValidPairingStatusPayload(refreshed)) {
                status = refreshed;
              }
            } catch {
              // Trusted login failed or expired; keep pairing gate visible
            }
          }
          setPairingStatus(status);
          setPairingChecked(true);
          return status;
        }
      } catch {
        // If pairing endpoint is absent in isolated unit test mocks, allow localhost fallback only
      }

    const fallbackLocal = isLikelyLocalhostOrigin();
    const fallbackStatus: PairingStatusResponse = {
      isLocalDesktop: fallbackLocal,
      authenticated: fallbackLocal,
      sessionStatus: fallbackLocal ? 'desktop' : 'none',
      activeSession: null,
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: [],
    };
    setPairingStatus(fallbackStatus);
    setPairingChecked(true);
    return fallbackStatus;
  }, []);

  useEffect(() => {
    void refreshPairingStatus();
  }, [refreshPairingStatus]);

  const isAuthorized = pairingStatus.isLocalDesktop || pairingStatus.authenticated;

  const loadInitialData = useCallback(async (): Promise<void> => {
    if (initialLoadInFlightRef.current) {
      return initialLoadInFlightRef.current;
    }
    const client = apiClientRef.current;
    if (!client) return;

    const promise = (async () => {
      try {
        const [status, presets] = await Promise.all([
          client.getState(),
          client.getPresets(),
        ]);
        setControllerState(status);
        setHasLoadedInitialState(true);

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
          setLocalVolume(status.confirmedState.volume);
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
          setPairingStatus((prev) => ({
            ...prev,
            authenticated: false,
            sessionStatus:
              code === 'SESSION_EXPIRED'
                ? 'expired'
                : code === 'SESSION_REVOKED'
                  ? 'revoked'
                  : 'none',
          }));
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
  }, [persistState]);

  useEffect(() => {
    if (!pairingChecked || !isAuthorized) {
      return;
    }

    void loadInitialData();

    const ws = new QuickToneWsManager({
      reconnectBaseDelayMs,
      onStatusChange: (status) => {
        setWsStatus(status);
      },
      onReconnected: () => {
        setWsReconnectEpoch((prev) => prev + 1);
        void loadInitialData();
      },
      onAuthRevoked: (reason) => {
        suppressAutoTrustedLoginRef.current = true;
        setPairingStatus((prev) => ({
          ...prev,
          authenticated: false,
          sessionStatus: reason === 'expired' ? 'expired' : 'revoked',
        }));
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
              setLocalVolume(sentVolCmd.volume);
              persistState(latestPresetsRef.current, { lastVolume: sentVolCmd.volume });
            } else if (confirmedVol !== null && targetIsMaster) {
              setLocalVolume(confirmedVol);
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
          setPairingStatus((prev) => ({
            ...prev,
            activeSession: message.activeSession,
            pendingRequests: message.pendingRequests,
            activeChallenge: message.activeChallenge,
            ...(message.trustedDevices !== undefined
              ? { trustedDevices: message.trustedDevices }
              : {}),
          }));
        } else if (message.type === 'experimental_state_sync') {
          setExperimentalSyncState(message.state);
        } else if (message.type === 'error') {
          setUiError(message.error);
        }
      },
    });

    wsManagerRef.current = ws;
    ws.connect();

    return () => {
      ws.disconnect(true);
      wsManagerRef.current = null;
    };
  }, [
    pairingChecked,
    isAuthorized,
    loadInitialData,
    applyMergedPresets,
    persistState,
    reconnectBaseDelayMs,
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
        code: err instanceof QuickToneApiError ? err.code : 'MIDI_CONNECT_ERROR',
        message:
          err instanceof QuickToneApiError ? err.message : 'Falha ao conectar porta MIDI.',
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
        code: err instanceof QuickToneApiError ? err.code : 'MIDI_DISCONNECT_ERROR',
        message:
          err instanceof QuickToneApiError ? err.message : 'Falha ao desconectar MIDI.',
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
        const nextState = result.state;
        setControllerState((prev) => mergeControllerStateSafely(prev, nextState));
      }
    } catch (err) {
      setUiError({
        code: err instanceof QuickToneApiError ? err.code : 'PRESET_SELECT_ERROR',
        message:
          err instanceof QuickToneApiError ? err.message : 'Falha ao selecionar preset.',
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
  }, []);

  const handleChangeVolume = useCallback(
    async (volume: number): Promise<void> => {
      const clamped = Math.max(0, Math.min(100, Math.round(volume)));
      setLocalVolume(clamped);
      lastVolumeCommandAtRef.current = Date.now();
      persistState(latestPresetsRef.current, { lastVolume: clamped });
      pendingVolumeRef.current = { volume: clamped };
      await flushVolumeQueue();
    },
    [flushVolumeQueue, persistState],
  );

  const handleReloadPresets = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
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
          err instanceof QuickToneApiError ? err.message : 'Falha ao sincronizar presets.',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsReloadingPresets(false);
    }
  }, [applyMergedPresets]);

  const applyPairingSnapshot = useCallback(
    (res: {
      activeSession: PairingStatusResponse['activeSession'];
      pendingRequests: PairingStatusResponse['pendingRequests'];
      activeChallenge: PairingStatusResponse['activeChallenge'];
      trustedDevices?: PairingStatusResponse['trustedDevices'];
    }): void => {
      setPairingStatus((prev) => ({
        ...prev,
        activeSession: res.activeSession,
        pendingRequests: res.pendingRequests,
        activeChallenge: res.activeChallenge,
        ...(res.trustedDevices !== undefined ? { trustedDevices: res.trustedDevices } : {}),
      }));
    },
    [],
  );

  const reportPairingError = useCallback((err: unknown, fallbackMessage: string): void => {
    setUiError({
      code: err instanceof QuickToneApiError ? err.code : 'PAIRING_ACTION_ERROR',
      message: err instanceof QuickToneApiError ? err.message : fallbackMessage,
      timestamp: new Date().toISOString(),
    });
  }, []);

  const handleGeneratePairingQr = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    try {
      applyPairingSnapshot(await client.createPairingChallenge());
    } catch (err) {
      reportPairingError(err, 'Falha ao gerar QR Code de pareamento.');
    }
  }, [applyPairingSnapshot, reportPairingError]);

  const handleApprovePairing = useCallback(
    async (requestId: string): Promise<void> => {
      const client = apiClientRef.current;
      if (!client) return;
      try {
        applyPairingSnapshot(await client.approvePairing({ requestId }));
      } catch (err) {
        reportPairingError(err, 'Falha ao autorizar celular.');
      }
    },
    [applyPairingSnapshot, reportPairingError],
  );

  const handleRejectPairing = useCallback(
    async (requestId: string): Promise<void> => {
      const client = apiClientRef.current;
      if (!client) return;
      try {
        applyPairingSnapshot(await client.rejectPairing({ requestId }));
      } catch (err) {
        reportPairingError(err, 'Falha ao recusar solicitação de pareamento.');
      }
    },
    [applyPairingSnapshot, reportPairingError],
  );

  const handleRevokeMobileSession = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    try {
      applyPairingSnapshot(await client.revokePairingSession());
    } catch (err) {
      reportPairingError(err, 'Falha ao revogar acesso mobile.');
    }
  }, [applyPairingSnapshot, reportPairingError]);

  const handleLogoutMobileSession = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    try {
      suppressAutoTrustedLoginRef.current = true;
      await client.logoutPairingSession();
      setIsSettingsOpen(false);
      await refreshPairingStatus({ autoTrustedLogin: false });
    } catch (err) {
      reportPairingError(err, 'Falha ao encerrar sessão neste celular.');
    }
  }, [refreshPairingStatus, reportPairingError]);

  const handleTrustedReconnect = useCallback(async (): Promise<void> => {
    const client = apiClientRef.current;
    if (!client) return;
    suppressAutoTrustedLoginRef.current = false;
    await client.loginTrustedDevice();
    await refreshPairingStatus({ autoTrustedLogin: false });
  }, [refreshPairingStatus]);

  const handleRemoveTrustedDevice = useCallback(
    async (deviceId: string): Promise<void> => {
      const client = apiClientRef.current;
      if (!client) return;
      try {
        applyPairingSnapshot(await client.removeTrustedDevice({ deviceId }));
      } catch (err) {
        reportPairingError(err, 'Falha ao remover dispositivo confiável.');
      }
    },
    [applyPairingSnapshot, reportPairingError],
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

    return (
      visiblePresets.find((p) => classifyPresetCategory(p) === filter) ??
      visiblePresets[0] ??
      null
    );
  }, [
    presetsResponse.presets,
    visiblePresets,
    filter,
    controllerState.confirmedState.presetId,
    controllerState.confirmedState.slotIndex,
    controllerState.lastSentCommand,
  ]);

  const handleVolumeSliderChange = useCallback(
    (val: number): void => {
      void handleChangeVolume(val);
    },
    [handleChangeVolume],
  );

  const handleVolumeInteractionStart = useCallback((): void => {
    isDraggingVolumeRef.current = true;
  }, []);

  const handleVolumeInteractionEnd = useCallback((): void => {
    isDraggingVolumeRef.current = false;
    lastVolumeCommandAtRef.current = Date.now();
  }, []);

  const handleRequestPairing = useCallback(
    (payload: { pairingCode: string; deviceName?: string }) =>
      apiClientRef.current!.requestPairing(payload),
    [],
  );

  const handlePollPairing = useCallback(
    (payload: { requestId: string; claimSecret: string }) =>
      apiClientRef.current!.pollPairing(payload),
    [],
  );

  const handlePairedSuccess = useCallback((): void => {
    suppressAutoTrustedLoginRef.current = false;
    setInitialPairingCode(null);
    void refreshPairingStatus({ autoTrustedLogin: false });
  }, [refreshPairingStatus]);

  if (pairingChecked && !isAuthorized) {
    return (
      <MobilePairingGate
        initialPairingCode={initialPairingCode}
        sessionStatus={
          pairingStatus.sessionStatus === 'desktop' ? 'none' : pairingStatus.sessionStatus
        }
        isTrustedDevice={pairingStatus.isTrustedDevice}
        trustedDeviceName={pairingStatus.trustedDeviceName}
        onTrustedReconnect={handleTrustedReconnect}
        onRequestPairing={handleRequestPairing}
        onPollPairing={handlePollPairing}
        onPaired={handlePairedSuccess}
      />
    );
  }

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
        hasLoadedInitialState={hasLoadedInitialState}
        isConnectingMidi={isConnectingMidi}
        onConnectMidi={() => void handleConnectMidi()}
        onDisconnectMidi={() => void handleDisconnectMidi()}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-3 px-3 py-3 sm:gap-4 sm:px-5 sm:py-4">
        {pairingStatus.isLocalDesktop ? (
          <DesktopPairingBanner
            pendingRequests={pairingStatus.pendingRequests}
            onApprove={handleApprovePairing}
            onReject={handleRejectPairing}
          />
        ) : null}

        <ErrorBanner error={uiError} onDismiss={() => setUiError(null)} />

        <StageDisplay
          activePreset={activePreset}
          syncStatus={controllerState.syncStatus}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
        />

        <VolumeSlider
          volume={localVolume}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
          disabled={midiDisconnected}
          onChangeVolume={handleVolumeSliderChange}
          onInteractionStart={handleVolumeInteractionStart}
          onInteractionEnd={handleVolumeInteractionEnd}
        />

        {isAuthorized ? (
          <ExperimentalEditPanel
            client={apiClientRef.current!}
            presets={allSlotPresets}
            disabled={midiDisconnected}
            externalState={experimentalSyncState}
            syncEpoch={wsReconnectEpoch}
          />
        ) : null}

        <PresetGrid
          presets={visiblePresets}
          alreadyFiltered
          filter={filter}
          viewMode={viewMode}
          onChangeFilter={handleChangeFilter}
          onChangeViewMode={handleChangeViewMode}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
          disabled={midiDisconnected}
          isReloadingPresets={isReloadingPresets}
          onSelectPreset={(preset) => void handleSelectPreset(preset)}
          onReloadPresets={() => void handleReloadPresets()}
        />
      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        availablePorts={controllerState.availablePorts}
        connectedPortName={controllerState.connectedPortName}
        isLocalDesktop={pairingStatus.isLocalDesktop}
        lanUrls={
          pairingStatus.lanUrls.length > 0
            ? pairingStatus.lanUrls
            : controllerState.lanUrls
        }
        activeSession={pairingStatus.activeSession}
        pendingRequests={pairingStatus.pendingRequests}
        activeChallenge={pairingStatus.activeChallenge}
        trustedDevices={pairingStatus.trustedDevices}
        onClose={() => setIsSettingsOpen(false)}
        onConnectMidiPort={(portName) => {
          void handleConnectMidi(portName);
        }}
        onGeneratePairingQr={handleGeneratePairingQr}
        onApprovePairing={handleApprovePairing}
        onRejectPairing={handleRejectPairing}
        onRevokeMobileSession={handleRevokeMobileSession}
        onLogoutMobileSession={handleLogoutMobileSession}
        onRemoveTrustedDevice={handleRemoveTrustedDevice}
      />
    </div>
  );
}

export default App;
