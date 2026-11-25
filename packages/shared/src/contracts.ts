import { z } from 'zod';

export const PatchLetterSchema = z.enum(['A', 'B', 'C', 'D']);

export const PresetBankTypeSchema = z.enum(['user', 'factory']);

export const MidiProtocolModeSchema = z.enum(['mg300-cc60', 'standard-pc']);
export type MidiProtocolMode = z.infer<typeof MidiProtocolModeSchema>;

export const VolumeTargetSchema = z.enum([
  'master_cc64', // Global Master Volume (CC 0x40 = 64, range 0..100, verified in FUN_08038d04 & FUN_08016b54)
  'patch_cc74', // Per-Preset Patch Level P.LVL (CC 0x4A = 74, range 0..100, verified in FUN_08038d04 & FUN_08016728)
  'expression_cc61', // Expression Pedal position (CC 0x3D = 61, range 0..100, verified in FUN_08038d04 & FUN_08016d76)
]);
export type VolumeTarget = z.infer<typeof VolumeTargetSchema>;

export const PresetMidiMappingSchema = z.object({
  protocol: MidiProtocolModeSchema,
  channel: z.number().int().min(0).max(15).default(0),
  ccNumber: z.number().int().min(0).max(127).optional(),
  ccValue: z.number().int().min(0).max(127).optional(),
  programNumber: z.number().int().min(0).max(127).optional(),
  bankMsb: z.number().int().min(0).max(127).optional(),
  bankLsb: z.number().int().min(0).max(127).optional(),
});
export type PresetMidiMapping = z.infer<typeof PresetMidiMappingSchema>;

export const PresetSignalChainSchema = z.object({
  compEnabled: z.boolean(),
  efxEnabled: z.boolean(),
  ampEnabled: z.boolean(),
  irEnabled: z.boolean(),
  eqEnabled: z.boolean(),
  nrEnabled: z.boolean(),
  modEnabled: z.boolean(),
  dlyEnabled: z.boolean(),
  rvbEnabled: z.boolean(),
  pedalEnabled: z.boolean().optional(),
});
export type PresetSignalChain = z.infer<typeof PresetSignalChainSchema>;

export const PresetOriginSchema = z.enum(['hardware', 'file', 'factory', 'placeholder']);
export type PresetOrigin = z.infer<typeof PresetOriginSchema>;

export const PresetSchema = z.object({
  id: z.string().min(1), // e.g., "1A", "F1A"
  slotIndex: z.number().int().min(0).max(127), // 0..35 User, 36..71 Factory
  bankType: PresetBankTypeSchema,
  bankNumber: z.number().int().min(1).max(32),
  patchLetter: PatchLetterSchema,
  displayBank: z.string().min(2), // e.g., "1A", "F1A"
  name: z.string().min(1),
  patchVolume: z.number().int().min(0).max(100).default(50),
  irVolume: z.number().int().min(0).max(100).optional(),
  sourceFile: z.string().optional(),
  origin: PresetOriginSchema.optional(),
  signalChain: PresetSignalChainSchema.optional(),
  isDuplicate: z.boolean().default(false),
  updatedAt: z.string(),
  midiMapping: PresetMidiMappingSchema,
});
export type Preset = z.infer<typeof PresetSchema>;

/**
 * Tri-state synchronization status required by Section 4:
 * - 'confirmed': Hardware explicitly confirmed the current state via MIDI IN.
 * - 'command_sent_unconfirmed': Command was transmitted via MIDI OUT, awaiting hardware confirmation.
 * - 'unknown': Initial state or after disconnect before telemetry/command.
 */
export const DeviceSyncStatusSchema = z.enum([
  'confirmed',
  'command_sent_unconfirmed',
  'unknown',
]);
export type DeviceSyncStatus = z.infer<typeof DeviceSyncStatusSchema>;

export const ConfirmedDeviceStateSchema = z.object({
  presetId: z.string().nullable(),
  slotIndex: z.number().int().min(0).max(127).nullable(),
  volume: z.number().int().min(0).max(127).nullable(),
  volumeTarget: VolumeTargetSchema.nullable(),
  confirmedAt: z.string().nullable(),
});
export type ConfirmedDeviceState = z.infer<typeof ConfirmedDeviceStateSchema>;

export const SentCommandTypeSchema = z.enum([
  'preset_select',
  'volume_change',
  'program_change',
  'bank_select',
  'control_change',
]);
export type SentCommandType = z.infer<typeof SentCommandTypeSchema>;

export const SentCommandRecordSchema = z.object({
  commandId: z.string(),
  type: SentCommandTypeSchema,
  presetId: z.string().optional(),
  slotIndex: z.number().int().min(0).max(127).optional(),
  volume: z.number().int().min(0).max(127).optional(),
  volumeTarget: VolumeTargetSchema.optional(),
  midiBytes: z.array(z.number().int().min(0).max(255)),
  sentAt: z.string(),
  confirmedByDevice: z.boolean(),
});
export type SentCommandRecord = z.infer<typeof SentCommandRecordSchema>;

export const MidiConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'error',
]);
export type MidiConnectionState = z.infer<typeof MidiConnectionStateSchema>;

export const MidiPortInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  direction: z.enum(['in', 'out', 'duplex']),
  isMg300: z.boolean(),
});
export type MidiPortInfo = z.infer<typeof MidiPortInfoSchema>;

export const MidiErrorCodeSchema = z.enum([
  'DEVICE_NOT_FOUND',
  'PORT_BUSY',
  'DISCONNECTED',
  'INVALID_MIDI_VALUE',
  'UNVALIDATED_MESSAGE_BLOCKED',
  'TRANSMISSION_FAILED',
]);
export type MidiErrorCode = z.infer<typeof MidiErrorCodeSchema>;

export const AppErrorRecordSchema = z.object({
  code: z.string(),
  message: z.string(),
  timestamp: z.string(),
});
export type AppErrorRecord = z.infer<typeof AppErrorRecordSchema>;

export const PresetsDirectoryStatusSchema = z.enum([
  'ok',
  'directory_not_found',
  'unconfigured',
  'error',
]);
export type PresetsDirectoryStatus = z.infer<typeof PresetsDirectoryStatusSchema>;

export const ControllerStateSchema = z.object({
  connectionState: MidiConnectionStateSchema,
  connectedPortName: z.string().nullable(),
  availablePorts: z.array(MidiPortInfoSchema),
  syncStatus: DeviceSyncStatusSchema,
  confirmedState: ConfirmedDeviceStateSchema,
  lastSentCommand: SentCommandRecordSchema.nullable(),
  volumeTarget: VolumeTargetSchema,
  presetsDirectory: z.string().nullable(),
  presetsDirectoryStatus: PresetsDirectoryStatusSchema,
  includeFactoryPresets: z.boolean().optional(),
  presetCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  authRequired: z.boolean(),
  lastError: AppErrorRecordSchema.nullable(),
  deviceFirmwareVersion: z.string().nullable().optional(),
  lanUrls: z.array(z.string()).optional(),
});
export type ControllerState = z.infer<typeof ControllerStateSchema>;

// REST API Payloads

export const SelectPresetRequestSchema = z
  .object({
    presetId: z.string().min(1).optional(),
    slotIndex: z.number().int().min(0).max(71).optional(),
  })
  .refine((data) => data.presetId !== undefined || data.slotIndex !== undefined, {
    message: 'Either presetId or slotIndex must be provided',
  });
export type SelectPresetRequest = z.infer<typeof SelectPresetRequestSchema>;

export const UpdateVolumeRequestSchema = z.object({
  volume: z.number().int().min(0).max(100),
  target: VolumeTargetSchema.optional(),
});
export type UpdateVolumeRequest = z.infer<typeof UpdateVolumeRequestSchema>;

export const UpdateVolumeTargetRequestSchema = z.object({
  target: VolumeTargetSchema,
});
export type UpdateVolumeTargetRequest = z.infer<typeof UpdateVolumeTargetRequestSchema>;

export const ConnectMidiRequestSchema = z.object({
  portName: z.string().min(1).optional(),
});
export type ConnectMidiRequest = z.infer<typeof ConnectMidiRequestSchema>;

export const ConfigurePresetsDirRequestSchema = z
  .object({
    directoryPath: z.string().min(1).optional(),
    includeFactoryPresets: z.boolean().optional(),
  })
  .refine(
    (data) => data.directoryPath !== undefined || data.includeFactoryPresets !== undefined,
    {
      message: 'Either directoryPath or includeFactoryPresets must be provided',
    },
  );
export type ConfigurePresetsDirRequest = z.infer<typeof ConfigurePresetsDirRequestSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('quicktone-web-controller'),
  timestamp: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  midiConnection: MidiConnectionStateSchema,
  syncStatus: DeviceSyncStatusSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const PresetsResponseSchema = z.object({
  presets: z.array(PresetSchema),
  directory: z.string().nullable(),
  directoryStatus: PresetsDirectoryStatusSchema,
  warnings: z.array(z.string()),
});
export type PresetsResponse = z.infer<typeof PresetsResponseSchema>;

// WebSocket Messages

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state_sync'),
    state: ControllerStateSchema,
    presets: z.array(PresetSchema).optional(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('presets_updated'),
    presets: z.array(PresetSchema),
    directory: z.string().nullable(),
    directoryStatus: PresetsDirectoryStatusSchema,
    warnings: z.array(z.string()),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    error: AppErrorRecordSchema,
  }),
  z.object({
    type: z.literal('pong'),
    timestamp: z.string(),
  }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ping'),
  }),
  z.object({
    type: z.literal('request_sync'),
  }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
