import { z } from 'zod';
import {
  MG300_BLOCK_CATALOG,
  MG300_FILE_FORMAT,
  MG300_USER_IR_CAB_ID,
  type AiToneApplyRequest,
  type AiToneApplyResponse,
  type Mg300BlockCode,
  containsForbiddenSlotMention,
  decodeMg300PresetName,
  decodeMg300UserIrName,
  getMg300ModelSpec,
  isValidMg300UserSlot,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';
import type { ExperimentalEditService } from '../experimental-edit.js';
import type { ControllerStateManager } from '../state-manager.js';
import type { AiGearStore } from './gear-store.js';
import { AiServiceError, type GeminiClientLike } from './gemini-client.js';
import {
  type AiBlockDirective,
  type AiTonePlan,
  type CalibratedToneResult,
  buildAndCalibrateStruct102,
  resolveCalibrationBaseline,
} from './tone-calibrator.js';

const BlockDirectiveSchema = z.object({
  modelId: z.number().int().min(0).max(MG300_USER_IR_CAB_ID),
  params: z
    .union([
      z.array(z.number()),
      z.record(z.string(), z.number()),
    ])
    .optional(),
});

const AiTonePlanSchema = z.object({
  intent: z.enum(['create_new', 'edit_existing']),
  presetName: z.string().trim().min(1).max(40),
  bpm: z.number().int().min(40).max(240).optional(),
  timeFlag: z.number().int().min(0).max(1).optional(),
  irCut: z.number().int().min(0).max(2).optional(),
  irVolume: z.number().int().min(0).max(40).optional(),
  patchVolume: z.number().int().min(0).max(100).optional(),
  blocks: z
    .object({
      COMP: BlockDirectiveSchema.optional(),
      EFX: BlockDirectiveSchema.optional(),
      AMP: BlockDirectiveSchema.optional(),
      EQ: BlockDirectiveSchema.optional(),
      NR: BlockDirectiveSchema.optional(),
      MOD: BlockDirectiveSchema.optional(),
      DLY: BlockDirectiveSchema.optional(),
      RVB: BlockDirectiveSchema.optional(),
      CAB: BlockDirectiveSchema.optional(),
      MIC: BlockDirectiveSchema.optional(),
    })
    .optional()
    .default({}),
  summary: z.string().trim().min(1).max(600),
  tips: z.array(z.string().trim().min(1)).optional().default([]),
});

interface CatalogSummaryModel {
  id: number;
  name: string;
  category?: string;
  params: Array<{
    index: number;
    label: string;
    type: string;
    min: number;
    max: number;
    options?: Array<{ value: number; label: string }>;
  }>;
}

interface CatalogSummaryBlock {
  code: Mg300BlockCode;
  models: CatalogSummaryModel[];
}

function buildCompactCatalogForPrompt(): CatalogSummaryBlock[] {
  return MG300_BLOCK_CATALOG.map((block) => ({
    code: block.code,
    models: block.models
      .filter((m) => !(block.code === 'CAB' && m.id === MG300_USER_IR_CAB_ID))
      .map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.category ? { category: model.category } : {}),
        params: model.params.map((p) => ({
          index: p.paramIndex,
          label: p.label,
          type: p.controlType,
          min: p.min,
          max: p.max,
          ...(p.options ? { options: [...p.options] } : {}),
        })),
      })),
  }));
}

const COMPACT_MG300_CATALOG = buildCompactCatalogForPrompt();

function decodeCurrentPresetContext(struct102: Uint8Array): Record<string, unknown> {
  const blocks: Record<string, unknown> = {};
  for (const block of MG300_BLOCK_CATALOG) {
    const modelId = struct102[block.cc] ?? 0;
    const spec = modelId > 0 ? getMg300ModelSpec(block.id, modelId) : undefined;
    const params: Record<string, number> = {};
    if (spec && block.structParamOffset !== null) {
      for (const p of spec.params) {
        params[p.label] = struct102[block.structParamOffset + p.paramIndex] ?? 0;
      }
    }
    blocks[block.code] = {
      modelId,
      modelName: modelId === 0 ? 'Bypass' : (spec?.name ?? `Model ${modelId}`),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    };
  }

  return {
    presetName: decodeMg300PresetName(struct102),
    bpm: struct102[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] ?? 120,
    timeFlag: (struct102[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0,
    irCut: struct102[0x43] ?? 0,
    irVolume: struct102[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? 20,
    patchVolume: struct102[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? 50,
    hasUserIr: (struct102[0x09] ?? 0) === MG300_USER_IR_CAB_ID,
    userIrName: decodeMg300UserIrName(struct102),
    blocks,
  };
}

const TONE_SYSTEM_INSTRUCTION = [
  'Você é um engenheiro de áudio especialista na pedaleira NUX MG-300.',
  'Classifique o pedido do músico em intent: "create_new" (criar um timbre novo do zero) ou "edit_existing" (ajustar/modificar o timbre atualmente salvo no slot alvo).',
  'Use EXCLUSIVAMENTE os IDs de bloco, modelos e faixas de parâmetros do catálogo MG-300 fornecido.',
  'Regras críticas da NUX MG-300:',
  '1) modelId=0 coloca o bloco em Bypass. Nunca invente IDs fora do catálogo.',
  '2) EFX 12 (Pitch Bender) tem p0=Pitch (semitom/posição, não é volume) e p1=Range (0..1).',
  '3) AMP 2 (Deluxe Rvb) e AMP 26 (Stageman) NÃO têm parâmetro no índice 1 (CC 24).',
  '4) AMP 4 (Tweedy) tem apenas 3 parâmetros: Gain(0), Tone(1), Level(2).',
  '5) AMP 8 (Class A15), AMP 9 (Class A30) e AMP 23 (Match D30) NÃO têm Middle.',
  '6) MOD 13 (Harmony) usa Minor Scale(0..1), Key(0..11), Harmo(0..9) e Balance(0..100).',
  '7) Nunca selecione CAB=100 em create_new. Em edit_existing, se o slot atual já usa CAB=100 e o pedido não pedir troca de gabinete, omita CAB para preservá-lo.',
  '8) Se AMP=0, CAB deve ser 0. Para saída em linha/FRFR/fone/interface, mantenha AMP e CAB ativos.',
  '9) Em edit_existing, inclua em "blocks" SOMENTE os blocos que precisam mudar; omita blocos não alterados para preservá-los intactos.',
  '10) presetName deve ter no máximo 18 caracteres ASCII simples.',
  'Responda exclusivamente em JSON válido no formato solicitado, com summary e tips curtos em português do Brasil.',
].join('\n');

function toNormalizedPlan(parsed: z.infer<typeof AiTonePlanSchema>): AiTonePlan {
  const blocks: Partial<Record<Mg300BlockCode, AiBlockDirective>> = {};
  for (const [code, dir] of Object.entries(parsed.blocks)) {
    if (dir) {
      blocks[code as Mg300BlockCode] = {
        modelId: dir.modelId,
        ...(dir.params !== undefined ? { params: dir.params } : {}),
      };
    }
  }
  return {
    intent: parsed.intent,
    presetName: parsed.presetName,
    ...(parsed.bpm !== undefined ? { bpm: parsed.bpm } : {}),
    ...(parsed.timeFlag !== undefined ? { timeFlag: parsed.timeFlag } : {}),
    ...(parsed.irCut !== undefined ? { irCut: parsed.irCut } : {}),
    ...(parsed.irVolume !== undefined ? { irVolume: parsed.irVolume } : {}),
    ...(parsed.patchVolume !== undefined ? { patchVolume: parsed.patchVolume } : {}),
    blocks,
    summary: parsed.summary,
    tips: parsed.tips.slice(0, 4),
  };
}

export interface AiToneServiceOptions {
  geminiClient: GeminiClientLike;
  gearStore: AiGearStore;
  stateManager: ControllerStateManager;
  experimentalEdit: ExperimentalEditService;
  calibrationDir?: string | null;
}

export class AiToneService {
  private readonly geminiClient: GeminiClientLike;
  private readonly gearStore: AiGearStore;
  private readonly stateManager: ControllerStateManager;
  private readonly experimentalEdit: ExperimentalEditService;
  private readonly calibrationDir: string | null | undefined;

  public constructor(options: AiToneServiceOptions) {
    this.geminiClient = options.geminiClient;
    this.gearStore = options.gearStore;
    this.stateManager = options.stateManager;
    this.experimentalEdit = options.experimentalEdit;
    this.calibrationDir = options.calibrationDir;
  }

  public async applyTone(request: AiToneApplyRequest): Promise<AiToneApplyResponse> {
    if (!isValidMg300UserSlot(request.slotIndex)) {
      throw new AiServiceError(
        'FACTORY_SLOT_PROTECTED',
        'Apenas slots de Usuário (1A a 9D) podem ser alterados. Slots de Fábrica são protegidos.',
        400,
      );
    }

    const forbiddenMention = containsForbiddenSlotMention(request.prompt);
    if (forbiddenMention !== null) {
      throw new AiServiceError(
        'SLOT_MENTION_FORBIDDEN',
        `Não mencione slots ou presets no texto ("${forbiddenMention}"). Use o seletor de slot no topo para escolher onde gravar.`,
        400,
      );
    }

    const gear = this.gearStore.getGear();
    if (!gear) {
      throw new AiServiceError(
        'GEAR_NOT_CONFIGURED',
        'Configure o modelo da sua guitarra antes de criar ou editar timbres com IA.',
        412,
      );
    }

    if (!this.stateManager.getMidiService().isConnected()) {
      throw new AiServiceError(
        'DISCONNECTED',
        'A pedaleira NUX MG-300 não está conectada. Conecte via USB antes de continuar.',
        503,
      );
    }

    const baseline = resolveCalibrationBaseline({
      knownUserStructs: this.stateManager.getKnownUserStructs(),
      presetsDirectory: this.stateManager.getPresetsDirectory(),
      calibrationDir: this.calibrationDir,
    });

    const coord = slotIndexToBankCoordinate(request.slotIndex);
    let calibrated: CalibratedToneResult | null = null;
    let validatedPlan: AiTonePlan | null = null;

    const { saveResult, experimentalState } =
      await this.experimentalEdit.applyExternalTransform(
        request.slotIndex,
        async (existingStruct) => {
          const userPrompt = JSON.stringify({
            targetSlot: {
              slotIndex: request.slotIndex,
              displayBank: coord.displayBank,
            },
            musicianGear: {
              guitarModel: gear.guitarModel,
              outputTarget: gear.outputTarget || 'Não informado (use CAB/IR equilibrado)',
              pickupSummary: gear.pickupSummary,
              recommendations: gear.recommendations,
            },
            calibrationBaseline: {
              source: baseline.source,
              avgPatchVolume: baseline.avgPatchVolume,
              avgIrVolume: baseline.avgIrVolume,
              avgAmpLevel: baseline.avgAmpLevel,
            },
            currentSlotPreset: decodeCurrentPresetContext(existingStruct),
            userRequest: request.prompt,
            mg300Catalog: COMPACT_MG300_CATALOG,
            expectedJsonSchema: {
              intent: '"create_new" | "edit_existing"',
              presetName: 'string (1..18 chars)',
              bpm: 'integer 40..240 (optional)',
              timeFlag: '0 | 1 (optional)',
              irCut: '0 | 1 | 2 (optional)',
              irVolume: 'integer 0..40 (optional)',
              patchVolume: 'integer 0..100 (optional)',
              blocks: 'object keyed by COMP|EFX|AMP|EQ|NR|MOD|DLY|RVB|CAB|MIC -> { modelId, params?: Record<paramLabel, number> }',
              summary: 'string em pt-BR explicando as escolhas feitas',
              tips: 'array de 1..3 dicas curtas de guitarra/captador/dinâmica em pt-BR',
            },
          });

          const rawAiResponse = await this.geminiClient.generateJson<unknown>({
            systemInstruction: TONE_SYSTEM_INSTRUCTION,
            userPrompt,
            temperature: 0.35,
            maxOutputTokens: 1500,
          });

          const parsedPlan = AiTonePlanSchema.safeParse(rawAiResponse);
          if (!parsedPlan.success) {
            throw new AiServiceError(
              'AI_UNAVAILABLE',
              'A IA retornou um formato de timbre inválido para a NUX MG-300.',
              503,
            );
          }

          validatedPlan = toNormalizedPlan(parsedPlan.data);
          calibrated = buildAndCalibrateStruct102({
            plan: validatedPlan,
            existingStruct,
            baseline,
          });
          return calibrated.struct102;
        },
      );

    if (!calibrated || !validatedPlan) {
      throw new AiServiceError(
        'AI_UNAVAILABLE',
        'Falha inesperada ao processar o timbre gerado pela IA.',
        503,
      );
    }

    const finalCalibrated: CalibratedToneResult = calibrated;
    const finalPlan: AiTonePlan = validatedPlan;

    return {
      slotIndex: request.slotIndex,
      displayBank: saveResult.displayBank,
      intent: finalCalibrated.intent,
      presetName: finalCalibrated.presetName,
      bpm: finalCalibrated.bpm,
      timeFlag: finalCalibrated.timeFlag,
      summary: finalPlan.summary,
      tips: finalPlan.tips,
      appliedBlocks: finalCalibrated.appliedBlocks,
      calibration: finalCalibrated.calibration,
      saveResult,
      experimentalState,
    };
  }
}
