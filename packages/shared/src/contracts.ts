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

export const MasterVolumeTargetSchema = z.literal('master_cc64');
export type MasterVolumeTarget = z.infer<typeof MasterVolumeTargetSchema>;

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

export const MidiAdapterModeSchema = z.enum(['hardware', 'mock']);
export type MidiAdapterMode = z.infer<typeof MidiAdapterModeSchema>;

export const ControllerStateSchema = z.object({
  connectionState: MidiConnectionStateSchema,
  midiAdapterMode: MidiAdapterModeSchema.optional(),
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
  target: MasterVolumeTargetSchema.optional(),
});
export type UpdateVolumeRequest = z.infer<typeof UpdateVolumeRequestSchema>;

export const UpdateVolumeTargetRequestSchema = z.object({
  target: MasterVolumeTargetSchema,
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

// Pairing & Mobile Session Contracts

export const PairingSessionInfoSchema = z.object({
  sessionId: z.string(),
  deviceName: z.string(),
  remoteIp: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastActivityAt: z.string(),
});
export type PairingSessionInfo = z.infer<typeof PairingSessionInfoSchema>;

export const TrustedDeviceInfoSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  remoteIp: z.string(),
  createdAt: z.string(),
  lastConnectedAt: z.string(),
  isCurrentlyActive: z.boolean(),
});
export type TrustedDeviceInfo = z.infer<typeof TrustedDeviceInfoSchema>;

export const RemoveTrustedDevicePayloadSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
});
export type RemoveTrustedDevicePayload = z.infer<typeof RemoveTrustedDevicePayloadSchema>;

export const ExperimentalSaveResultSchema = z.object({
  targetSlot: z.number().int().min(0).max(35),
  displayBank: z.string(),
  ackReceived: z.boolean(),
  verified: z.boolean(),
  mismatchedOffsets: z.array(z.number().int()),
  backupPath: z.string(),
  savedAt: z.string(),
});
export type ExperimentalSaveResult = z.infer<typeof ExperimentalSaveResultSchema>;

export const ExperimentalSourceModeSchema = z.enum(['hardware', 'draft', 'imported']);
export type ExperimentalSourceMode = z.infer<typeof ExperimentalSourceModeSchema>;

export const ExperimentalEditStateSchema = z.object({
  slot: z.number().int().min(0).max(35),
  loaded: z.boolean(),
  busy: z.boolean(),
  dirty: z.boolean(),
  sourceMode: ExperimentalSourceModeSchema,
  sourceFileName: z.string().nullable(),
  presetName: z.string().nullable(),
  bpm: z.number().int().min(40).max(240),
  timeFlag: z.number().int().min(0).max(1),
  ampParams: z.array(z.number().int().min(0).max(127)),
  blocksEnabled: z.array(z.boolean()),
  blockModels: z.record(z.string(), z.number().int().min(0).max(127)),
  blockParams: z.record(z.string(), z.array(z.number().int().min(0).max(127))),
  cabEnabled: z.boolean(),
  cabModel: z.number().int().min(0).max(127),
  micModel: z.number().int().min(0).max(127),
  irCut: z.number().int().min(0).max(2),
  irVolume: z.number().int().min(0).max(40),
  patchVolume: z.number().int().min(0).max(100),
  hasUserIr: z.boolean(),
  userIrName: z.string().nullable(),
  userIrWarning: z.string().nullable(),
  lastSave: ExperimentalSaveResultSchema.nullable(),
});
export type ExperimentalEditState = z.infer<typeof ExperimentalEditStateSchema>;

export const PendingPairingRequestSchema = z.object({
  requestId: z.string(),
  deviceName: z.string(),
  remoteIp: z.string(),
  verificationCode: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type PendingPairingRequest = z.infer<typeof PendingPairingRequestSchema>;

export const PairingChallengeInfoSchema = z.object({
  challengeId: z.string(),
  pairingCode: z.string(),
  pairingUrl: z.string(),
  expiresAt: z.string(),
});
export type PairingChallengeInfo = z.infer<typeof PairingChallengeInfoSchema>;

export const PairingSessionStatusSchema = z.enum([
  'desktop',
  'active',
  'none',
  'expired',
  'revoked',
]);
export type PairingSessionStatus = z.infer<typeof PairingSessionStatusSchema>;

export const PairingStatusResponseSchema = z.object({
  isLocalDesktop: z.boolean(),
  authenticated: z.boolean(),
  sessionStatus: PairingSessionStatusSchema,
  activeSession: PairingSessionInfoSchema.nullable(),
  pendingRequests: z.array(PendingPairingRequestSchema),
  activeChallenge: PairingChallengeInfoSchema.nullable(),
  lanUrls: z.array(z.string()),
  isTrustedDevice: z.boolean().optional(),
  trustedDeviceName: z.string().nullable().optional(),
  trustedDevices: z.array(TrustedDeviceInfoSchema).optional(),
});
export type PairingStatusResponse = z.infer<typeof PairingStatusResponseSchema>;

export const PairingRequestPayloadSchema = z.object({
  pairingCode: z.string().trim().min(6).max(128),
  deviceName: z.string().trim().min(1).max(80).optional(),
});
export type PairingRequestPayload = z.infer<typeof PairingRequestPayloadSchema>;

export const PairingPollPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  claimSecret: z.string().trim().min(1).max(128),
});
export type PairingPollPayload = z.infer<typeof PairingPollPayloadSchema>;

export const PairingDecisionPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
});
export type PairingDecisionPayload = z.infer<typeof PairingDecisionPayloadSchema>;

// AI Tone Assistant & Musician Gear Contracts

export const AiGearConfigSchema = z.object({
  guitarModel: z.string(),
  outputTarget: z.string(),
  pickupSummary: z.string(),
  recommendations: z.array(z.string()),
  updatedAt: z.string(),
});
export type AiGearConfig = z.infer<typeof AiGearConfigSchema>;

export const UpdateAiGearRequestSchema = z.object({
  guitarModel: z.string().trim().min(2).max(100),
  outputTarget: z.string().trim().max(120).optional().default(''),
});
export type UpdateAiGearRequest = z.infer<typeof UpdateAiGearRequestSchema>;

export const AiGearStateResponseSchema = z.object({
  gear: AiGearConfigSchema.nullable(),
});
export type AiGearStateResponse = z.infer<typeof AiGearStateResponseSchema>;

export const AiToneIntentSchema = z.enum(['create_new', 'edit_existing']);
export type AiToneIntent = z.infer<typeof AiToneIntentSchema>;

export const AiAppliedBlockSummarySchema = z.object({
  blockCode: z.string(),
  enabled: z.boolean(),
  modelName: z.string(),
  params: z.array(
    z.object({
      label: z.string(),
      value: z.union([z.number(), z.string()]),
    }),
  ),
  changed: z.boolean().optional(),
});
export type AiAppliedBlockSummary = z.infer<typeof AiAppliedBlockSummarySchema>;

export const AiOutputCalibrationSummarySchema = z.object({
  source: z.enum(['hardware_user', 'nuxpreset_files', 'factory_default']),
  sampleCount: z.number().int().nonnegative(),
  avgPatchVolume: z.number(),
  avgIrVolume: z.number(),
  avgAmpLevel: z.number(),
  appliedPatchVolume: z.number().int().min(0).max(100),
  appliedIrVolume: z.number().int().min(0).max(40),
  appliedAmpLevel: z.number().int().min(0).max(100),
});
export type AiOutputCalibrationSummary = z.infer<typeof AiOutputCalibrationSummarySchema>;

export const AiToneApplyRequestSchema = z.object({
  slotIndex: z.number().int().min(0).max(35),
  prompt: z.string().trim().min(3).max(600),
});
export type AiToneApplyRequest = z.infer<typeof AiToneApplyRequestSchema>;

export const AiDelayProfileSchema = z.enum([
  'NONE',
  'RHYTHM',
  'LEAD',
  'AMBIENT',
  'SLAPBACK',
]);
export type AiDelayProfile = z.infer<typeof AiDelayProfileSchema>;

export const AiMusicalPurposeSchema = z.enum([
  'heavy_rhythm',
  'rhythm',
  'lead_solo',
  'melodic_lead',
  'slapback',
  'ambient',
  'clean_dry',
  'clean_modulated',
  'generic',
]);
export type AiMusicalPurpose = z.infer<typeof AiMusicalPurposeSchema>;

export const AiGainStageSchema = z.enum(['clean', 'crunch', 'high_gain']);
export type AiGainStage = z.infer<typeof AiGainStageSchema>;

export const AiAmbienceRuleCodeSchema = z.enum([
  'unjustified_delay_removed',
  'multiple_delay_blocks',
  'incompatible_delay_model',
  'incompatible_delay_time',
  'excessive_delay_mix',
  'excessive_delay_feedback',
  'excessive_repeats',
  'excessive_delay_modulation',
  'excessive_reverb_mix',
  'excessive_reverb_decay',
  'excessive_reverb_liveliness',
  'insufficient_reverb_predelay',
  'excessive_combined_ambience',
]);
export type AiAmbienceRuleCode = z.infer<typeof AiAmbienceRuleCodeSchema>;

export const AiAmbienceCorrectionSchema = z.object({
  block: z.enum(['DLY', 'RVB', 'MOD', 'META']),
  param: z.string(),
  proposed: z.union([z.number(), z.string()]),
  applied: z.union([z.number(), z.string()]),
  rule: AiAmbienceRuleCodeSchema,
  reason: z.string(),
});
export type AiAmbienceCorrection = z.infer<typeof AiAmbienceCorrectionSchema>;

export const AiAmbienceBlockSnapshotSchema = z.object({
  modelId: z.number().int().min(0).max(127),
  modelName: z.string(),
  params: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
    }),
  ),
});
export type AiAmbienceBlockSnapshot = z.infer<typeof AiAmbienceBlockSnapshotSchema>;

export const AiToneAmbienceDiagnosticsSchema = z.object({
  originalPrompt: z.string(),
  musicalPurpose: AiMusicalPurposeSchema,
  delayProfile: AiDelayProfileSchema,
  aiSuggestedProfile: AiDelayProfileSchema.nullable(),
  delayDecision: z.enum(['included', 'excluded', 'preserved']),
  delayDecisionReason: z.string(),
  selectedDelayModel: z.object({
    id: z.number().int().min(0).max(127),
    name: z.string(),
  }),
  aiProposedAmbience: z.object({
    dly: AiAmbienceBlockSnapshotSchema.nullable(),
    rvb: AiAmbienceBlockSnapshotSchema.nullable(),
    modEnabled: z.boolean(),
    gainStage: AiGainStageSchema,
    timeFlag: z.number().int().min(0).max(1).optional(),
    duplicateDelayDirectives: z.number().int().nonnegative(),
  }),
  finalAmbience: z.object({
    dly: AiAmbienceBlockSnapshotSchema,
    rvb: AiAmbienceBlockSnapshotSchema,
    modEnabled: z.boolean(),
    gainStage: AiGainStageSchema,
    timeFlag: z.number().int().min(0).max(1),
    jointAmbienceScore: z.number().nonnegative(),
  }),
  corrections: z.array(AiAmbienceCorrectionSchema),
  warnings: z.array(z.string()),
});
export type AiToneAmbienceDiagnostics = z.infer<typeof AiToneAmbienceDiagnosticsSchema>;

export const AiToneApplyResponseSchema = z.object({
  slotIndex: z.number().int().min(0).max(35),
  displayBank: z.string(),
  intent: AiToneIntentSchema,
  presetName: z.string(),
  bpm: z.number().int().min(40).max(240),
  timeFlag: z.number().int().min(0).max(1),
  summary: z.string(),
  tips: z.array(z.string()),
  appliedBlocks: z.array(AiAppliedBlockSummarySchema),
  calibration: AiOutputCalibrationSummarySchema,
  saveResult: ExperimentalSaveResultSchema,
  experimentalState: ExperimentalEditStateSchema,
  diagnostics: AiToneAmbienceDiagnosticsSchema.optional(),
});
export type AiToneApplyResponse = z.infer<typeof AiToneApplyResponseSchema>;

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
    type: z.literal('pairing_updated'),
    activeSession: PairingSessionInfoSchema.nullable(),
    pendingRequests: z.array(PendingPairingRequestSchema),
    activeChallenge: PairingChallengeInfoSchema.nullable(),
    trustedDevices: z.array(TrustedDeviceInfoSchema).optional(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('experimental_state_sync'),
    state: ExperimentalEditStateSchema,
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('gear_updated'),
    gear: AiGearConfigSchema.nullable(),
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
