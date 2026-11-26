import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { type AppErrorRecord, type Preset, classifyPresetCategory } from '@quicktone/shared';
import { QuickToneApiClient } from './api/client';
import { TopBar } from './components/TopBar';
import { ErrorBanner } from './components/ErrorBanner';
import { DesktopPairingBanner } from './components/DesktopPairingBanner';
import { MobilePairingGate } from './components/MobilePairingGate';
import { StageDisplay } from './components/StageDisplay';
import { VolumeSlider } from './components/VolumeSlider';
import { PresetGrid } from './components/PresetGrid';
import { SettingsModal } from './components/SettingsModal';
import type { EditorTab } from './components/ToneEditorDrawer';
import { usePairingSession } from './hooks/usePairingSession';
import { useControllerSession } from './hooks/useControllerSession';
import { useToneEditorSession } from './hooks/useToneEditorSession';
import { groupPresetsByBank } from './utils/preset-groups';

const loadToneEditorDrawer = () =>
  import('./components/ToneEditorDrawer').then((mod) => ({
    default: mod.ToneEditorDrawer,
  }));

const LazyToneEditorDrawer = lazy(loadToneEditorDrawer);

export interface AppProps {
  reconnectBaseDelayMs?: number;
}

export function App({ reconnectBaseDelayMs }: AppProps = {}): React.ReactElement {
  const apiClientRef = useRef<QuickToneApiClient | null>(null);
  if (!apiClientRef.current) {
    apiClientRef.current = new QuickToneApiClient();
  }
  const client = apiClientRef.current;

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editorDrawerOpen, setEditorDrawerOpen] = useState(false);
  const [editorInitialTab, setEditorInitialTab] = useState<EditorTab>(3);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const reportErrorRef = useRef<(err: AppErrorRecord) => void>(() => undefined);
  const reportError = useCallback((err: AppErrorRecord) => {
    reportErrorRef.current(err);
  }, []);

  const pairing = usePairingSession(client, reportError);

  const controller = useControllerSession({
    client,
    pairingChecked: pairing.pairingChecked,
    isAuthorized: pairing.isAuthorized,
    reconnectBaseDelayMs,
    onPairingSnapshot: pairing.applyPairingSnapshot,
    onAuthRevoked: pairing.markAuthRevoked,
  });

  reportErrorRef.current = controller.setUiError;

  const toneEditor = useToneEditorSession({
    client,
    isAuthorized: pairing.isAuthorized,
    syncEpoch: controller.wsReconnectEpoch,
    subscribeExperimentalSync: controller.subscribeExperimentalSync,
  });

  const {
    activePreset,
    controllerState,
    visiblePresets,
    filter,
    setUiError,
    handleConnectMidi,
    handleDisconnectMidi,
    handleSelectPreset,
    handleChangeVolume,
    handleReloadPresets,
  } = controller;
  const { loadSlot, createNewTone } = toneEditor;

  const handleOpenEditActiveTone = useCallback(
    (initialBlockId?: number): void => {
      if (!activePreset || classifyPresetCategory(activePreset) !== 'user') {
        return;
      }
      setEditorInitialTab(initialBlockId ?? 3);
      setEditorDrawerOpen(true);
      void loadSlot(activePreset.slotIndex);
    },
    [activePreset, loadSlot],
  );

  const handleOpenCreateTone = useCallback((): void => {
    setEditorInitialTab(3);
    setEditorDrawerOpen(true);
    const activeUserSlot =
      activePreset && classifyPresetCategory(activePreset) === 'user'
        ? activePreset.slotIndex
        : undefined;
    void createNewTone(activeUserSlot);
  }, [activePreset, createNewTone]);

  const handlePreloadEditor = useCallback((): void => {
    void loadToneEditorDrawer();
  }, []);

  const handleOpenSettings = useCallback((): void => {
    setIsSettingsOpen(true);
  }, []);

  const handleCloseSettings = useCallback((): void => {
    setIsSettingsOpen(false);
  }, []);

  const handleCloseEditorDrawer = useCallback((): void => {
    setEditorDrawerOpen(false);
  }, []);

  const handleConnectMidiDefault = useCallback((): void => {
    void handleConnectMidi();
  }, [handleConnectMidi]);

  const handleConnectMidiPort = useCallback(
    (portName: string): void => {
      void handleConnectMidi(portName);
    },
    [handleConnectMidi],
  );

  const handleDisconnectMidiVoid = useCallback((): void => {
    void handleDisconnectMidi();
  }, [handleDisconnectMidi]);

  const handleDismissError = useCallback((): void => {
    setUiError(null);
  }, [setUiError]);

  const handleVolumeChange = useCallback(
    (volume: number): void => {
      void handleChangeVolume(volume);
    },
    [handleChangeVolume],
  );

  const handlePresetSelect = useCallback(
    (preset: Preset): void => {
      void handleSelectPreset(preset);
    },
    [handleSelectPreset],
  );

  const handlePresetsReload = useCallback((): void => {
    void handleReloadPresets();
  }, [handleReloadPresets]);

  const { handleLogoutMobileSession } = pairing;
  const handleLogoutMobile = useCallback(
    () => handleLogoutMobileSession(() => setIsSettingsOpen(false)),
    [handleLogoutMobileSession],
  );

  // Keyboard shortcuts on desktop when no dialog/input is capturing focus
  useEffect(() => {
    if (!pairing.isAuthorized || editorDrawerOpen || isSettingsOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.key.toLowerCase() === 'e') {
        if (activePreset && classifyPresetCategory(activePreset) === 'user') {
          event.preventDefault();
          handleOpenEditActiveTone();
        }
        return;
      }

      if (controllerState.connectionState !== 'connected') {
        return;
      }

      if (['1', '2', '3', '4'].includes(event.key)) {
        const filtered = visiblePresets.filter((p) => classifyPresetCategory(p) === filter);
        const banks = groupPresetsByBank(filtered);
        const activeId = activePreset?.id;
        const activeBank =
          banks.find((b) => b.items.some((item) => item.id === activeId)) ?? banks[0];
        const targetLetter = (['A', 'B', 'C', 'D'] as const)[Number(event.key) - 1];
        const targetPreset = activeBank?.items.find((item) => item.patchLetter === targetLetter);
        if (targetPreset) {
          event.preventDefault();
          void handleSelectPreset(targetPreset);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    pairing.isAuthorized,
    editorDrawerOpen,
    isSettingsOpen,
    activePreset,
    controllerState.connectionState,
    visiblePresets,
    filter,
    handleSelectPreset,
    handleOpenEditActiveTone,
  ]);

  if (!pairing.pairingChecked && !pairing.isAuthorized) {
    return (
      <div
        data-testid="pairing-checking-shell"
        aria-busy="true"
        className="min-h-screen bg-bg-base text-text-primary"
      />
    );
  }

  if (pairing.pairingChecked && !pairing.isAuthorized) {
    return (
      <MobilePairingGate
        initialPairingCode={pairing.initialPairingCode}
        sessionStatus={
          pairing.pairingStatus.sessionStatus === 'desktop'
            ? 'none'
            : pairing.pairingStatus.sessionStatus
        }
        isTrustedDevice={pairing.pairingStatus.isTrustedDevice}
        trustedDeviceName={pairing.pairingStatus.trustedDeviceName}
        onTrustedReconnect={pairing.handleTrustedReconnect}
        onRequestPairing={pairing.handleRequestPairing}
        onPollPairing={pairing.handlePollPairing}
        onPaired={pairing.handlePairedSuccess}
      />
    );
  }

  const midiDisconnected = controllerState.connectionState !== 'connected';
  const isLiveHardwareEditor =
    toneEditor.state?.loaded === true && toneEditor.state.sourceMode === 'hardware';
  const canRetryMidiError =
    controller.uiError?.code === 'PORT_BUSY' ||
    controller.uiError?.code === 'MIDI_CONNECT_ERROR';

  return (
    <div className="flex min-h-screen flex-col bg-bg-base text-text-primary">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[var(--z-modal)] focus:rounded-[var(--radius-md)] focus:bg-accent focus:px-4 focus:py-2 focus:font-sans focus:text-xs focus:font-semibold focus:text-accent-ink"
      >
        Pular para o conteúdo principal
      </a>

      <TopBar
        connectionState={controllerState.connectionState}
        connectedPortName={controllerState.connectedPortName}
        wsStatus={controller.wsStatus}
        syncStatus={controllerState.syncStatus}
        hasLoadedInitialState={controller.hasLoadedInitialState}
        isConnectingMidi={controller.isConnectingMidi}
        onConnectMidi={handleConnectMidiDefault}
        onDisconnectMidi={handleDisconnectMidiVoid}
        onOpenSettings={handleOpenSettings}
      />

      <main
        id="main-content"
        className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 sm:px-6"
      >
        {pairing.pairingStatus.isLocalDesktop && !isSettingsOpen ? (
          <DesktopPairingBanner
            pendingRequests={pairing.pairingStatus.pendingRequests}
            onApprove={pairing.handleApprovePairing}
            onReject={pairing.handleRejectPairing}
          />
        ) : null}

        <ErrorBanner
          error={controller.uiError}
          onDismiss={handleDismissError}
          onRetry={canRetryMidiError ? handleConnectMidiDefault : undefined}
        />

        <StageDisplay
          activePreset={activePreset}
          syncStatus={controllerState.syncStatus}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
          liveBlockModels={isLiveHardwareEditor ? toneEditor.localBlockModels : null}
          liveEditorSlot={isLiveHardwareEditor ? toneEditor.state!.slot : null}
          canOpenEditor={pairing.isAuthorized}
          onEditActiveTone={handleOpenEditActiveTone}
          onCreateNewTone={handleOpenCreateTone}
          onPreloadEditor={handlePreloadEditor}
        />

        <VolumeSlider
          volume={controller.masterVolume}
          lastSentCommand={controllerState.lastSentCommand}
          disabled={midiDisconnected}
          onChangeVolume={handleVolumeChange}
          onInteractionStart={controller.handleVolumeInteractionStart}
          onInteractionEnd={controller.handleVolumeInteractionEnd}
        />

        <PresetGrid
          presets={visiblePresets}
          alreadyFiltered
          filter={filter}
          viewMode={controller.viewMode}
          onChangeFilter={controller.handleChangeFilter}
          onChangeViewMode={controller.handleChangeViewMode}
          confirmedState={controllerState.confirmedState}
          lastSentCommand={controllerState.lastSentCommand}
          disabled={midiDisconnected}
          isReloadingPresets={controller.isReloadingPresets}
          onSelectPreset={handlePresetSelect}
          onReloadPresets={handlePresetsReload}
          searchInputRef={searchInputRef}
        />
      </main>

      {editorDrawerOpen ? (
        <Suspense fallback={null}>
          <LazyToneEditorDrawer
            isOpen={editorDrawerOpen}
            initialTab={editorInitialTab}
            session={toneEditor}
            presets={controller.allSlotPresets}
            midiDisabled={midiDisconnected}
            onClose={handleCloseEditorDrawer}
          />
        </Suspense>
      ) : null}

      <SettingsModal
        isOpen={isSettingsOpen}
        availablePorts={controllerState.availablePorts}
        connectedPortName={controllerState.connectedPortName}
        isLocalDesktop={pairing.pairingStatus.isLocalDesktop}
        lanUrls={
          pairing.pairingStatus.lanUrls.length > 0
            ? pairing.pairingStatus.lanUrls
            : controllerState.lanUrls
        }
        activeSession={pairing.pairingStatus.activeSession}
        pendingRequests={pairing.pairingStatus.pendingRequests}
        activeChallenge={pairing.pairingStatus.activeChallenge}
        trustedDevices={pairing.pairingStatus.trustedDevices}
        onClose={handleCloseSettings}
        onConnectMidiPort={handleConnectMidiPort}
        onGeneratePairingQr={pairing.handleGeneratePairingQr}
        onApprovePairing={pairing.handleApprovePairing}
        onRejectPairing={pairing.handleRejectPairing}
        onRevokeMobileSession={pairing.handleRevokeMobileSession}
        onLogoutMobileSession={handleLogoutMobile}
        onRemoveTrustedDevice={pairing.handleRemoveTrustedDevice}
      />
    </div>
  );
}

export default App;
