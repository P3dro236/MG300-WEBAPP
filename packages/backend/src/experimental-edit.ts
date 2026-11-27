import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  MG300_EXPERIMENTAL_AMP_PARAM_COUNT,
  MG300_EXPERIMENTAL_BLOCK_CCS,
  MG300_EXPERIMENTAL_BLOCKS,
  MG300_EXPERIMENTAL_SLOT,
  MG300_FILE_FORMAT,
  MG300_MIDI_CC,
  MG300_USER_IR_CAB_ID,
  MG300_USER_SLOT_MAX,
  MG300_USER_SLOT_MIN,
  buildMg300PresetWriteSysEx,
  compareStruct102Readback,
  createBlankMg300Struct102,
  decodeMg300PresetName,
  decodeMg300UserIrName,
  encodeMg300PresetName,
  type ExperimentalEditState,
  type ExperimentalSaveResult,
  type ExperimentalSourceMode,
  getExperimentalBlockMeta,
  getMg300ModelDefaultParams,
  getMg300ModelSpec,
  isPresetWriteAck,
  isValidMg300BlockModel,
  isValidMg300UserSlot,
  sanitizeMg300PresetName,
  sanitizeStruct102ForSysEx,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';
import { parseNuxPresetWithStruct102, QuickTonePresetParseError } from '@quicktone/reader';
import {
  getSharedMidiDiagnosticsLogger,
  type MidiDiagnosticsLogger,
  type MidiService,
} from '@quicktone/midi';

const MAX_IMPORT_FILE_BYTES = 512 * 1024;
const USER_SLOT_SCHEMA = z
  .number()
  .int()
  .min(MG300_USER_SLOT_MIN, 'Slots de Fábrica são protegidos e não podem ser gravados.')
  .max(MG300_USER_SLOT_MAX, 'Slots de Fábrica são protegidos e não podem ser gravados.');

export const ExperimentalLoadRequestSchema = z.object({
  slot: USER_SLOT_SCHEMA.optional(),
});

export const ExperimentalParamRequestSchema = z.object({
  index: z.number().int().min(0).max(MG300_EXPERIMENTAL_AMP_PARAM_COUNT - 1),
  value: z.number().int().min(0).max(100),
});

export const ExperimentalBlockRequestSchema = z.object({
  block: z.number().int().min(1).max(10),
  on: z.boolean(),
});

export const ExperimentalBlockModelRequestSchema = z
  .object({
    block: z.number().int().min(1).max(10),
    modelId: z.number().int().min(0).max(MG300_USER_IR_CAB_ID),
  })
  .superRefine((data, ctx) => {
    if (!isValidMg300BlockModel(data.block, data.modelId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelId'],
        message: `Modelo ${data.modelId} inválido para o bloco ${data.block}.`,
      });
    }
  });

export const ExperimentalBlockParamRequestSchema = z.object({
  block: z.number().int().min(1).max(MG300_EXPERIMENTAL_BLOCKS.length),
  index: z.number().int().min(0).max(5),
  value: z.number().int().min(0).max(100),
});

export const ExperimentalLevelRequestSchema = z
  .object({
    target: z.enum(['patchVolume', 'irVolume', 'irCut', 'cab', 'mic']),
    value: z.number().int().min(0).max(100),
  })
  .superRefine((data, ctx) => {
    const maxMap: Record<typeof data.target, number> = {
      patchVolume: 100,
      irVolume: 40,
      irCut: 2,
      cab: 100,
      mic: 4,
    };
    const max = maxMap[data.target];
    if (data.value > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `Valor ${data.value} excede o máximo (${max}) para ${data.target}.`,
      });
    }
    if (data.target === 'cab' && !isValidMg300BlockModel(9, data.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `Modelo de CAB ${data.value} inválido para a NUX MG-300.`,
      });
    }
  });

export const ExperimentalMetaRequestSchema = z.object({
  presetName: z.string().max(64).optional(),
  bpm: z.number().int().min(40).max(240).optional(),
  timeFlag: z.number().int().min(0).max(1).optional(),
});

export const ExperimentalCreateDraftRequestSchema = z.object({
  presetName: z.string().max(64).optional(),
  bpm: z.number().int().min(40).max(240).optional(),
  timeFlag: z.number().int().min(0).max(1).optional(),
  targetSlot: USER_SLOT_SCHEMA.optional(),
});

export const ExperimentalImportRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(160),
  contentBase64: z.string().trim().min(1).max(720_000),
  bundleSlotIndex: z.number().int().min(0).max(35).optional(),
});

export const ExperimentalSaveRequestSchema = z.object({
  confirmSlot: USER_SLOT_SCHEMA,
});

export interface ExperimentalBundleSlotSummary {
  index: number;
  slotIndex: number;
  displayBank: string;
  name: string;
  usesUserIr: boolean;
}

export interface ExperimentalImportResult {
  state: ExperimentalEditState;
  importedCount: number;
  selectedIndex: number;
  bundleSlots?: ExperimentalBundleSlotSummary[];
}

export class ExperimentalEditError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'ExperimentalEditError';
  }
}

export interface ExperimentalEditOptions {
  backupDir: string;
  identityTimeoutMs?: number;
  dumpTimeoutMs?: number;
  ackTimeoutMs?: number;
  /** Pause between sending `CC 1..8 > 0` and resyncing block parameter CCs after STM32 loads defaults. */
  modelResyncDelayMs?: number;
  /** Pause between the 0x0E ACK and the verification read (Flash erase/program settle). */
  settleMs?: number;
  /** Protects the pedal's Flash wear budget from accidental repeated saves. */
  minSaveIntervalMs?: number;
  logger?: MidiDiagnosticsLogger;
  /** Invoked after a verified User slot Flash save to refresh the live preset library immediately. */
  onPresetSaved?: (slotIndex: number, struct102: Uint8Array) => void;
}

export type ExperimentalLevelTarget = 'patchVolume' | 'irVolume' | 'irCut' | 'cab' | 'mic';

const LEVEL_CONTROL_SPEC: Record<
  ExperimentalLevelTarget,
  { cc: number; structOffset: number; max: number }
> = {
  patchVolume: {
    cc: MG300_MIDI_CC.PATCH_LEVEL,
    structOffset: MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET,
    max: 100,
  },
  irVolume: {
    cc: MG300_MIDI_CC.IR_CAB_VOLUME,
    structOffset: MG300_FILE_FORMAT.IR_VOLUME_OFFSET,
    max: 40,
  },
  irCut: {
    cc: 59,
    structOffset: 0x43,
    max: 2,
  },
  cab: {
    cc: 9,
    structOffset: 0x09,
    max: 100,
  },
  mic: {
    cc: 10,
    structOffset: 0x0a,
    max: 4,
  },
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function buildUserIrWarning(hasUserIr: boolean, userIrName: string | null): string | null {
  if (!hasUserIr) {
    return null;
  }
  const suffix =
    'Os blocos e parâmetros serão gravados normalmente, mas o áudio do IR não é enviado nesta etapa e dependerá do User IR já armazenado no slot de destino.';
  return userIrName
    ? `Este preset utiliza o User IR "${userIrName}". ${suffix}`
    : `Este preset utiliza um User IR customizado. ${suffix}`;
}

function decodeStrictBase64(contentBase64: string): Uint8Array {
  const cleaned = contentBase64.replace(/\s+/g, '');
  if (!cleaned || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new ExperimentalEditError(
      'INVALID_NUXPRESET',
      'O conteúdo do arquivo enviado está corrompido.',
      400,
    );
  }
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new ExperimentalEditError(
      'IMPORT_TOO_LARGE',
      'O arquivo selecionado é inválido ou excede o limite de 512 KB.',
      400,
    );
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Coordinates live 10-block MIDI CC editing (`hardware` mode), local preset creation/import
 * (`draft` / `imported`), automatic pre-overwrite slot backup, and verified `0x0E` saving
 * strictly to User slots (`0..35` / `1A..9D`).
 */
export class ExperimentalEditService {
  private draft: Uint8Array | null = null;
  private draftGeneration = 0;
  private activeSlot: number = MG300_EXPERIMENTAL_SLOT;
  private sourceMode: ExperimentalSourceMode = 'hardware';
  private sourceFileName: string | null = null;
  private dirty = false;
  private modelChangedSinceLoad = false;
  private busy = false;
  private lastSave: ExperimentalSaveResult | null = null;
  private lastSaveAtMs = 0;
  private baselineConfirmedSlot: number | null = null;
  private baselineSelectCommandId: string | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly logger: MidiDiagnosticsLogger;
  private readonly lastModelByBlock = new Map<number, number>();
  private readonly stateListeners = new Set<(state: ExperimentalEditState) => void>();
  private readonly unsubscribeMidiState: () => void;

  public constructor(
    private readonly midi: MidiService,
    private readonly options: ExperimentalEditOptions,
  ) {
    this.logger = options.logger ?? getSharedMidiDiagnosticsLogger();
    this.unsubscribeMidiState = this.midi.onStateChange((midiState) => {
      if (!this.draft || this.busy || this.sourceMode !== 'hardware') {
        return;
      }

      if (midiState.connectionState !== 'connected') {
        this.invalidateDraft();
        return;
      }

      const confirmedSlot = midiState.confirmedState.slotIndex;
      if (confirmedSlot === this.activeSlot) {
        this.baselineConfirmedSlot = this.activeSlot;
      }

      const hasNewConfirmedSlot =
        confirmedSlot !== null &&
        confirmedSlot !== this.activeSlot &&
        confirmedSlot !== this.baselineConfirmedSlot;

      const hasNewSelectCommand =
        midiState.lastSentCommand?.type === 'preset_select' &&
        midiState.lastSentCommand.slotIndex !== undefined &&
        midiState.lastSentCommand.slotIndex !== this.activeSlot &&
        midiState.lastSentCommand.commandId !== this.baselineSelectCommandId;

      if (hasNewConfirmedSlot || hasNewSelectCommand) {
        this.invalidateDraft();
      }
    });
  }

  public dispose(): void {
    this.unsubscribeMidiState();
    this.stateListeners.clear();
  }

  public onStateChange(listener: (state: ExperimentalEditState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public getState(): ExperimentalEditState {
    const draft = this.draft;
    const blockModels: Record<string, number> = {};
    const blockParams: Record<string, number[]> = {};
    if (draft) {
      for (let blockCc = 1; blockCc <= 10; blockCc++) {
        blockModels[String(blockCc)] = draft[blockCc] ?? 0;
      }
      for (const meta of MG300_EXPERIMENTAL_BLOCKS) {
        blockParams[String(meta.id)] = Array.from(
          draft.subarray(meta.structParamOffset, meta.structParamOffset + 6),
        );
      }
    }

    const cabModel = draft ? (draft[0x09] ?? 0) : 0;
    const hasUserIr = cabModel === MG300_USER_IR_CAB_ID;
    const userIrName = draft ? decodeMg300UserIrName(draft) : null;
    const rawBpm = draft ? (draft[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] ?? 120) : 120;

    return {
      slot: this.activeSlot,
      loaded: draft !== null,
      busy: this.busy,
      dirty: this.dirty,
      sourceMode: this.sourceMode,
      sourceFileName: this.sourceFileName,
      presetName: draft ? decodeMg300PresetName(draft) : null,
      bpm: Math.max(40, Math.min(240, rawBpm)),
      timeFlag: draft && (draft[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0,
      ampParams: blockParams['3'] ?? [],
      blocksEnabled: draft
        ? MG300_EXPERIMENTAL_BLOCK_CCS.map((block) => (draft[block] ?? 0) > 0)
        : [],
      blockModels,
      blockParams,
      cabEnabled: cabModel > 0,
      cabModel,
      micModel: draft ? (draft[0x0a] ?? 0) : 0,
      irCut: draft ? Math.min(2, draft[0x43] ?? 0) : 0,
      irVolume: draft ? Math.min(40, draft[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? 20) : 20,
      patchVolume: draft ? Math.min(100, draft[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? 50) : 50,
      hasUserIr,
      userIrName,
      userIrWarning: buildUserIrWarning(hasUserIr, userIrName),
      lastSave: this.lastSave
        ? {
            ...this.lastSave,
            backupPath: path.basename(this.lastSave.backupPath),
          }
        : null,
    };
  }

  /** Selects any User slot (`0..35`) on the pedal and reads it back into RAM edit mode. */
  public async load(slotIndex: number = MG300_EXPERIMENTAL_SLOT): Promise<ExperimentalEditState> {
    this.assertUserSlot(slotIndex);
    const displayBank = slotIndexToBankCoordinate(slotIndex).displayBank;

    await this.runExclusive(async () => {
      this.logger.info('experimental-edit', 'Loading user slot into live editor', {
        slot: slotIndex,
        label: displayBank,
      });
      await this.requireMg300();
      await this.midi.selectMg300Preset(slotIndex);
      await this.midi.queryGlobalStatus().catch(() => undefined);
      await sleep(150);
      this.draft = await this.readSlot(slotIndex);
      this.draftGeneration += 1;
      this.activeSlot = slotIndex;
      this.sourceMode = 'hardware';
      this.sourceFileName = null;
      this.dirty = false;
      this.modelChangedSinceLoad = false;
      this.seedLastModelsFromDraft(this.draft);
      this.syncHardwareBaseline();
      this.logger.info('experimental-edit', 'User slot loaded', {
        slot: slotIndex,
        label: displayBank,
        presetName: decodeMg300PresetName(this.draft),
      });
    });
    return this.getState();
  }

  /** Starts a fresh preset draft offline without writing anything to the pedal. */
  public createNewDraft(
    input: { presetName?: string; bpm?: number; timeFlag?: number; targetSlot?: number } = {},
  ): ExperimentalEditState {
    if (this.busy) {
      throw new ExperimentalEditError(
        'DEVICE_BUSY',
        'Aguarde a operação atual terminar antes de continuar.',
      );
    }
    if (input.targetSlot !== undefined) {
      this.assertUserSlot(input.targetSlot);
      this.activeSlot = input.targetSlot;
    }
    this.draft = createBlankMg300Struct102({
      name: input.presetName ?? 'New Preset',
      bpm: input.bpm ?? 120,
      timeFlag: input.timeFlag ?? 0,
    });
    this.draftGeneration += 1;
    this.sourceMode = 'draft';
    this.sourceFileName = null;
    this.dirty = true;
    this.modelChangedSinceLoad = true;
    this.seedLastModelsFromDraft(this.draft);
    return this.emitState();
  }

  /** Parses and validates a `.nuxpreset` upload into an editable draft prior to Flash save. */
  public importNuxPreset(input: {
    fileName: string;
    contentBase64: string;
    bundleSlotIndex?: number;
  }): ExperimentalImportResult {
    if (this.busy) {
      throw new ExperimentalEditError(
        'DEVICE_BUSY',
        'Aguarde a operação atual terminar antes de continuar.',
      );
    }
    const safeFileName = path.basename(input.fileName).trim() || 'imported.nuxpreset';
    const rawBuffer = decodeStrictBase64(input.contentBase64);

    let parsed;
    try {
      parsed = parseNuxPresetWithStruct102(rawBuffer, {
        sourceFile: safeFileName,
        fallbackSlotIndex: this.activeSlot,
      });
    } catch (err) {
      if (err instanceof QuickTonePresetParseError) {
        throw new ExperimentalEditError(
          'INVALID_NUXPRESET',
          'Arquivo .nuxpreset inválido ou incompatível com a NUX MG-300.',
          400,
        );
      }
      throw err;
    }

    if (parsed.entries.length === 0) {
      throw new ExperimentalEditError(
        'INVALID_NUXPRESET',
        'Nenhum preset válido encontrado no arquivo enviado.',
        400,
      );
    }

    const selectedIndex = input.bundleSlotIndex ?? 0;
    const selected = parsed.entries[selectedIndex];
    if (!selected) {
      throw new ExperimentalEditError(
        'INVALID_BUNDLE_SLOT',
        `Índice de preset (${selectedIndex}) fora dos ${parsed.entries.length} presets encontrados no arquivo.`,
        400,
      );
    }

    this.draft = sanitizeStruct102ForSysEx(selected.struct102);
    this.draftGeneration += 1;
    this.sourceMode = 'imported';
    this.sourceFileName = safeFileName;
    this.dirty = true;
    this.modelChangedSinceLoad = true;
    this.seedLastModelsFromDraft(this.draft);
    const state = this.emitState();

    this.logger.info('experimental-edit', 'Imported .nuxpreset into editor draft', {
      fileName: safeFileName,
      entryCount: parsed.entries.length,
      selectedIndex,
      presetName: state.presetName,
      hasUserIr: state.hasUserIr,
      userIrName: state.userIrName,
    });

    return {
      state,
      importedCount: parsed.entries.length,
      selectedIndex,
      ...(parsed.entries.length > 1
        ? {
            bundleSlots: parsed.entries.map((entry, idx) => ({
              index: idx,
              slotIndex: entry.preset.slotIndex,
              displayBank: entry.preset.displayBank,
              name: entry.preset.name,
              usesUserIr: entry.usesUserIr,
            })),
          }
        : {}),
    };
  }

  public setMeta(input: {
    presetName?: string;
    bpm?: number;
    timeFlag?: number;
  }): ExperimentalEditState {
    const draft = this.requireDraft();
    if (input.presetName !== undefined) {
      const safeName = sanitizeMg300PresetName(input.presetName, 'Preset');
      const encoded = encodeMg300PresetName(safeName);
      draft[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = encoded.length;
      draft.set(encoded.bytes, MG300_FILE_FORMAT.NAME_CHARS_OFFSET);
    }
    if (input.bpm !== undefined) {
      draft[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] = Math.max(40, Math.min(240, Math.round(input.bpm)));
    }
    if (input.timeFlag !== undefined) {
      draft[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = input.timeFlag === 1 ? 1 : 0;
    }
    this.dirty = true;
    return this.emitState();
  }

  public async setAmpParam(index: number, value: number): Promise<ExperimentalEditState> {
    return this.setBlockParam(3, index, value);
  }

  public async setBlockParam(
    block: number,
    index: number,
    value: number,
  ): Promise<ExperimentalEditState> {
    const meta = getExperimentalBlockMeta(block);
    if (!meta || index < 0 || index >= 6) {
      throw new ExperimentalEditError(
        'INVALID_BLOCK_PARAM',
        `Parâmetro inválido: bloco ${block}, índice ${index}.`,
        400,
      );
    }

    return this.enqueueMutation(async () => {
      const draft = this.requireDraft();
      const gen = this.draftGeneration;
      const activeModelId = draft[block] ?? 0;
      if (activeModelId > 0) {
        const modelSpec = getMg300ModelSpec(block, activeModelId);
        const paramSpec = modelSpec?.params.find((p) => p.paramIndex === index);
        if (paramSpec && (value < paramSpec.min || value > paramSpec.max)) {
          throw new ExperimentalEditError(
            'INVALID_BLOCK_PARAM',
            `Valor ${value} fora do intervalo permitido (${paramSpec.min}..${paramSpec.max}) para ${paramSpec.label}.`,
            400,
          );
        }
      }

      if (this.sourceMode === 'hardware') {
        await this.midi.sendExperimentalControlChange(meta.paramCcBase + index, value);
      }

      if (this.draft !== draft || this.draftGeneration !== gen) {
        return this.getState();
      }
      draft[meta.structParamOffset + index] = value;
      // Per STM32 FUN_08038d04: editing Delay Time (CC 47, block 7 index 0) clears TimeFlag.
      if (block === 7 && index === 0) {
        draft[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = 0;
      }
      this.dirty = true;
      return this.emitState();
    });
  }

  public async setLevelParam(
    target: ExperimentalLevelTarget,
    value: number,
  ): Promise<ExperimentalEditState> {
    if (target === 'cab') {
      return this.setBlockModel(9, value);
    }
    if (target === 'mic') {
      return this.setBlockModel(10, value);
    }
    const spec = LEVEL_CONTROL_SPEC[target];
    if (!spec || value < 0 || value > spec.max) {
      throw new ExperimentalEditError(
        'INVALID_LEVEL_VALUE',
        `Valor ${value} inválido para ${target}.`,
        400,
      );
    }

    return this.enqueueMutation(async () => {
      const draft = this.requireDraft();
      const gen = this.draftGeneration;
      if (this.sourceMode === 'hardware') {
        await this.midi.sendExperimentalControlChange(spec.cc, value);
      }
      if (this.draft !== draft || this.draftGeneration !== gen) {
        return this.getState();
      }
      draft[spec.structOffset] = value;
      this.dirty = true;
      return this.emitState();
    });
  }

  /**
   * Selects a pedal/model (`1..N`, `100` for User IR on CAB) or bypass (`0`) for any of the 10 blocks.
   * When active hardware RAM is edited (`sourceMode === 'hardware'`), sending `CC 1..8 > 0` causes
   * the STM32 to overwrite block parameters with model defaults, so declared parameters are resynced.
   */
  public async setBlockModel(block: number, modelId: number): Promise<ExperimentalEditState> {
    if (!Number.isInteger(block) || block < 1 || block > 10) {
      throw new ExperimentalEditError('INVALID_BLOCK', `Bloco inválido: ${block}.`, 400);
    }
    if (!isValidMg300BlockModel(block, modelId)) {
      throw new ExperimentalEditError(
        'INVALID_BLOCK_MODEL',
        `Modelo ${modelId} inválido para o bloco ${block}.`,
        400,
      );
    }

    return this.enqueueMutation(() => this.applyBlockModel(block, modelId));
  }

  public async setBlock(block: number, on: boolean): Promise<ExperimentalEditState> {
    if (!Number.isInteger(block) || block < 1 || block > 10) {
      throw new ExperimentalEditError('INVALID_BLOCK', `Bloco inválido: ${block}.`, 400);
    }
    return this.enqueueMutation(async () => {
      const draft = this.requireDraft();
      const current = draft[block] ?? 0;
      const model = on ? (current > 0 ? current : (this.lastModelByBlock.get(block) ?? 1)) : 0;
      return this.applyBlockModel(block, model);
    });
  }

  private async applyBlockModel(block: number, modelId: number): Promise<ExperimentalEditState> {
    const draft = this.requireDraft();
    const gen = this.draftGeneration;
    const previousKnownModel = this.lastModelByBlock.get(block);
    const meta = getExperimentalBlockMeta(block);
    const switchedToDifferentModel =
      modelId > 0 && (previousKnownModel === undefined || previousKnownModel !== modelId);

    // Prepare parameter snapshot without mutating `draft` or `lastModelByBlock` until MIDI sends succeed.
    const nextParams = meta
      ? switchedToDifferentModel
        ? Uint8Array.from(getMg300ModelDefaultParams(block, modelId))
        : Uint8Array.from(draft.subarray(meta.structParamOffset, meta.structParamOffset + 6))
      : null;

    if (this.sourceMode === 'hardware') {
      await this.midi.sendExperimentalControlChange(block, modelId);
      if (block >= 1 && block <= 8 && modelId > 0 && meta && nextParams) {
        const modelSpec = getMg300ModelSpec(block, modelId);
        if (modelSpec && modelSpec.params.length > 0) {
          const delayMs = this.options.modelResyncDelayMs ?? 15;
          if (delayMs > 0) {
            await sleep(delayMs);
          }
          if (this.draft !== draft || this.draftGeneration !== gen) {
            return this.getState();
          }
          for (const param of modelSpec.params) {
            const rawVal = nextParams[param.paramIndex] ?? 0;
            const clamped = Math.max(param.min, Math.min(param.max, rawVal));
            nextParams[param.paramIndex] = clamped;
            await this.midi.sendExperimentalControlChange(param.cc, clamped);
          }
        }
      }
    }

    if (this.draft !== draft || this.draftGeneration !== gen) {
      return this.getState();
    }

    if (modelId > 0) {
      if (meta && nextParams && switchedToDifferentModel) {
        draft.set(nextParams, meta.structParamOffset);
      }
      this.lastModelByBlock.set(block, modelId);
    }

    draft[block] = modelId;
    if (modelId !== (previousKnownModel ?? 0)) {
      this.modelChangedSinceLoad = true;
    }
    // Firmware also clears CAB when AMP (CC 3) is switched off.
    if (block === 3 && modelId === 0) {
      draft[9] = 0;
    }
    this.dirty = true;
    return this.emitState();
  }

  /**
   * Backs up target User slot (`0..35`), writes preset (`0x0E`), waits for ACK, settles,
   * verifies readback against expected bytes, and refreshes the preset library.
   */
  public async save(targetSlot: number = this.activeSlot): Promise<ExperimentalSaveResult> {
    this.assertUserSlot(targetSlot);
    this.requireDraft();

    let result!: ExperimentalSaveResult;
    await this.runExclusive(async () => {
      const draft = this.draft;
      if (!draft) {
        throw new ExperimentalEditError(
          'NOT_LOADED',
          'Carregue um slot, crie um novo preset ou importe um arquivo antes de gravar.',
        );
      }
      const sinceLast = Date.now() - this.lastSaveAtMs;
      const minInterval = this.options.minSaveIntervalMs ?? 5000;
      if (this.lastSaveAtMs > 0 && sinceLast < minInterval) {
        throw new ExperimentalEditError(
          'SAVE_RATE_LIMITED',
          'Aguarde alguns segundos antes de gravar novamente na memória da pedaleira.',
          429,
        );
      }
      await this.requireMg300();

      const existingTarget = await this.readSlot(targetSlot);
      result = await this.commitStruct102ToFlash(
        targetSlot,
        existingTarget,
        draft,
        this.modelChangedSinceLoad,
      );
    });
    return result;
  }

  /**
   * Executes an exclusive read -> transform -> backup -> 0x0E write -> readback transaction
   * on a User slot (`0..35`). If `transformFn` throws, no backup or Flash write is performed.
   */
  public async applyExternalTransform(
    targetSlot: number,
    transformFn: (existingTarget: Uint8Array) => Promise<Uint8Array> | Uint8Array,
  ): Promise<{ saveResult: ExperimentalSaveResult; experimentalState: ExperimentalEditState }> {
    this.assertUserSlot(targetSlot);

    let saveResult!: ExperimentalSaveResult;
    await this.runExclusive(async () => {
      await this.requireMg300();
      const existingTarget = await this.readSlot(targetSlot);
      const nextStruct = await transformFn(Uint8Array.from(existingTarget));
      saveResult = await this.commitStruct102ToFlash(
        targetSlot,
        existingTarget,
        nextStruct,
        true,
      );
    });

    return {
      saveResult,
      experimentalState: this.getState(),
    };
  }

  private async commitStruct102ToFlash(
    targetSlot: number,
    existingTarget: Uint8Array,
    nextStruct: Uint8Array,
    ignoreBlockHeaderOffsets: boolean,
  ): Promise<ExperimentalSaveResult> {
    const displayBank = slotIndexToBankCoordinate(targetSlot).displayBank;
    const backupFullPath = this.writeBackup(targetSlot, existingTarget);
    const backupFileName = path.basename(backupFullPath);

    const safeDraft = sanitizeStruct102ForSysEx(nextStruct);
    const frame = buildMg300PresetWriteSysEx(safeDraft, targetSlot);

    const ack = this.waitForAck(targetSlot);
    try {
      await this.midi.sendExperimentalPresetWrite(frame);
    } catch (err) {
      ack.cancel();
      throw err;
    }
    const ackReceived = await ack.promise;
    this.lastSaveAtMs = Date.now();

    let mismatchedOffsets: number[] = [];
    let readBack: Uint8Array | null = null;
    if (ackReceived) {
      await sleep(this.options.settleMs ?? 200);
      readBack = await this.readSlot(targetSlot);
      mismatchedOffsets = compareStruct102Readback(safeDraft, readBack, {
        ignoreBlockHeaderOffsets,
      });
    }

    const verified = ackReceived && mismatchedOffsets.length === 0;
    if (verified && readBack) {
      // Reload targetSlot into DSP RAM so subsequent live CCs edit the freshly saved slot.
      await this.midi.selectMg300Preset(targetSlot);
      await this.midi.queryGlobalStatus().catch(() => undefined);
      this.draft = readBack;
      this.draftGeneration += 1;
      this.activeSlot = targetSlot;
      this.sourceMode = 'hardware';
      this.sourceFileName = null;
      this.dirty = false;
      this.modelChangedSinceLoad = false;
      this.seedLastModelsFromDraft(readBack);
      this.syncHardwareBaseline();
      this.options.onPresetSaved?.(targetSlot, readBack);
    }

    const result: ExperimentalSaveResult = {
      targetSlot,
      displayBank,
      ackReceived,
      verified,
      mismatchedOffsets,
      backupPath: backupFileName,
      savedAt: new Date().toISOString(),
    };
    this.lastSave = result;
    this.logger.info('experimental-edit', 'User slot save finished', {
      slot: targetSlot,
      label: displayBank,
      ackReceived,
      verified,
      mismatchedOffsets,
      backupPath: backupFullPath,
    });
    return result;
  }

  public async discard(): Promise<ExperimentalEditState> {
    return this.runExclusive(async () => {
      this.sourceFileName = null;
      this.invalidateDraft();
      return this.getState();
    });
  }

  private invalidateDraft(): void {
    this.draft = null;
    this.draftGeneration += 1;
    this.sourceMode = 'hardware';
    this.dirty = false;
    this.modelChangedSinceLoad = false;
    this.lastModelByBlock.clear();
    this.baselineConfirmedSlot = null;
    this.baselineSelectCommandId = null;
    this.emitState();
  }

  private syncHardwareBaseline(): void {
    const midiState = this.midi.getState();
    this.baselineConfirmedSlot = midiState.confirmedState.slotIndex;
    this.baselineSelectCommandId =
      midiState.lastSentCommand?.type === 'preset_select'
        ? midiState.lastSentCommand.commandId
        : null;
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) {
      return Promise.reject(
        new ExperimentalEditError(
          'DEVICE_BUSY',
          'Aguarde a operação atual terminar antes de continuar.',
        ),
      );
    }
    const run = this.mutationQueue.then(() => task());
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertUserSlot(slotIndex: number): void {
    if (!isValidMg300UserSlot(slotIndex)) {
      throw new ExperimentalEditError(
        'FACTORY_SLOT_PROTECTED',
        'Apenas slots de Usuário (1A a 9D) podem ser alterados. Slots de Fábrica são protegidos.',
        400,
      );
    }
  }

  private seedLastModelsFromDraft(struct102: Uint8Array): void {
    this.lastModelByBlock.clear();
    for (let blockCc = 1; blockCc <= 10; blockCc++) {
      const model = struct102[blockCc] ?? 0;
      if (model > 0) {
        this.lastModelByBlock.set(blockCc, model);
      }
    }
  }

  private emitState(): ExperimentalEditState {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      listener(state);
    }
    return state;
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new ExperimentalEditError(
        'DEVICE_BUSY',
        'Aguarde a operação atual terminar antes de continuar.',
      );
    }
    this.busy = true;
    try {
      // Wait for any in-flight CC/resync mutation to settle before exclusive Flash/slot I/O.
      await this.mutationQueue;
      return await task();
    } finally {
      this.busy = false;
      this.emitState();
    }
  }

  private requireDraft(): Uint8Array {
    if (!this.draft) {
      throw new ExperimentalEditError(
        'NOT_LOADED',
        'Carregue um slot, crie um novo preset ou importe um arquivo antes de editar.',
      );
    }
    if (this.busy) {
      throw new ExperimentalEditError(
        'DEVICE_BUSY',
        'Aguarde a operação atual terminar antes de continuar.',
      );
    }
    return this.draft;
  }

  private async requireMg300(): Promise<void> {
    const isMg300 = (): boolean =>
      this.midi.getState().deviceFirmwareVersion?.includes('NUX_MG1X') ?? false;
    if (isMg300()) {
      return;
    }

    const timeoutMs = this.options.identityTimeoutMs ?? 4000;
    const retryIntervalMs = 1000;
    const pollStepMs = 100;
    const startedAt = Date.now();
    let attempts = 0;

    while (Date.now() - startedAt < timeoutMs && !isMg300()) {
      attempts += 1;
      this.logger.debug('experimental-edit', 'Querying MG-300 identity via SysEx', {
        attempt: attempts,
        elapsedMs: Date.now() - startedAt,
      });
      await this.midi.queryDeviceIdentity();
      const attemptEnd = Math.min(startedAt + timeoutMs, Date.now() + retryIntervalMs);
      while (Date.now() < attemptEnd && !isMg300()) {
        await sleep(pollStepMs);
      }
    }

    if (!isMg300()) {
      const midiState = this.midi.getState();
      this.logger.error(
        'experimental-edit',
        'IDENTITY_NOT_CONFIRMED: expected NUX_MG1X reply via MIDI IN',
        {
          attempts,
          timeoutMs,
          connectionState: midiState.connectionState,
          connectedPortName: midiState.connectedPortName,
          deviceFirmwareVersion: midiState.deviceFirmwareVersion,
          syncStatus: midiState.syncStatus,
          lastError: midiState.lastError,
        },
      );
      throw new ExperimentalEditError(
        'IDENTITY_NOT_CONFIRMED',
        'A pedaleira não respondeu à verificação. Verifique se o cabo USB está bem conectado, reconecte a NUX MG-300 e tente novamente.',
        503,
      );
    }
  }

  private readSlot(slotIndex: number): Promise<Uint8Array> {
    const timeoutMs = this.options.dumpTimeoutMs ?? 4500;
    const displayBank = slotIndexToBankCoordinate(slotIndex).displayBank;
    return new Promise((resolve, reject) => {
      let settled = false;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        clearTimeout(timer);
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        unsubscribe();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this.logger.error('experimental-edit', 'DUMP_TIMEOUT: no 0x06 preset dump received', {
          slot: slotIndex,
          label: displayBank,
          timeoutMs,
        });
        reject(
          new ExperimentalEditError(
            'DUMP_TIMEOUT',
            `A pedaleira demorou para enviar os dados do slot ${displayBank}. Tente novamente ou reconecte o cabo USB.`,
            504,
          ),
        );
      }, timeoutMs);

      const unsubscribe = this.midi.onPresetDump(({ slotIndex: incomingSlot, struct102 }) => {
        if (incomingSlot !== slotIndex || settled) return;
        settled = true;
        cleanup();
        resolve(Uint8Array.from(struct102));
      });

      const sendQuery = (): void => {
        this.midi.queryPresetSlot(slotIndex).catch((err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
      };

      sendQuery();
      if (timeoutMs >= 1000) {
        retryTimer = setTimeout(() => {
          if (!settled) {
            this.logger.debug('experimental-edit', 'Retrying 0x07 preset slot query', {
              slot: slotIndex,
              label: displayBank,
            });
            sendQuery();
          }
        }, Math.floor(timeoutMs / 2));
      }
    });
  }

  private waitForAck(slotIndex: number): { promise: Promise<boolean>; cancel: () => void } {
    const timeoutMs = this.options.ackTimeoutMs ?? 3500;
    const displayBank = slotIndexToBankCoordinate(slotIndex).displayBank;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let resolvePromise: ((value: boolean) => void) | null = null;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this.logger.warn('experimental-edit', 'Timed out waiting for 0x0E write ACK', {
          slot: slotIndex,
          label: displayBank,
          timeoutMs,
        });
        resolve(false);
      }, timeoutMs);
      unsubscribe = this.midi.onRawSysEx((bytes) => {
        if (!isPresetWriteAck(bytes, slotIndex) || settled) return;
        settled = true;
        cleanup();
        resolve(true);
      });
    });

    const cancel = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise?.(false);
    };

    return { promise, cancel };
  }

  private writeBackup(slotIndex: number, struct102: Uint8Array): string {
    fs.mkdirSync(this.options.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.options.backupDir, `slot-${slotIndex}-${stamp}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        slot: slotIndex,
        displayBank: slotIndexToBankCoordinate(slotIndex).displayBank,
        name: decodeMg300PresetName(struct102),
        struct102Hex: Buffer.from(struct102).toString('hex'),
        createdAt: new Date().toISOString(),
      }),
    );
    return file;
  }
}
