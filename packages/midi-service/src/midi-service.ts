import {
  type AppErrorRecord,
  buildMg300AllPresetsQuerySysEx,
  buildMg300GlobalStatusQuerySysEx,
  buildMg300IdentityQuerySysEx,
  buildMg300PresetQuerySysEx,
  type ConfirmedDeviceState,
  type DeviceSyncStatus,
  isSafeReadOnlyMg300SysEx,
  MG300_EFFECT_BLOCK_CCS,
  MG300_MIDI_CC,
  type MidiConnectionState,
  type MidiPortInfo,
  parseMg300SysExMessage,
  type Preset,
  type SentCommandRecord,
  slotIndexToBankCoordinate,
  type VolumeTarget,
} from '@quicktone/shared';
import {
  type IMidiAdapter,
  isMg300PortName,
  MidiServiceError,
  type MidiServiceOptions,
  type MidiServiceStateSnapshot,
} from './types.js';

const VALIDATED_MG300_CCS = new Set<number>(Object.values(MG300_MIDI_CC));

const VOLUME_TARGET_TO_CC: Record<VolumeTarget, number> = {
  master_cc64: MG300_MIDI_CC.MASTER_VOLUME,
  patch_cc74: MG300_MIDI_CC.PATCH_LEVEL,
  expression_cc61: MG300_MIDI_CC.EXPRESSION_PEDAL,
};

const CC_TO_VOLUME_TARGET: Record<number, VolumeTarget> = {
  [MG300_MIDI_CC.MASTER_VOLUME]: 'master_cc64',
  [MG300_MIDI_CC.PATCH_LEVEL]: 'patch_cc74',
  [MG300_MIDI_CC.EXPRESSION_PEDAL]: 'expression_cc61',
};

function createEmptyConfirmedState(): ConfirmedDeviceState {
  return {
    presetId: null,
    slotIndex: null,
    volume: null,
    volumeTarget: null,
    confirmedAt: null,
  };
}

export class MidiService {
  private readonly adapter: IMidiAdapter;
  private readonly autoReconnect: boolean;
  private readonly reconnectIntervalMs: number;
  private readonly strictMg300Safety: boolean;
  private readonly defaultChannel: number;

  private connectionState: MidiConnectionState = 'disconnected';
  private connectedPortName: string | null = null;
  private lastTargetPortName: string | null = null;
  private availablePorts: MidiPortInfo[] = [];
  private syncStatus: DeviceSyncStatus = 'unknown';
  private confirmedState: ConfirmedDeviceState = createEmptyConfirmedState();
  private lastSentCommand: SentCommandRecord | null = null;
  private volumeTarget: VolumeTarget;
  private deviceFirmwareVersion: string | null = null;
  private lastError: AppErrorRecord | null = null;

  private commandCounter = 0;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private isReconnectAttemptInFlight = false;
  private readonly stateListeners = new Set<(state: MidiServiceStateSnapshot) => void>();
  private readonly presetDumpListeners = new Set<
    (event: { slotIndex: number; struct102: Uint8Array }) => void
  >();
  private readonly unsubscribeIncoming: () => void;
  private readonly unsubscribeDisconnect: () => void;

  constructor(adapter: IMidiAdapter, options: MidiServiceOptions = {}) {
    this.adapter = adapter;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 1500;
    this.strictMg300Safety = options.strictMg300Safety ?? true;
    this.defaultChannel = options.defaultChannel ?? 0;
    this.volumeTarget = options.defaultVolumeTarget ?? 'master_cc64';

    this.validateChannel(this.defaultChannel);

    this.unsubscribeIncoming = this.adapter.onIncomingMessage((bytes) => {
      this.handleIncomingMessage(bytes);
    });

    this.unsubscribeDisconnect = this.adapter.onDisconnect((reason) => {
      this.handleUnexpectedDisconnect(reason);
    });
  }

  public isConnected(): boolean {
    return this.connectionState === 'connected' && this.adapter.isConnected();
  }

  public getState(): MidiServiceStateSnapshot {
    return {
      connectionState: this.connectionState,
      connectedPortName: this.connectedPortName,
      availablePorts: this.availablePorts.map((p) => ({ ...p })),
      syncStatus: this.syncStatus,
      confirmedState: { ...this.confirmedState },
      lastSentCommand: this.lastSentCommand
        ? {
            ...this.lastSentCommand,
            midiBytes: [...this.lastSentCommand.midiBytes],
          }
        : null,
      volumeTarget: this.volumeTarget,
      deviceFirmwareVersion: this.deviceFirmwareVersion,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }

  public onPresetDump(
    listener: (event: { slotIndex: number; struct102: Uint8Array }) => void,
  ): () => void {
    this.presetDumpListeners.add(listener);
    return () => {
      this.presetDumpListeners.delete(listener);
    };
  }

  public onStateChange(listener: (state: MidiServiceStateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public async discoverPorts(): Promise<MidiPortInfo[]> {
    const ports = await this.adapter.listPorts();
    this.availablePorts = ports.map((port) => ({
      ...port,
      isMg300: port.isMg300 || isMg300PortName(port.name),
    }));
    this.emitStateChange();
    return this.availablePorts.map((p) => ({ ...p }));
  }

  public async connect(portName?: string): Promise<void> {
    this.stopReconnectLoop();
    this.connectionState = 'connecting';
    this.emitStateChange();

    try {
      await this.discoverPorts();

      let targetPort = portName?.trim();
      if (!targetPort) {
        const mg300Port = this.availablePorts.find((p) => p.isMg300);
        if (!mg300Port) {
          throw new MidiServiceError(
            'DEVICE_NOT_FOUND',
            'Nenhuma pedaleira NUX MG-300 (NUX NME-300) encontrada nas portas MIDI.',
          );
        }
        targetPort = mg300Port.name;
      }

      const opened = await this.adapter.openPort(targetPort);
      this.connectedPortName = opened.portName;
      this.lastTargetPortName = opened.portName;
      this.connectionState = 'connected';
      this.lastError = null;
      if (this.confirmedState.confirmedAt === null && this.lastSentCommand === null) {
        this.syncStatus = 'unknown';
      }
      this.emitStateChange();
    } catch (err) {
      const midiError = this.normalizeError(err, 'DEVICE_NOT_FOUND');
      this.connectionState = 'error';
      this.connectedPortName = null;
      this.syncStatus = 'unknown';
      this.lastError = midiError.toErrorRecord();
      this.emitStateChange();
      throw midiError;
    }
  }

  public async disconnect(): Promise<void> {
    this.stopReconnectLoop();
    this.lastTargetPortName = null;
    await this.adapter.closePort();
    this.connectionState = 'disconnected';
    this.connectedPortName = null;
    this.syncStatus = 'unknown';
    this.confirmedState = createEmptyConfirmedState();
    this.lastSentCommand = null;
    this.deviceFirmwareVersion = null;
    this.emitStateChange();
  }

  public dispose(): void {
    this.stopReconnectLoop();
    this.unsubscribeIncoming();
    this.unsubscribeDisconnect();
    this.stateListeners.clear();
    this.presetDumpListeners.clear();
  }

  public setVolumeTarget(target: VolumeTarget): void {
    this.volumeTarget = target;
    this.emitStateChange();
  }

  /**
   * Selects a preset on the NUX MG-300 using evidence-backed CC 0x3C (60) with slotIndex 0..71
   * (0..35 User 1A..9D, 36..71 Factory F1A..F9D).
   */
  public async selectMg300Preset(
    slotIndex: number,
    channel = this.defaultChannel,
  ): Promise<SentCommandRecord> {
    this.validateChannel(channel);
    this.validateIntegerRange(slotIndex, 0, 71, 'MG-300 preset slotIndex');
    this.ensureConnected();

    const coordinate = slotIndexToBankCoordinate(slotIndex);
    const bytes = [0xb0 | channel, MG300_MIDI_CC.PRESET_SELECT, slotIndex];

    const record: SentCommandRecord = {
      commandId: this.nextCommandId('preset'),
      type: 'preset_select',
      presetId: coordinate.displayBank,
      slotIndex,
      midiBytes: bytes,
      sentAt: new Date().toISOString(),
      confirmedByDevice: false,
    };

    return this.transmitCommand(record, [bytes]);
  }

  public async selectPreset(
    slotIndex: number,
    channel = this.defaultChannel,
  ): Promise<SentCommandRecord> {
    return this.selectMg300Preset(slotIndex, channel);
  }

  public async selectPresetByMapping(
    preset: Pick<Preset, 'id' | 'slotIndex' | 'midiMapping'>,
  ): Promise<SentCommandRecord> {
    const { midiMapping } = preset;
    if (midiMapping.protocol === 'mg300-cc60') {
      return this.selectMg300Preset(
        midiMapping.ccValue ?? preset.slotIndex,
        midiMapping.channel,
      );
    }

    if (midiMapping.bankMsb !== undefined && midiMapping.bankLsb !== undefined) {
      await this.sendBankSelect(
        midiMapping.bankMsb,
        midiMapping.bankLsb,
        midiMapping.channel,
      );
    }

    return this.sendProgramChange(
      midiMapping.programNumber ?? preset.slotIndex,
      midiMapping.channel,
    );
  }

  /**
   * Adjusts volume on the NUX MG-300 using one of the 3 firmware-verified CCs:
   * - 'master_cc64' -> CC 0x40 (64) Global Master Volume (0..100)
   * - 'patch_cc74' -> CC 0x4A (74) Per-Preset Patch Level P.LVL (0..100)
   * - 'expression_cc61' -> CC 0x3D (61) Expression Pedal (0..100)
   */
  public async setVolume(
    volume: number,
    target: VolumeTarget = this.volumeTarget,
    channel = this.defaultChannel,
  ): Promise<SentCommandRecord> {
    this.validateChannel(channel);
    this.validateIntegerRange(volume, 0, 100, 'MG-300 volume');
    this.ensureConnected();

    const ccNumber = VOLUME_TARGET_TO_CC[target];
    if (ccNumber === undefined) {
      throw new MidiServiceError(
        'INVALID_MIDI_VALUE',
        `Alvo de volume inválido: "${String(target)}".`,
      );
    }

    this.volumeTarget = target;
    const bytes = [0xb0 | channel, ccNumber, volume];

    const record: SentCommandRecord = {
      commandId: this.nextCommandId('vol'),
      type: 'volume_change',
      volume,
      volumeTarget: target,
      midiBytes: bytes,
      sentAt: new Date().toISOString(),
      confirmedByDevice: false,
    };

    return this.transmitCommand(record, [bytes]);
  }

  /**
   * Sends a standard MIDI Program Change (0xC0 | channel, program 0..127).
   */
  public async sendProgramChange(
    program: number,
    channel = this.defaultChannel,
  ): Promise<SentCommandRecord> {
    this.validateChannel(channel);
    this.validateIntegerRange(program, 0, 127, 'MIDI Program Change');
    this.ensureConnected();

    const bytes = [0xc0 | channel, program];
    const record: SentCommandRecord = {
      commandId: this.nextCommandId('pc'),
      type: 'program_change',
      slotIndex: program,
      midiBytes: bytes,
      sentAt: new Date().toISOString(),
      confirmedByDevice: false,
    };

    return this.transmitCommand(record, [bytes]);
  }

  /**
   * Sends standard MIDI Bank Select MSB (CC 0x00) and LSB (CC 0x20).
   */
  public async sendBankSelect(
    msb: number,
    lsb: number,
    channel = this.defaultChannel,
  ): Promise<SentCommandRecord> {
    this.validateChannel(channel);
    this.validateIntegerRange(msb, 0, 127, 'MIDI Bank Select MSB');
    this.validateIntegerRange(lsb, 0, 127, 'MIDI Bank Select LSB');
    this.ensureConnected();

    const msbBytes = [0xb0 | channel, MG300_MIDI_CC.BANK_SELECT_MSB, msb];
    const lsbBytes = [0xb0 | channel, MG300_MIDI_CC.BANK_SELECT_LSB, lsb];

    const record: SentCommandRecord = {
      commandId: this.nextCommandId('bank'),
      type: 'bank_select',
      midiBytes: [...msbBytes, ...lsbBytes],
      sentAt: new Date().toISOString(),
      confirmedByDevice: false,
    };

    return this.transmitCommand(record, [msbBytes, lsbBytes]);
  }

  /**
   * Sends a validated MIDI Control Change message (0xB0 | channel, cc, value).
   * Blocks effect block CCs (CC 1..10, such as CC 7 which overwrites Delay on MG-300!)
   * and unvalidated CCs when `strictMg300Safety` is enabled.
   */
  public async sendControlChange(
    cc: number,
    value: number,
    channel = this.defaultChannel,
  ): Promise<SentCommandRecord> {
    this.validateChannel(channel);
    this.validateIntegerRange(cc, 0, 127, 'MIDI CC number');
    this.validateIntegerRange(value, 0, 127, 'MIDI CC value');

    if (this.strictMg300Safety) {
      if (MG300_EFFECT_BLOCK_CCS.has(cc)) {
        throw new MidiServiceError(
          'UNVALIDATED_MESSAGE_BLOCKED',
          `CC ${cc} bloqueado por segurança: na NUX MG-300, CC 1..10 alteram/desativam blocos de efeito (CC 7 sobrescreve o modelo de Delay). Use CC 64 (0x40), CC 74 (0x4A) ou CC 61 (0x3D) para volume.`,
        );
      }

      if (!VALIDATED_MG300_CCS.has(cc)) {
        throw new MidiServiceError(
          'UNVALIDATED_MESSAGE_BLOCKED',
          `CC ${cc} (0x${cc.toString(16).toUpperCase()}) bloqueado: mensagem MIDI não validada para a NUX MG-300.`,
        );
      }

      if (cc === MG300_MIDI_CC.PRESET_SELECT && value > 71) {
        throw new MidiServiceError(
          'INVALID_MIDI_VALUE',
          `Valor de preset MG-300 inválido (${value}): CC 0x3C aceita apenas slots 0..71.`,
        );
      }

      if (
        (cc === MG300_MIDI_CC.MASTER_VOLUME ||
          cc === MG300_MIDI_CC.PATCH_LEVEL ||
          cc === MG300_MIDI_CC.EXPRESSION_PEDAL) &&
        value > 100
      ) {
        throw new MidiServiceError(
          'INVALID_MIDI_VALUE',
          `Valor de volume MG-300 inválido (${value}): CC 0x${cc.toString(16).toUpperCase()} aceita apenas 0..100.`,
        );
      }
    }

    this.ensureConnected();

    const bytes = [0xb0 | channel, cc, value];
    const volumeTarget = CC_TO_VOLUME_TARGET[cc];
    const isPresetSelect = cc === MG300_MIDI_CC.PRESET_SELECT && value <= 71;

    const record: SentCommandRecord = {
      commandId: this.nextCommandId('cc'),
      type: isPresetSelect
        ? 'preset_select'
        : volumeTarget
          ? 'volume_change'
          : 'control_change',
      ...(isPresetSelect
        ? {
            slotIndex: value,
            presetId: slotIndexToBankCoordinate(value).displayBank,
          }
        : {}),
      ...(volumeTarget
        ? {
            volume: value,
            volumeTarget,
          }
        : {}),
      midiBytes: bytes,
      sentAt: new Date().toISOString(),
      confirmedByDevice: false,
    };

    return this.transmitCommand(record, [bytes]);
  }

  private async transmitCommand(
    record: SentCommandRecord,
    packets: number[][],
  ): Promise<SentCommandRecord> {
    const previousLastSent = this.lastSentCommand;
    const previousSyncStatus = this.syncStatus;

    // Set tri-state to 'command_sent_unconfirmed' before transmission.
    // Note: confirmedState is NEVER mutated here; only incoming MIDI IN from hardware can confirm state.
    this.lastSentCommand = record;
    this.syncStatus = 'command_sent_unconfirmed';

    try {
      for (const packet of packets) {
        await this.adapter.sendBytes(packet);
      }
      this.lastError = null;
      this.emitStateChange();
      return this.lastSentCommand ? { ...this.lastSentCommand } : record;
    } catch (err) {
      this.lastSentCommand = previousLastSent;
      this.syncStatus = previousSyncStatus;
      const midiError = this.normalizeError(err, 'TRANSMISSION_FAILED');
      this.lastError = midiError.toErrorRecord();
      this.emitStateChange();
      throw midiError;
    }
  }

  public async sendReadOnlySysEx(bytes: number[]): Promise<void> {
    if (this.strictMg300Safety && !isSafeReadOnlyMg300SysEx(bytes)) {
      throw new MidiServiceError(
        'UNVALIDATED_MESSAGE_BLOCKED',
        'Frame SysEx bloqueado por segurança: apenas consultas read-only validadas (0x00, 0x19, 0x07, 0x13) são permitidas.',
      );
    }

    this.ensureConnected();
    try {
      await this.adapter.sendBytes([...bytes]);
    } catch (err) {
      const midiError = this.normalizeError(err, 'TRANSMISSION_FAILED');
      this.lastError = midiError.toErrorRecord();
      this.emitStateChange();
      throw midiError;
    }
  }

  public async queryDeviceIdentity(): Promise<void> {
    return this.sendReadOnlySysEx(buildMg300IdentityQuerySysEx());
  }

  public async queryGlobalStatus(): Promise<void> {
    return this.sendReadOnlySysEx(buildMg300GlobalStatusQuerySysEx());
  }

  public async queryPresetSlot(slotIndex: number): Promise<void> {
    return this.sendReadOnlySysEx(buildMg300PresetQuerySysEx(slotIndex));
  }

  public async queryAllPresets(): Promise<void> {
    return this.sendReadOnlySysEx(buildMg300AllPresetsQuerySysEx());
  }

  private handleIncomingMessage(bytes: number[]): void {
    if (bytes.length >= 8 && bytes[0] === 0xf0 && bytes[bytes.length - 1] === 0xf7) {
      this.handleIncomingSysEx(bytes);
      return;
    }

    if (bytes.length < 3) {
      return;
    }

    const status = bytes[0]! & 0xf0;
    const cc = bytes[1]!;
    const value = bytes[2]!;

    if (status !== 0xb0) {
      return;
    }

    const now = new Date().toISOString();

    if (cc === MG300_MIDI_CC.PRESET_SELECT && value >= 0 && value <= 71) {
      const coordinate = slotIndexToBankCoordinate(value);
      this.confirmedState = {
        ...this.confirmedState,
        slotIndex: value,
        presetId: coordinate.displayBank,
        confirmedAt: now,
      };

      if (
        this.lastSentCommand &&
        (this.lastSentCommand.type === 'preset_select' ||
          this.lastSentCommand.type === 'control_change')
      ) {
        if (this.lastSentCommand.slotIndex === value) {
          this.lastSentCommand = {
            ...this.lastSentCommand,
            confirmedByDevice: true,
          };
        } else if (!this.lastSentCommand.confirmedByDevice) {
          this.lastSentCommand = null;
        }
      }

      const hasPendingUnconfirmedCommand =
        this.lastSentCommand !== null && !this.lastSentCommand.confirmedByDevice;
      this.syncStatus = hasPendingUnconfirmedCommand
        ? 'command_sent_unconfirmed'
        : 'confirmed';
      this.emitStateChange();
      return;
    }

    const matchedVolumeTarget = CC_TO_VOLUME_TARGET[cc];
    if (matchedVolumeTarget && value >= 0 && value <= 100) {
      this.confirmedState = {
        ...this.confirmedState,
        volume: value,
        volumeTarget: matchedVolumeTarget,
        confirmedAt: now,
      };

      if (
        this.lastSentCommand &&
        this.lastSentCommand.volume === value &&
        this.lastSentCommand.volumeTarget === matchedVolumeTarget
      ) {
        this.lastSentCommand = {
          ...this.lastSentCommand,
          confirmedByDevice: true,
        };
      }

      const hasPendingUnconfirmedCommand =
        this.lastSentCommand !== null && !this.lastSentCommand.confirmedByDevice;
      if (!hasPendingUnconfirmedCommand) {
        this.syncStatus = 'confirmed';
      }

      this.emitStateChange();
    }
  }

  private handleIncomingSysEx(bytes: number[]): void {
    const parsed = parseMg300SysExMessage(bytes);
    if (!parsed) {
      return;
    }

    const now = new Date().toISOString();

    if (parsed.kind === 'identity') {
      const versionLabel = [parsed.deviceName, parsed.firmwareVersion]
        .filter((s) => s.length > 0)
        .join(' · ');
      this.deviceFirmwareVersion = versionLabel.length > 0 ? versionLabel : null;
      this.emitStateChange();
      return;
    }

    if (parsed.kind === 'global_status') {
      const hasValidSlot = parsed.slotIndex >= 0 && parsed.slotIndex <= 71;
      const coordinate = hasValidSlot ? slotIndexToBankCoordinate(parsed.slotIndex) : null;
      const validVolume =
        parsed.masterVolume >= 0 && parsed.masterVolume <= 100
          ? parsed.masterVolume
          : this.confirmedState.volume;

      this.confirmedState = {
        ...this.confirmedState,
        ...(coordinate
          ? {
              slotIndex: coordinate.slotIndex,
              presetId: coordinate.displayBank,
            }
          : {}),
        ...(validVolume !== null && validVolume !== undefined
          ? {
              volume: validVolume,
              volumeTarget: 'master_cc64',
            }
          : {}),
        confirmedAt: now,
      };

      if (this.lastSentCommand) {
        if (
          this.lastSentCommand.type === 'preset_select' &&
          this.lastSentCommand.slotIndex === parsed.slotIndex
        ) {
          this.lastSentCommand = {
            ...this.lastSentCommand,
            confirmedByDevice: true,
          };
        } else if (
          this.lastSentCommand.type === 'volume_change' &&
          this.lastSentCommand.volumeTarget === 'master_cc64' &&
          this.lastSentCommand.volume === parsed.masterVolume
        ) {
          this.lastSentCommand = {
            ...this.lastSentCommand,
            confirmedByDevice: true,
          };
        }
      }

      const hasPendingUnconfirmedCommand =
        this.lastSentCommand !== null && !this.lastSentCommand.confirmedByDevice;
      if (!hasPendingUnconfirmedCommand) {
        this.syncStatus = 'confirmed';
      }

      this.emitStateChange();
      return;
    }

    if (parsed.kind === 'preset_dump') {
      for (const listener of this.presetDumpListeners) {
        listener({
          slotIndex: parsed.slotIndex,
          struct102: parsed.struct102,
        });
      }

      const patchLevel = parsed.struct102[101];
      if (
        patchLevel !== undefined &&
        patchLevel >= 0 &&
        patchLevel <= 100 &&
        this.lastSentCommand?.type === 'volume_change' &&
        this.lastSentCommand.volumeTarget === 'patch_cc74' &&
        this.lastSentCommand.volume === patchLevel &&
        this.confirmedState.slotIndex === parsed.slotIndex
      ) {
        this.confirmedState = {
          ...this.confirmedState,
          volume: patchLevel,
          volumeTarget: 'patch_cc74',
          confirmedAt: now,
        };
        this.lastSentCommand = {
          ...this.lastSentCommand,
          confirmedByDevice: true,
        };
        this.syncStatus = 'confirmed';
        this.emitStateChange();
      }
    }
  }

  private handleUnexpectedDisconnect(reason?: string): void {
    const targetPortToReconnect = this.lastTargetPortName ?? this.connectedPortName;
    this.connectedPortName = null;
    this.syncStatus = 'unknown';
    this.confirmedState = createEmptyConfirmedState();
    this.lastSentCommand = null;
    this.deviceFirmwareVersion = null;
    this.lastError = {
      code: 'DISCONNECTED',
      message: reason ?? 'Conexão USB-MIDI com a pedaleira foi perdida.',
      timestamp: new Date().toISOString(),
    };

    if (this.autoReconnect && targetPortToReconnect) {
      this.lastTargetPortName = targetPortToReconnect;
      this.connectionState = 'reconnecting';
      this.emitStateChange();
      this.startReconnectLoop(targetPortToReconnect);
    } else {
      this.connectionState = 'disconnected';
      this.emitStateChange();
    }
  }

  private startReconnectLoop(portName: string): void {
    this.stopReconnectLoop();
    this.reconnectTimer = setInterval(() => {
      if (this.isReconnectAttemptInFlight) {
        return;
      }
      this.isReconnectAttemptInFlight = true;
      void this.tryReconnectOnce(portName).finally(() => {
        this.isReconnectAttemptInFlight = false;
      });
    }, this.reconnectIntervalMs);
  }

  private async tryReconnectOnce(portName: string): Promise<void> {
    if (this.connectionState !== 'reconnecting') {
      this.stopReconnectLoop();
      return;
    }

    try {
      const ports = await this.adapter.listPorts();
      this.availablePorts = ports.map((port) => ({
        ...port,
        isMg300: port.isMg300 || isMg300PortName(port.name),
      }));

      const candidate =
        this.availablePorts.find(
          (p) => p.name.toLowerCase() === portName.toLowerCase(),
        ) ?? this.availablePorts.find((p) => p.isMg300);

      if (!candidate) {
        return;
      }

      const opened = await this.adapter.openPort(candidate.name);
      this.stopReconnectLoop();
      this.connectedPortName = opened.portName;
      this.lastTargetPortName = opened.portName;
      this.connectionState = 'connected';
      this.syncStatus = 'unknown';
      this.confirmedState = createEmptyConfirmedState();
      this.lastSentCommand = null;
      this.lastError = null;
      this.emitStateChange();
    } catch {
      // Remain in 'reconnecting' state until next interval tick
    }
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer !== null) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private ensureConnected(): void {
    if (!this.adapter.isConnected() || this.connectionState !== 'connected') {
      throw new MidiServiceError(
        'DISCONNECTED',
        'Operação MIDI recusada: nenhum dispositivo MIDI está conectado.',
      );
    }
  }

  private validateChannel(channel: number): void {
    this.validateIntegerRange(channel, 0, 15, 'MIDI channel');
  }

  private validateIntegerRange(
    value: number,
    min: number,
    max: number,
    label: string,
  ): void {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new MidiServiceError(
        'INVALID_MIDI_VALUE',
        `Valor inválido para ${label} (${String(value)}): esperado inteiro entre ${min} e ${max}.`,
      );
    }
  }

  private normalizeError(
    err: unknown,
    fallbackCode: MidiServiceError['code'],
  ): MidiServiceError {
    if (err instanceof MidiServiceError) {
      return err;
    }
    return new MidiServiceError(
      fallbackCode,
      err instanceof Error ? err.message : String(err),
    );
  }

  private nextCommandId(prefix: string): string {
    this.commandCounter += 1;
    return `${prefix}-${Date.now()}-${this.commandCounter}`;
  }

  private emitStateChange(): void {
    const snapshot = this.getState();
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }
}
