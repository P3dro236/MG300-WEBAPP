import crypto from 'node:crypto';
import os from 'node:os';
import {
  type ConnectMidiRequest,
  type ControllerState,
  type HealthResponse,
  type Preset,
  type PresetsResponse,
  type SelectPresetRequest,
  type SentCommandRecord,
  type UpdateVolumeRequest,
  type VolumeTarget,
  parseBankLabel,
} from '@quicktone/shared';
import {
  QuickToneDiscoveryService,
  buildPresetFromStruct102,
  createUserPlaceholderPresets,
} from '@quicktone/reader';
import {
  type IMidiAdapter,
  MidiService,
  type MidiServiceOptions,
  MockMidiAdapter,
  WinMmMidiAdapter,
} from '@quicktone/midi';

export class PresetNotFoundError extends Error {
  public readonly code = 'PRESET_NOT_FOUND';
  public readonly timestamp: string;

  constructor(identifier: string) {
    super(`Preset "${identifier}" não encontrado nos presets carregados.`);
    this.name = 'PresetNotFoundError';
    this.timestamp = new Date().toISOString();
  }
}

export interface ControllerStateManagerOptions {
  discoveryService?: QuickToneDiscoveryService;
  midiService?: MidiService;
  midiAdapter?: IMidiAdapter;
  midiOptions?: MidiServiceOptions;
  presetsDirectory?: string | null;
  includeFactoryPresets?: boolean;
  fillMissingUserSlots?: boolean;
  enableSysExSync?: boolean;
  lanUrls?: string[];
  serverPort?: number;
  authToken?: string | null;
  autoConnectMidiOnInit?: boolean;
}

export function getLocalLanAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return Array.from(new Set(addresses));
}

export function resolveServerPort(rawPort: string | number | undefined, fallback = 3001): number {
  const parsed = Number(rawPort ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

export function computeLocalLanUrls(port: number): string[] {
  return getLocalLanAddresses().map((ip) => `http://${ip}:${port}`);
}

export type StateChangeListener = (
  state: ControllerState,
  presets: PresetsResponse,
) => void;

export type PresetsUpdatedListener = (
  presets: PresetsResponse,
  state: ControllerState,
) => void;

export class ControllerStateManager {
  private readonly discoveryService: QuickToneDiscoveryService;
  private readonly midiService: MidiService;
  private readonly startedAtMs: number = Date.now();
  private readonly autoConnectMidiOnInit: boolean;
  private readonly fillMissingUserSlots: boolean;
  private readonly enableSysExSync: boolean;
  private authToken: string | null;
  private lanUrls: string[];
  private diskPresetsResponse: PresetsResponse;
  private presetsResponse: PresetsResponse;
  private readonly hardwarePresets = new Map<number, Preset>();
  private initialized = false;
  private previousConnectionState: string = 'disconnected';
  private hardwareDumpFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readbackConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private sysExSyncRunId = 0;

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly presetsListeners = new Set<PresetsUpdatedListener>();
  private readonly unsubscribeMidiState: () => void;
  private readonly unsubscribePresetDump: () => void;
  private unsubscribeWatcher: () => void;

  constructor(options: ControllerStateManagerOptions = {}) {
    this.discoveryService =
      options.discoveryService ??
      new QuickToneDiscoveryService({
        directoryPath: options.presetsDirectory,
        includeFactoryPresets: options.includeFactoryPresets ?? false,
      });

    if (options.midiService) {
      this.midiService = options.midiService;
    } else {
      const adapter: IMidiAdapter =
        options.midiAdapter ??
        (process.env.QUICKTONE_MIDI_ADAPTER === 'mock'
          ? new MockMidiAdapter()
          : new WinMmMidiAdapter());
      this.midiService = new MidiService(adapter, options.midiOptions);
    }

    const rawToken =
      options.authToken !== undefined
        ? options.authToken
        : process.env.QUICKTONE_AUTH_TOKEN ?? null;
    this.authToken = rawToken && rawToken.trim().length > 0 ? rawToken.trim() : null;
    this.autoConnectMidiOnInit = options.autoConnectMidiOnInit ?? false;
    this.fillMissingUserSlots = options.fillMissingUserSlots ?? false;
    this.enableSysExSync =
      options.enableSysExSync ?? options.midiOptions?.enableSysExQueries ?? false;
    this.lanUrls =
      options.lanUrls ??
      computeLocalLanUrls(resolveServerPort(options.serverPort ?? process.env.PORT));
    this.diskPresetsResponse = this.discoveryService.getLastResult();
    this.presetsResponse = this.mergePresetsResponse(this.diskPresetsResponse);

    this.unsubscribeMidiState = this.midiService.onStateChange((midiState) => {
      const becameConnected =
        this.previousConnectionState !== 'connected' &&
        midiState.connectionState === 'connected';
      const becameDisconnected =
        this.previousConnectionState === 'connected' &&
        midiState.connectionState !== 'connected';
      this.previousConnectionState = midiState.connectionState;

      if (becameDisconnected) {
        this.sysExSyncRunId += 1;
        this.clearReadbackTimer();
        if (this.hardwareDumpFlushTimer !== null) {
          clearTimeout(this.hardwareDumpFlushTimer);
          this.hardwareDumpFlushTimer = null;
        }
        if (this.hardwarePresets.size > 0) {
          this.hardwarePresets.clear();
          this.presetsResponse = this.mergePresetsResponse(this.diskPresetsResponse);
          const nextState = this.getState();
          const nextPresets = this.getPresetsResponse();
          for (const listener of this.presetsListeners) {
            listener(nextPresets, nextState);
          }
        }
      }

      this.emitStateChange();

      if (becameConnected && this.enableSysExSync) {
        void this.syncHardwareState();
      }
    });

    this.unsubscribePresetDump = this.midiService.onPresetDump(({ slotIndex, struct102 }) => {
      this.handleHardwarePresetDump(slotIndex, struct102);
    });

    this.unsubscribeWatcher = this.discoveryService.watchDirectory((result) => {
      this.handleDiscoveryUpdate(result);
    });
  }

  public async initialize(force = false): Promise<void> {
    if (this.initialized && !force) {
      return;
    }
    this.initialized = true;
    this.diskPresetsResponse = await this.discoveryService.discover();
    this.presetsResponse = this.mergePresetsResponse(this.diskPresetsResponse);
    this.unsubscribeWatcher();
    this.unsubscribeWatcher = this.discoveryService.watchDirectory((result) => {
      this.handleDiscoveryUpdate(result);
    });

    await this.midiService.discoverPorts();

    if (this.autoConnectMidiOnInit) {
      try {
        await this.midiService.connect();
      } catch {
        // Permanece desconectado/erro se nenhuma pedaleira estiver conectada no boot
      }
    }

    this.emitStateChange();
  }

  public setLanUrls(urls: string[]): void {
    this.lanUrls = Array.from(new Set(urls));
    this.emitStateChange();
  }

  public getDiscoveryService(): QuickToneDiscoveryService {
    return this.discoveryService;
  }

  public getMidiService(): MidiService {
    return this.midiService;
  }

  public isAuthRequired(): boolean {
    return this.authToken !== null && this.authToken.length > 0;
  }

  public setAuthToken(token: string | null): void {
    this.authToken = token && token.trim().length > 0 ? token.trim() : null;
    this.emitStateChange();
  }

  public validateAuthToken(candidate?: string | null): boolean {
    if (!this.isAuthRequired()) {
      return true;
    }
    if (!candidate || !this.authToken) {
      return false;
    }
    const expectedHash = crypto.createHash('sha256').update(this.authToken).digest();
    const candidateHash = crypto.createHash('sha256').update(candidate.trim()).digest();
    return crypto.timingSafeEqual(expectedHash, candidateHash);
  }

  public getState(): ControllerState {
    const midiState = this.midiService.getState();
    return {
      connectionState: midiState.connectionState,
      connectedPortName: midiState.connectedPortName,
      availablePorts: midiState.availablePorts,
      syncStatus: midiState.syncStatus,
      confirmedState: midiState.confirmedState,
      lastSentCommand: midiState.lastSentCommand,
      volumeTarget: midiState.volumeTarget,
      presetsDirectory: this.presetsResponse.directory,
      presetsDirectoryStatus: this.presetsResponse.directoryStatus,
      includeFactoryPresets: this.discoveryService.getIncludeFactoryPresets(),
      presetCount: this.presetsResponse.presets.length,
      warnings: [...this.presetsResponse.warnings],
      authRequired: this.isAuthRequired(),
      deviceFirmwareVersion: midiState.deviceFirmwareVersion,
      lanUrls: [...this.lanUrls],
      lastError: midiState.lastError,
    };
  }

  public getPresetsResponse(): PresetsResponse {
    return {
      presets: this.presetsResponse.presets.map((p) => ({
        ...p,
        midiMapping: { ...p.midiMapping },
      })),
      directory: this.presetsResponse.directory,
      directoryStatus: this.presetsResponse.directoryStatus,
      warnings: [...this.presetsResponse.warnings],
    };
  }

  public getHealth(): HealthResponse {
    const midiState = this.midiService.getState();
    const uptimeSeconds = Math.max(0, (Date.now() - this.startedAtMs) / 1000);
    return {
      status: 'ok',
      service: 'quicktone-web-controller',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Number(uptimeSeconds.toFixed(3)),
      midiConnection: midiState.connectionState,
      syncStatus: midiState.syncStatus,
    };
  }

  public async refreshPresets(): Promise<PresetsResponse> {
    const willSyncHardware =
      this.midiService.isConnected() && this.enableSysExSync;
    if (willSyncHardware) {
      this.hardwarePresets.clear();
    }
    const result = await this.discoveryService.reload();
    if (this.diskPresetsResponse !== result) {
      this.handleDiscoveryUpdate(result);
    }
    if (willSyncHardware) {
      void this.syncHardwareState();
    }
    return this.getPresetsResponse();
  }

  public async configurePresetsDirectory(
    directoryPath?: string,
    includeFactoryPresets?: boolean,
  ): Promise<PresetsResponse> {
    let result: PresetsResponse;
    if (directoryPath !== undefined) {
      result = await this.discoveryService.setDirectory(
        directoryPath,
        includeFactoryPresets,
      );
    } else {
      if (includeFactoryPresets !== undefined) {
        this.discoveryService.setIncludeFactoryPresets(includeFactoryPresets);
      }
      result = await this.discoveryService.reload();
    }
    if (this.diskPresetsResponse !== result) {
      this.handleDiscoveryUpdate(result);
    }
    return this.getPresetsResponse();
  }

  public async selectPreset(request: SelectPresetRequest): Promise<{
    state: ControllerState;
    command: SentCommandRecord;
    preset?: Preset;
  }> {
    let matchedPreset: Preset | undefined;
    let targetSlotIndex: number | undefined;

    if (request.presetId !== undefined) {
      const normalizedId = request.presetId.trim().toLowerCase();
      matchedPreset = this.presetsResponse.presets.find(
        (p) =>
          p.id.toLowerCase() === normalizedId ||
          p.displayBank.toLowerCase() === normalizedId ||
          p.name.toLowerCase() === normalizedId,
      );

      if (matchedPreset) {
        targetSlotIndex = matchedPreset.slotIndex;
      } else if (request.slotIndex !== undefined) {
        const parsedCoord = parseBankLabel(request.presetId);
        if (parsedCoord && parsedCoord.slotIndex === request.slotIndex) {
          targetSlotIndex = request.slotIndex;
        } else {
          throw new PresetNotFoundError(request.presetId);
        }
      } else {
        throw new PresetNotFoundError(request.presetId);
      }
    } else if (request.slotIndex !== undefined) {
      targetSlotIndex = request.slotIndex;
      matchedPreset = this.presetsResponse.presets.find(
        (p) => p.slotIndex === request.slotIndex,
      );
    }

    if (targetSlotIndex === undefined) {
      throw new PresetNotFoundError(request.presetId ?? String(request.slotIndex));
    }

    const command = matchedPreset
      ? await this.midiService.selectPresetByMapping(matchedPreset)
      : await this.midiService.selectMg300Preset(targetSlotIndex);

    if (this.enableSysExSync) {
      this.scheduleHardwareReadback('global');
    }

    return {
      state: this.getState(),
      command,
      ...(matchedPreset ? { preset: matchedPreset } : {}),
    };
  }

  public async setVolume(request: UpdateVolumeRequest): Promise<{
    state: ControllerState;
    command: SentCommandRecord;
  }> {
    const command = await this.midiService.setVolume(request.volume, request.target);
    if (this.enableSysExSync) {
      const resolvedTarget = request.target ?? this.midiService.getState().volumeTarget;
      if (resolvedTarget === 'patch_cc74') {
        const activeSlot =
          this.midiService.getState().confirmedState.slotIndex ??
          this.midiService.getState().lastSentCommand?.slotIndex;
        if (activeSlot !== null && activeSlot !== undefined) {
          this.scheduleHardwareReadback('patch', activeSlot);
        }
      } else {
        this.scheduleHardwareReadback('global');
      }
    }
    return {
      state: this.getState(),
      command,
    };
  }

  public setVolumeTarget(target: VolumeTarget): { state: ControllerState } {
    this.midiService.setVolumeTarget(target);
    return { state: this.getState() };
  }

  public async connectMidi(request?: ConnectMidiRequest): Promise<{
    state: ControllerState;
  }> {
    await this.midiService.connect(request?.portName);
    return {
      state: this.getState(),
    };
  }

  public async disconnectMidi(): Promise<{
    state: ControllerState;
  }> {
    await this.midiService.disconnect();
    return {
      state: this.getState(),
    };
  }

  public onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public onPresetsUpdated(listener: PresetsUpdatedListener): () => void {
    this.presetsListeners.add(listener);
    return () => {
      this.presetsListeners.delete(listener);
    };
  }

  public dispose(): void {
    this.sysExSyncRunId += 1;
    this.clearReadbackTimer();
    if (this.hardwareDumpFlushTimer !== null) {
      clearTimeout(this.hardwareDumpFlushTimer);
      this.hardwareDumpFlushTimer = null;
    }
    this.unsubscribeWatcher();
    this.discoveryService.stopWatching();
    this.unsubscribeMidiState();
    this.unsubscribePresetDump();
    this.midiService.dispose();
    this.stateListeners.clear();
    this.presetsListeners.clear();
  }

  public async syncHardwareState(): Promise<void> {
    const runId = ++this.sysExSyncRunId;
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    try {
      await sleep(60);
      if (runId !== this.sysExSyncRunId || !this.midiService.isConnected()) return;
      await this.midiService.queryDeviceIdentity();
      await sleep(30);
      if (runId !== this.sysExSyncRunId || !this.midiService.isConnected()) return;
      await this.midiService.queryGlobalStatus();
      await sleep(30);
      if (runId !== this.sysExSyncRunId || !this.midiService.isConnected()) return;
      await this.midiService.queryAllPresets();
      await sleep(650);
      if (runId !== this.sysExSyncRunId || !this.midiService.isConnected()) return;

      for (let slot = 0; slot < 36; slot++) {
        if (runId !== this.sysExSyncRunId || !this.midiService.isConnected()) return;
        if (!this.hardwarePresets.has(slot)) {
          await this.midiService.queryPresetSlot(slot);
          await sleep(50);
        }
      }
    } catch {
      // Hardware SysEx sync is best-effort read-only enrichment; ignore transient timeouts
    }
  }

  private scheduleHardwareReadback(mode: 'global' | 'patch', slotIndex?: number): void {
    this.clearReadbackTimer();
    this.readbackConfirmTimer = setTimeout(() => {
      this.readbackConfirmTimer = null;
      if (!this.midiService.isConnected()) {
        return;
      }
      if (mode === 'patch' && slotIndex !== undefined) {
        void this.midiService.queryPresetSlot(slotIndex).catch(() => {});
      } else {
        void this.midiService.queryGlobalStatus().catch(() => {});
      }
    }, 85);
  }

  private clearReadbackTimer(): void {
    if (this.readbackConfirmTimer !== null) {
      clearTimeout(this.readbackConfirmTimer);
      this.readbackConfirmTimer = null;
    }
  }

  private handleHardwarePresetDump(slotIndex: number, struct102: Uint8Array): void {
    if (slotIndex < 0 || slotIndex > 71) {
      return;
    }
    const preset = buildPresetFromStruct102(struct102, slotIndex, {
      origin: 'hardware',
    });
    this.hardwarePresets.set(slotIndex, preset);

    if (this.hardwareDumpFlushTimer === null) {
      this.hardwareDumpFlushTimer = setTimeout(() => {
        this.hardwareDumpFlushTimer = null;
        this.handleDiscoveryUpdate(this.diskPresetsResponse);
      }, 45);
    }
  }

  private mergePresetsResponse(diskResult: PresetsResponse): PresetsResponse {
    const bySlot = new Map<number, Preset>();

    if (this.fillMissingUserSlots) {
      for (const placeholder of createUserPlaceholderPresets()) {
        bySlot.set(placeholder.slotIndex, placeholder);
      }
    }

    for (const fileOrFactory of diskResult.presets) {
      const origin =
        fileOrFactory.origin ??
        (fileOrFactory.bankType === 'factory' ? 'factory' : 'file');
      bySlot.set(fileOrFactory.slotIndex, { ...fileOrFactory, origin });
    }

    for (const [slotIndex, hwPreset] of this.hardwarePresets.entries()) {
      const existing = bySlot.get(slotIndex);
      bySlot.set(slotIndex, {
        ...hwPreset,
        ...(existing?.sourceFile ? { sourceFile: existing.sourceFile } : {}),
        origin: 'hardware',
      });
    }

    const merged = Array.from(bySlot.values()).sort(
      (a, b) => a.slotIndex - b.slotIndex,
    );

    return {
      presets: merged,
      directory: diskResult.directory,
      directoryStatus: diskResult.directoryStatus,
      warnings: [...diskResult.warnings],
    };
  }

  private handleDiscoveryUpdate(result: PresetsResponse): void {
    this.diskPresetsResponse = result;
    this.presetsResponse = this.mergePresetsResponse(result);
    const currentState = this.getState();
    const currentPresets = this.getPresetsResponse();

    for (const listener of this.presetsListeners) {
      listener(currentPresets, currentState);
    }
    for (const listener of this.stateListeners) {
      listener(currentState, currentPresets);
    }
  }

  private emitStateChange(): void {
    const currentState = this.getState();
    const currentPresets = this.getPresetsResponse();
    for (const listener of this.stateListeners) {
      listener(currentState, currentPresets);
    }
  }
}
