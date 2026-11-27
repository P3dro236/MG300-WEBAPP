import { z } from 'zod';
import {
  MG300_BLOCK_CATALOG,
  MG300_FILE_FORMAT,
  MG300_USER_IR_CAB_ID,
  type AiGearConfig,
  type AiToneApplyRequest,
  type AiToneApplyResponse,
  type AiToneIntent,
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

const BLOCK_KEY_TO_CODE: Readonly<Record<string, Mg300BlockCode>> = {
  '1': 'COMP',
  '2': 'EFX',
  '3': 'AMP',
  '4': 'EQ',
  '5': 'NR',
  '6': 'MOD',
  '7': 'DLY',
  '8': 'RVB',
  '9': 'CAB',
  '10': 'MIC',
  COMP: 'COMP',
  EFX: 'EFX',
  AMP: 'AMP',
  EQ: 'EQ',
  NR: 'NR',
  MOD: 'MOD',
  DLY: 'DLY',
  RVB: 'RVB',
  CAB: 'CAB',
  MIC: 'MIC',
};

const MODEL_EQUIVALENCE_MAP: Readonly<Partial<Record<Mg300BlockCode, Readonly<Record<number, string>>>>> = {
  COMP: {
    1: 'Dyna Comp',
  },
  EFX: {
    1: 'MXR Dist+',
    2: 'RC Booster',
    3: 'AC Booster',
    4: 'Boss DS-1',
    5: 'TS808/TS9',
    6: 'Boss BD-2',
    7: 'Morning Glory',
    8: 'ProCo RAT',
    9: 'Crunch Box',
    10: 'Marshall Guv\'nor',
    11: 'Big Muff',
    12: 'Whammy',
  },
  AMP: {
    1: 'JC-120',
    2: 'Deluxe Reverb',
    3: 'Bassman',
    4: 'Tweed Deluxe',
    5: 'Twin Reverb',
    6: 'Hiwatt DR103',
    7: 'Mesa Mark Crunch',
    8: 'Vox AC15',
    9: 'Vox AC30',
    10: '1959SLP',
    11: 'JTM45',
    12: 'JCM800',
    13: '1987X',
    14: 'Soldano SLO-100',
    15: 'BE-100',
    16: 'Mesa Dual Rectifier',
    17: 'Diezel VH4',
    18: 'Vibro-King',
    19: 'Budda Superdrive',
    20: 'Dr. Z Maz 38',
    21: 'Super Reverb',
    22: 'Bluesbreaker',
    23: 'Matchless DC-30',
    24: 'JCM2000',
    25: 'Bogner Uberschall',
    26: 'Acoustic Preamp',
    27: 'Bass DI',
  },
};

const BLOCK_DIRECTIVE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    m: { type: 'INTEGER' },
    p: {
      type: 'ARRAY',
      items: { type: 'INTEGER' },
    },
  },
  required: ['m'],
};

const CAB_MIC_DIRECTIVE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    m: { type: 'INTEGER' },
  },
  required: ['m'],
};

export const TONE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'INTEGER' },
    name: { type: 'STRING' },
    bpm: { type: 'INTEGER' },
    tf: { type: 'INTEGER' },
    pv: { type: 'INTEGER' },
    iv: { type: 'INTEGER' },
    ic: { type: 'INTEGER' },
    b: {
      type: 'OBJECT',
      properties: {
        '1': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '2': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '3': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '4': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '5': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '6': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '7': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '8': BLOCK_DIRECTIVE_RESPONSE_SCHEMA,
        '9': CAB_MIC_DIRECTIVE_RESPONSE_SCHEMA,
        '10': CAB_MIC_DIRECTIVE_RESPONSE_SCHEMA,
      },
    },
  },
  required: ['intent', 'name', 'b'],
};

const NumericBlockDirectiveSchema = z.object({
  m: z.number().int().min(0).max(MG300_USER_IR_CAB_ID),
  p: z.array(z.number().finite()).nullish(),
});

const LegacyBlockDirectiveSchema = z.object({
  modelId: z.number().int().min(0).max(MG300_USER_IR_CAB_ID),
  params: z
    .union([z.array(z.number().finite()), z.record(z.string(), z.number().finite())])
    .nullish(),
});

const RawBlockDirectiveSchema = z.union([NumericBlockDirectiveSchema, LegacyBlockDirectiveSchema]);

const RawAiToneResponseSchema = z
  .object({
    intent: z.union([z.literal(0), z.literal(1), z.enum(['create_new', 'edit_existing'])]),
    name: z.string().trim().min(1).nullish(),
    presetName: z.string().trim().min(1).nullish(),
    bpm: z.number().finite().nullish(),
    tf: z.number().finite().nullish(),
    timeFlag: z.number().finite().nullish(),
    ic: z.number().finite().nullish(),
    irCut: z.number().finite().nullish(),
    iv: z.number().finite().nullish(),
    irVolume: z.number().finite().nullish(),
    pv: z.number().finite().nullish(),
    patchVolume: z.number().finite().nullish(),
    b: z.record(z.string(), RawBlockDirectiveSchema).nullish(),
    blocks: z.record(z.string(), RawBlockDirectiveSchema).nullish(),
  })
  .refine((data) => (data.name ?? data.presetName ?? '').length > 0, {
    message: 'Preset name is required',
  });

function buildPositionalCatalogTable(): string {
  const lines: string[] = [];

  for (const block of MG300_BLOCK_CATALOG) {
    const equivs = MODEL_EQUIVALENCE_MAP[block.code];
    const entries = block.models
      .filter((model) => !(block.code === 'CAB' && model.id === MG300_USER_IR_CAB_ID))
      .map((model) => {
        const equiv = equivs?.[model.id];
        const title = equiv ? `${model.id}=${model.name}(${equiv})` : `${model.id}=${model.name}`;
        if (model.params.length === 0) {
          return title;
        }
        const paramList = model.params
          .map((p) => (p.min !== 0 || p.max !== 100 ? `${p.label}:${p.min}..${p.max}` : p.label))
          .join(',');
        return `${title}[${paramList}]`;
      });

    lines.push(`${block.id}:${block.code}|${entries.join(';')}`);
  }

  return lines.join('\n');
}

const POSITIONAL_MG300_CATALOG = buildPositionalCatalogTable();

export const TONE_SYSTEM_INSTRUCTION = [
  'Você é um engenheiro de timbres especialista na NUX MG-300 (DSP TI TMS320C672x + NXP MIMXRT106x).',
  'CADEIA FIXA: COMP(1) -> EFX(2) -> AMP(3) -> EQ(4) -> NR(5) -> MOD(6) -> DLY(7) -> RVB(8) -> CAB/IR(9) + MIC(10).',
  'CATÁLOGO POSICIONAL MG-300 (m=0 significa Bypass; p[] segue a ordem exata dos parâmetros listados entre colchetes; faixa padrão 0..100):',
  POSITIONAL_MG300_CATALOG,
  'ENGENHARIA DE TIMBRE MG-300:',
  '- COMP(1): use 1=Red Comp em cleans estalados (funk/country/SRV/Mayer) ou antes de fuzz (11=Muf Dist) para sustain em bends (Gilmour). Em high-gain moderno/metal prefira m=0.',
  '- EFX(2)->AMP(3): para apertar high-gain/metal use 5=T Screamer (Level 65..75, Tone 55..65, Drive 10..25) antes de 14=SLO 100, 15=Friedman, 16=Dual Rect, 17=Die VH4 ou 12=Brit 800. Em blues/classic rock use 6=Blues Drive, 7=Morning Drive ou 2=RC Bst antes de 11=Plexi 45, 10=Plexi 100W, 22=Brit Blues ou 5=Twin Rvb. Para fuzz (não há Fuzz Face) use 11=Muf Dist (Sustain 48..62) em amp limpo de alto headroom (6=Hiwire ou 5=Twin Rvb) e compense o mid-scoop no EQ(4) (500Hz e 1.2kHz em 56..62).',
  '- EQ(4) 6-Band pós-amp (neutro=50): compense a guitarra do músico. Single-coil/Strat buscando corpo de Les Paul: 220Hz/500Hz em 56..62 e 2.6kHz/6.4kHz em 40..46. Humbucker buscando estalo de Strat: 100Hz/220Hz em 42..46 e 1.2kHz/2.6kHz em 55..60.',
  '- NR(5): em drive/fuzz/single-coil use Sens 25..38 e Decay 40..55 para limpar ruído sem cortar sustain de bends.',
  '- MOD(6): deixe m=0 quando a referência original for seca (ex.: Sweet Child O\' Mine, Still Got the Blues, Back in Black).',
  '- DLY(7)->RVB(8) EM SÉRIE (alta sensibilidade no DSP): todo drive do AMP entra no DLY e cada repetição entra no RVB. ATENÇÃO: 1=Analog Delay tem p=[Time, Echo(nível), Intensity(feedback)] (invertido!). Modelos 2..6 têm p=[Time, F.Back, Level/Mix, ...]. Em solos rock/blues (Sweet Child O\' Mine, Back in Black, Still Got the Blues) use DLY discreto (F.Back/Intensity 12..22, Level/Echo 14..24) e RVB 1=Room (base/rock direto) ou 3=Plate (solos clássicos) com Mix 14..22 e Decay 25..42 (em 2=Hall mantenha Pre.D>=20 e Liveliness<=45). Só use DLY/RVB altos se o músico pedir explicitamente ambient, shoegaze, delay longo ou muito reverb.',
  '- CAB(9)+MIC(10)+ic: pareie gabinete ao amp (1=Jazz 212, 5=Twin 212, 6=Custom 412 p/ Hiwire, 8/9=Blue 112/212 p/ Vox, 10=Green 412 p/ Plexi/JTM45, 12=T75 412 ou 13=V30 412 p/ Brit 800/Friedman/SLO/Dual Rect, 26=T814 p/ Stageman, 28=TRC 410 p/ MLD). MIC: 1=E906 (equilibrado/quente), 2=SM57 (ataque/médios cortantes), 3=U87 (cheio/aveludado), 4=C414 (brilho/ar). Se outputTarget for caixa ativa/FRFR/PA/linha/fone, mantenha AMP, CAB e MIC ativos e use ic=2 (Hi/Lo Cut).',
  'EXCEÇÕES CRÍTICAS DE HARDWARE:',
  '1) Nunca invente IDs fora do catálogo. EFX 12 (Pitch Bender): p=[Pitch(0..100), Range(0..1)].',
  '2) AMP 2 (Deluxe Rvb) e AMP 26 (Stageman) NÃO têm p1: envie 5 valores [Gain,Level,Bass,Middle,Treble].',
  '3) AMP 4 (Tweedy) tem apenas 3 valores: [Gain,Tone,Level].',
  '4) AMP 8 (Class A15), AMP 9 (Class A30) e AMP 23 (Match D30) NÃO têm Middle: envie 5 valores [Gain,Cut,Level,Bass,Treble].',
  '5) MOD 13 (Harmony): [MinorScale(0..1), Key(0..11), Harmo(0..9), Balance(0..100)].',
  '6) Se AMP m=0, CAB deve ter m=0. Nunca use CAB m=100 em intent=0 (create_new). Em intent=1 (edit_existing), se current.hasUserIr=true e o pedido não pedir troca de gabinete, omita o bloco "9" para preservar o User IR.',
  '7) ESCOLHA DE INTENT: use intent=0 (create_new) para criar um timbre novo do zero (nota: o template base liga NR(5) por padrão; envie "5":{"m":0} se quiser Noise Gate desligado). Use intent=1 (edit_existing) quando o músico pedir ajuste incremental sobre o preset atual ("current"), incluindo em "b" APENAS os blocos que mudam e omitindo blocos inalterados.',
  '8) METADADOS E FAIXAS EXATAS: bpm (40..240, omita se inalterado), tf (timeFlag: 0=ms, 1=BPM sync), pv (patchVolume: 0..100), iv (irVolume: 0..40, padrão ~20), ic (irCut: 0=off, 1=LoCut, 2=Hi/LoCut).',
  'SAÍDA ESTRITAMENTE NUMÉRICA (JSON): retorne apenas {intent:0|1, name:"<=18 ASCII", bpm?, tf?, pv?, iv?, ic?, b:{"1".."10":{m,p?}}}. ZERO texto livre, ZERO summary, ZERO tips.',
].join('\n');

function decodeCurrentPresetContext(struct102: Uint8Array): Record<string, unknown> {
  const blocks: Record<string, number[]> = {};
  for (const block of MG300_BLOCK_CATALOG) {
    const modelId = struct102[block.cc] ?? 0;
    if (modelId === 0 || block.structParamOffset === null) {
      blocks[String(block.id)] = [modelId];
      continue;
    }
    const spec = getMg300ModelSpec(block.id, modelId);
    if (!spec) {
      blocks[String(block.id)] = [modelId];
      continue;
    }
    const values = spec.params.map((p) => struct102[block.structParamOffset! + p.paramIndex] ?? 0);
    blocks[String(block.id)] = [modelId, ...values];
  }

  const hasUserIr = (struct102[0x09] ?? 0) === MG300_USER_IR_CAB_ID;

  return {
    presetName: decodeMg300PresetName(struct102),
    bpm: struct102[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] ?? 120,
    timeFlag: (struct102[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0,
    irCut: struct102[0x43] ?? 0,
    irVolume: struct102[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? 20,
    patchVolume: struct102[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? 50,
    ...(hasUserIr ? { hasUserIr: true, userIrName: decodeMg300UserIrName(struct102) } : {}),
    blocks,
  };
}

function normalizeIntent(rawIntent: 0 | 1 | 'create_new' | 'edit_existing'): AiToneIntent {
  if (rawIntent === 1 || rawIntent === 'edit_existing') {
    return 'edit_existing';
  }
  return 'create_new';
}

function toNormalizedPlan(parsed: z.infer<typeof RawAiToneResponseSchema>): AiTonePlan {
  const rawBlocks = parsed.b ?? parsed.blocks ?? {};
  const blocks: Partial<Record<Mg300BlockCode, AiBlockDirective>> = {};

  for (const [rawKey, rawDir] of Object.entries(rawBlocks)) {
    const code = BLOCK_KEY_TO_CODE[rawKey.trim().toUpperCase()];
    if (!code) {
      continue;
    }
    if ('m' in rawDir) {
      blocks[code] = {
        modelId: rawDir.m,
        ...(rawDir.p != null ? { params: rawDir.p } : {}),
      };
    } else {
      blocks[code] = {
        modelId: rawDir.modelId,
        ...(rawDir.params != null ? { params: rawDir.params } : {}),
      };
    }
  }

  const rawBpm = parsed.bpm;
  const bpm = rawBpm != null && rawBpm > 0 ? Math.round(rawBpm) : undefined;
  const rawTimeFlag = parsed.tf ?? parsed.timeFlag;
  const timeFlag = rawTimeFlag != null ? (Math.round(rawTimeFlag) > 0 ? 1 : 0) : undefined;
  const rawIrCut = parsed.ic ?? parsed.irCut;
  const irCut = rawIrCut != null ? Math.round(rawIrCut) : undefined;
  const rawIrVolume = parsed.iv ?? parsed.irVolume;
  const irVolume = rawIrVolume != null ? Math.round(rawIrVolume) : undefined;
  const rawPatchVolume = parsed.pv ?? parsed.patchVolume;
  const patchVolume = rawPatchVolume != null ? Math.round(rawPatchVolume) : undefined;

  return {
    intent: normalizeIntent(parsed.intent),
    presetName: (parsed.name ?? parsed.presetName ?? 'AI Tone').trim(),
    ...(bpm !== undefined ? { bpm } : {}),
    ...(timeFlag !== undefined ? { timeFlag } : {}),
    ...(irCut !== undefined ? { irCut } : {}),
    ...(irVolume !== undefined ? { irVolume } : {}),
    ...(patchVolume !== undefined ? { patchVolume } : {}),
    blocks,
  };
}

export function buildDeterministicSummary(
  calibrated: CalibratedToneResult,
  displayBank: string,
): string {
  const metaSuffix = `BPM ${calibrated.bpm}, P.LVL ${calibrated.calibration.appliedPatchVolume}`;

  if (calibrated.intent === 'edit_existing') {
    const changedParts = calibrated.appliedBlocks
      .filter((block) => block.changed)
      .map((block) => `${block.blockCode} ${block.enabled ? block.modelName : 'Bypass'}`);

    if (changedParts.length === 0) {
      return `Ajuste aplicado no slot ${displayBank} ("${calibrated.presetName}") nos parâmetros globais (${metaSuffix}).`;
    }
    return `Ajuste aplicado no slot ${displayBank} ("${calibrated.presetName}"): ${changedParts.join(' + ')} (${metaSuffix}).`;
  }

  const activeParts = calibrated.appliedBlocks
    .filter((block) => block.enabled)
    .map((block) => `${block.blockCode} ${block.modelName}`);

  if (activeParts.length === 0) {
    return `Novo timbre "${calibrated.presetName}" gravado no slot ${displayBank} em modo bypass (${metaSuffix}).`;
  }
  return `Novo timbre "${calibrated.presetName}" gravado no slot ${displayBank}: ${activeParts.join(' + ')} (${metaSuffix}).`;
}

function isDirectOrFrfrOutput(outputTarget: string): boolean {
  const normalized = outputTarget
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(frfr|caixa ativa|pa|linha|line|fone|headphone|interface|monitor|direto|mesa)\b/.test(
    normalized,
  );
}

export function buildDeterministicTips(
  calibrated: CalibratedToneResult,
  gear: AiGearConfig,
): string[] {
  const tips: string[] = [];
  const addTip = (candidate: string): void => {
    const clean = candidate.trim();
    if (!clean || tips.length >= 3) {
      return;
    }
    const lower = clean.toLowerCase();
    if (!tips.some((existing) => existing.toLowerCase() === lower)) {
      tips.push(clean);
    }
  };

  const pickupLower = gear.pickupSummary.toLowerCase();
  const ampActive = (calibrated.struct102[0x03] ?? 0) > 0;
  const ampGain = ampActive ? (calibrated.struct102[0x1a] ?? 0) : 0;
  const efxModel = calibrated.struct102[0x02] ?? 0;
  const hasDrive = ampGain >= 55 || (efxModel >= 1 && efxModel <= 11);
  const hasUserIr = (calibrated.struct102[0x09] ?? 0) === MG300_USER_IR_CAB_ID;
  const irCut = calibrated.struct102[0x43] ?? 0;
  const hasDirectOutput = gear.outputTarget.trim().length > 0 && isDirectOrFrfrOutput(gear.outputTarget);

  // 1. Guitar & pickup tip
  if (hasDrive) {
    if (pickupLower.includes('hss')) {
      addTip(
        `Na ${gear.guitarModel}, use o humbucker da ponte para maior definição no drive e recue levemente o Tone para suavizar agudos em solos.`,
      );
    } else if (pickupLower.includes('single') || /\bsss\b/.test(pickupLower)) {
      addTip(
        `Com captadores single-coil (${gear.pickupSummary}) na ${gear.guitarModel}, teste recuar o controle de Tone para 7–8 para arredondar agudos no drive.`,
      );
    } else if (pickupLower.includes('humbucker') || /\bhh\b/.test(pickupLower)) {
      addTip(
        `Na ${gear.guitarModel} (${gear.pickupSummary}), use a ponte para bases firmes e alterne para o braço em solos mais encorpados.`,
      );
    } else {
      addTip(
        `Na ${gear.guitarModel} (${gear.pickupSummary}), controle a saturação pelo volume da guitarra para limpar a dinâmica sem trocar de preset.`,
      );
    }
  } else {
    addTip(
      `Na ${gear.guitarModel} (${gear.pickupSummary}), explore o captador do braço ou posições intermediárias para máxima clareza neste timbre.`,
    );
  }

  // 2. Output target / IR Cut / User IR tip
  if (hasUserIr) {
    addTip(
      hasDirectOutput
        ? `User IR personalizado preservado no bloco CAB; mantenha a saída (${gear.outputTarget}) com EQ flat para fidelidade máxima.`
        : 'Seu User IR personalizado no bloco CAB foi preservado intacto neste ajuste.',
    );
  } else if (hasDirectOutput) {
    addTip(
      irCut === 2
        ? `IR Cut (Hi/Lo Cut) ativado para ${gear.outputTarget}; mantenha a caixa/PA com EQ flat para evitar sobra de subgraves e agudos.`
        : `Para tocar em ${gear.outputTarget}, mantenha o EQ da caixa em flat e faça ajustes finos de brilho direto no EQ/CAB da MG-300.`,
    );
  } else if (irCut === 2) {
    addTip('IR Cut (Hi/Lo Cut) ativado no bloco CAB para conter subgraves e agudos excessivos.');
  }

  // 3. Stored gear recommendation or contextual chain tip
  const firstGearRec = gear.recommendations.find((rec) => rec.trim().length > 0);
  if (firstGearRec) {
    addTip(firstGearRec);
  } else if (efxModel === 11) {
    addTip('O fuzz Muf Dist responde muito bem ao volume da guitarra para limpar ou saturar o ataque.');
  } else if ((calibrated.struct102[0x07] ?? 0) > 0 || (calibrated.struct102[0x08] ?? 0) > 0) {
    addTip(
      `Ambiência calibrada para manter a clareza das notas; use o Tap Tempo (BPM ${calibrated.bpm}) se precisar sincronizar o delay à música.`,
    );
  }

  return tips.slice(0, 3);
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

    const { saveResult, experimentalState } =
      await this.experimentalEdit.applyExternalTransform(
        request.slotIndex,
        async (existingStruct) => {
          const userPrompt = JSON.stringify({
            slot: {
              slotIndex: request.slotIndex,
              displayBank: coord.displayBank,
            },
            gear: {
              guitarModel: gear.guitarModel,
              outputTarget: gear.outputTarget || 'Não informado (use CAB/IR equilibrado)',
              pickupSummary: gear.pickupSummary,
            },
            baseline: {
              avgPatchVolume: baseline.avgPatchVolume,
              avgIrVolume: baseline.avgIrVolume,
              avgAmpLevel: baseline.avgAmpLevel,
            },
            current: decodeCurrentPresetContext(existingStruct),
            request: request.prompt,
          });

          const rawAiResponse = await this.geminiClient.generateJson<unknown>({
            systemInstruction: TONE_SYSTEM_INSTRUCTION,
            userPrompt,
            responseSchema: TONE_RESPONSE_SCHEMA,
            temperature: 0.25,
            maxOutputTokens: 640,
            thinkingBudget: 0,
          });

          const parsedPlan = RawAiToneResponseSchema.safeParse(rawAiResponse);
          if (!parsedPlan.success) {
            throw new AiServiceError(
              'AI_UNAVAILABLE',
              'A IA retornou um formato de timbre inválido para a NUX MG-300.',
              503,
            );
          }

          const validatedPlan = toNormalizedPlan(parsedPlan.data);
          calibrated = buildAndCalibrateStruct102({
            plan: validatedPlan,
            existingStruct,
            baseline,
            userPrompt: request.prompt,
          });
          return calibrated.struct102;
        },
      );

    if (!calibrated) {
      throw new AiServiceError(
        'AI_UNAVAILABLE',
        'Falha inesperada ao processar o timbre gerado pela IA.',
        503,
      );
    }

    const finalCalibrated: CalibratedToneResult = calibrated;

    return {
      slotIndex: request.slotIndex,
      displayBank: saveResult.displayBank,
      intent: finalCalibrated.intent,
      presetName: finalCalibrated.presetName,
      bpm: finalCalibrated.bpm,
      timeFlag: finalCalibrated.timeFlag,
      summary: buildDeterministicSummary(finalCalibrated, saveResult.displayBank),
      tips: buildDeterministicTips(finalCalibrated, gear),
      appliedBlocks: finalCalibrated.appliedBlocks,
      calibration: finalCalibrated.calibration,
      saveResult,
      experimentalState,
    };
  }
}
