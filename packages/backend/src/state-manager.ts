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
  isValidMg300UserSlot,
  parseBankLabel,
} from '@quicktone/shared';
import {
  QuickToneDiscoveryService,
  buildPresetFromStruct102,
  createFactoryPresets,
  createUserPlaceholderPresets,
} from '@quicktone/reader';
import {
  type IMidiAdapter,
  MidiService,
  MidiServiceError,
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

function getLanAddressPriority(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (ip.startsWith('172.')) return 2;
  return 3;
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
  return Array.from(new Set(addresses)).sort(
    (a, b) => getLanAddressPriority(a) - getLanAddressPriority(b),
  );
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
  private readonly useFilesystemDiscovery: boolean;
  private readonly presetsDirectoryOption: string | null;
  private authToken: string | null;
  private lanUrls: string[];
  private diskPresetsResponse: PresetsResponse;
  private presetsResponse: PresetsResponse;
  private readonly hardwarePresets = new Map<number, Preset>();
  private readonly hardwareStructs = new Map<number, Uint8Array>();
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
    const includeFactory = options.includeFactoryPresets ?? true;
    this.presetsDirectoryOption = options.presetsDirectory ?? null;
    this.useFilesystemDiscovery =
      options.discoveryService !== undefined ||
      (options.presetsDirectory !== undefined && options.presetsDirectory !== null);

    this.discoveryService =
      options.discoveryService ??
      new QuickToneDiscoveryService({
        directoryPath: options.presetsDirectory,
        includeFactoryPresets: includeFactory,
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
    this.diskPresetsResponse = this.useFilesystemDiscovery
      ? this.discoveryService.getLastResult()
      : {
          presets: includeFactory ? createFactoryPresets() : [],
          directory: null,
          directoryStatus: 'ok',
          warnings: [],
        };
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
        // Preserve last valid hardwarePresets across transient disconnects so valid data is never wiped
      }

      this.emitStateChange();

      if (becameConnected && this.enableSysExSync) {
        void this.syncHardwareState();
      }
    });

    this.unsubscribePresetDump = this.midiService.onPresetDump(({ slotIndex, struct102 }) => {
      this.handleHardwarePresetDump(slotIndex, struct102);
    });

    this.unsubscribeWatcher = this.useFilesystemDiscovery
      ? this.discoveryService.watchDirectory((result) => {
          this.handleDiscoveryUpdate(result);
        })
      : () => {};
  }

  public async initialize(force = false): Promise<void> {
    if (this.initialized && !force) {
      return;
    }
    this.initialized = true;
    if (this.useFilesystemDiscovery) {
      this.diskPresetsResponse = await this.discoveryService.discover();
      this.presetsResponse = this.mergePresetsResponse(this.diskPresetsResponse);
      this.unsubscribeWatcher();
      this.unsubscribeWatcher = this.discoveryService.watchDirectory((result) => {
        this.handleDiscoveryUpdate(result);
      });
    } else {
      this.presetsResponse = this.mergePresetsResponse(this.diskPresetsResponse);
    }

    if (this.autoConnectMidiOnInit) {
      try {
        await this.midiService.connect();
      } catch {
        // Permanece em erro/desconectado caso nenhuma pedaleira esteja conectada no boot
      }
    } else {
      await this.midiService.discoverPorts();
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

  public getPresetsDirectory(): string | null {
    return this.presetsResponse.directory ?? this.presetsDirectoryOption ?? null;
  }

  public getKnownUserStructs(): ReadonlyMap<number, Uint8Array> {
    const copy = new Map<number, Uint8Array>();
    for (const [slot, struct] of this.hardwareStructs.entries()) {
      if (isValidMg300UserSlot(slot)) {
        copy.set(slot, Uint8Array.from(struct));
      }
    }
    return copy;
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
    if (this.useFilesystemDiscovery) {
      const result = await this.discoveryService.reload();
      if (this.diskPresetsResponse !== result) {
        this.handleDiscoveryUpdate(result);
      }
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
    if (request.target !== undefined && request.target !== 'master_cc64') {
      throw new MidiServiceError(
        'INVALID_MIDI_VALUE',
        'Apenas o Volume Master é permitido para controle de volume.',
      );
    }
    const command = await this.midiService.setVolume(request.volume, 'master_cc64');
    if (this.enableSysExSync) {
      this.scheduleHardwareReadback('global');
    }
    return {
      state: this.getState(),
      command,
    };
  }

  public setVolumeTarget(target: VolumeTarget): { state: ControllerState } {
    if (target !== 'master_cc64') {
      throw new MidiServiceError(
        'INVALID_MIDI_VALUE',
        'Apenas o Volume Master é suportado.',
      );
    }
    this.midiService.setVolumeTarget('master_cc64');
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
    this.hardwareStructs.set(slotIndex, Uint8Array.from(struct102));
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

  /**
   * Immediately reflects a verified `0x0E` User slot write in the merged preset library
   * and notifies subscribed WebSocket clients.
   */
  public applySavedHardwarePreset(slotIndex: number, struct102: Uint8Array): void {
    if (!isValidMg300UserSlot(slotIndex)) {
      return;
    }
    this.hardwareStructs.set(slotIndex, Uint8Array.from(struct102));
    const preset = buildPresetFromStruct102(struct102, slotIndex, {
      origin: 'hardware',
    });
    this.hardwarePresets.set(slotIndex, preset);
    if (this.hardwareDumpFlushTimer !== null) {
      clearTimeout(this.hardwareDumpFlushTimer);
      this.hardwareDumpFlushTimer = null;
    }
    this.handleDiscoveryUpdate(this.diskPresetsResponse);
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
