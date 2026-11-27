import fs from 'node:fs';
import path from 'node:path';
import {
  MG300_BLOCK_CATALOG,
  MG300_FACTORY_PRESET_NAME_SET,
  MG300_FILE_FORMAT,
  MG300_PARAM_BLOCKS,
  MG300_USER_IR_CAB_ID,
  type AiAppliedBlockSummary,
  type AiOutputCalibrationSummary,
  type AiToneIntent,
  type Mg300BlockCode,
  createBlankMg300Struct102,
  decodeMg300PresetName,
  encodeMg300PresetName,
  getMg300BlockCatalog,
  getMg300ModelDefaultParams,
  getMg300ModelSpec,
  isValidMg300BlockModel,
  normalizePresetName,
  sanitizeMg300PresetName,
  sanitizeStruct102ForSysEx,
} from '@quicktone/shared';
import { parseNuxPresetWithStruct102 } from '@quicktone/reader';
import { MONOREPO_ROOT } from '../env.js';

export type CalibrationSource = 'hardware_user' | 'nuxpreset_files' | 'factory_default';

export interface CalibrationBaseline {
  source: CalibrationSource;
  sampleCount: number;
  avgPatchVolume: number;
  avgIrVolume: number;
  avgAmpLevel: number;
  avgOutputScore: number;
}

export interface AiBlockDirective {
  modelId: number;
  params?: Record<string, number> | number[];
}

export interface AiTonePlan {
  intent: AiToneIntent;
  presetName: string;
  bpm?: number;
  timeFlag?: number;
  irCut?: number;
  irVolume?: number;
  patchVolume?: number;
  blocks?: Partial<Record<Mg300BlockCode, AiBlockDirective>>;
  summary?: string;
  tips?: string[];
}

export interface CalibratedToneResult {
  struct102: Uint8Array;
  intent: AiToneIntent;
  presetName: string;
  bpm: number;
  timeFlag: number;
  appliedBlocks: AiAppliedBlockSummary[];
  calibration: AiOutputCalibrationSummary;
}

const DEFAULT_AMP_LEVEL = 65;
const DEFAULT_IR_VOLUME = 20;
const DEFAULT_PATCH_VOLUME = 50;
const DLY_PARAM_OFFSET = 0x36;
const RVB_PARAM_OFFSET = 0x3d;

const HEAVY_AMBIENCE_PATTERNS: readonly RegExp[] = [
  /\bambient\b/,
  /\bshoegaze\b/,
  /\bpost[- ]?rock\b/,
  /\bdream[- ]?pop\b/,
  /\bcathedral\b/,
  /\bcatedral\b/,
  /\bwash\b/,
  /\bshimmer\b/,
  /\bespacial\b/,
  /\bspatial\b/,
  /\bthe\s+edge\b/,
  /\b(?:delay|eco)\s+(?:longo|carregado|pesado|forte|alto|intenso|profundo|infinito)\b/,
  /\b(?:muito|mais|bastante|aumentar|aumenta|subir|sobe|dobrar|dobra)\s+(?:o\s+)?(?:delay|eco)\b/,
  /\breverb\s+(?:longo|carregado|pesado|forte|alto|intenso|profundo|enorme|gigante|grande)\b/,
  /\b(?:muito|mais|bastante|aumentar|aumenta|subir|sobe|dobrar|dobra)\s+(?:o\s+)?reverb\b/,
  /\b(?:more|long|heavy|high)\s+(?:delay|reverb)\b/,
];

/**
 * Detects whether the musician explicitly requested ambient/heavy delay/reverb or asked to
 * raise delay/reverb, so deterministic ambience clamping does not fight intentional wet tones.
 */
export function isAmbientOrHeavyAmbienceRequest(prompt?: string): boolean {
  if (!prompt || !prompt.trim()) {
    return false;
  }
  const normalized = prompt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return HEAVY_AMBIENCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function computeEqFactor(struct102: Uint8Array): number {
  if ((struct102[0x04] ?? 0) === 0) {
    return 1.0;
  }
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    sum += struct102[0x21 + i] ?? 50;
  }
  const avgBand = sum / 6;
  return clampFloat(1 + ((avgBand - 50) / 100) * 0.3, 0.7, 1.3);
}

/**
 * Deterministic proxy for perceived MG-300 patch output loudness combining
 * patchVolume (CC 74), CAB/IR volume (CC 71), AMP Level (CC 25), COMP Output,
 * EFX Level (excluding EFX 12 Pitch Bender where p0 is Pitch), and 6-band EQ average.
 */
export function computeStruct102OutputScore(struct102: Uint8Array): number {
  const patchVolume = struct102[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? DEFAULT_PATCH_VOLUME;
  const cabActive = (struct102[0x09] ?? 0) > 0;
  const irVolume = struct102[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? DEFAULT_IR_VOLUME;
  const ampActive = (struct102[0x03] ?? 0) > 0;
  const ampLevel = ampActive ? (struct102[0x1c] ?? DEFAULT_AMP_LEVEL) : 50;
  const compActive = (struct102[0x01] ?? 0) > 0;
  const compOutput = struct102[0x0c] ?? 50;
  const efxModel = struct102[0x02] ?? 0;
  const efxActive = efxModel > 0 && efxModel !== 12;
  const efxLevel = struct102[0x13] ?? 50;

  const patchFactor = patchVolume / 50;
  const irFactor = cabActive ? 0.6 + 0.4 * (irVolume / 20) : 1.0;
  const ampFactor = ampLevel / 65;
  const compFactor = compActive ? 0.75 + 0.5 * (compOutput / 100) : 1.0;
  const efxFactor = efxActive ? 0.75 + 0.5 * (efxLevel / 100) : 1.0;
  const eqFactor = computeEqFactor(struct102);

  return patchFactor * irFactor * ampFactor * compFactor * efxFactor * eqFactor;
}

function isBlankOrPlaceholderStruct(struct102: Uint8Array): boolean {
  const name = normalizePresetName(decodeMg300PresetName(struct102));
  if (!name || name === 'new preset' || name === 'imported') {
    return true;
  }
  return /^user\s+f?[1-9][a-d]$/i.test(name);
}

function isFactoryCopyStruct(struct102: Uint8Array): boolean {
  const name = normalizePresetName(decodeMg300PresetName(struct102));
  return name.length > 0 && MG300_FACTORY_PRESET_NAME_SET.has(name);
}

function computeBaselineFromStructs(
  source: CalibrationSource,
  structs: readonly Uint8Array[],
): CalibrationBaseline {
  if (structs.length === 0) {
    const baselineStruct = createBlankMg300Struct102({
      patchVolume: DEFAULT_PATCH_VOLUME,
      irVolume: DEFAULT_IR_VOLUME,
    });
    baselineStruct[0x1c] = DEFAULT_AMP_LEVEL;
    return {
      source: 'factory_default',
      sampleCount: 0,
      avgPatchVolume: DEFAULT_PATCH_VOLUME,
      avgIrVolume: DEFAULT_IR_VOLUME,
      avgAmpLevel: DEFAULT_AMP_LEVEL,
      avgOutputScore: computeStruct102OutputScore(baselineStruct),
    };
  }

  let patchVolSum = 0;
  let irVolSum = 0;
  let irCount = 0;
  let ampLevelSum = 0;
  let ampCount = 0;
  let scoreSum = 0;

  for (const s of structs) {
    patchVolSum += s[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? DEFAULT_PATCH_VOLUME;
    if ((s[0x09] ?? 0) > 0) {
      irVolSum += s[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? DEFAULT_IR_VOLUME;
      irCount += 1;
    }
    if ((s[0x03] ?? 0) > 0) {
      ampLevelSum += s[0x1c] ?? DEFAULT_AMP_LEVEL;
      ampCount += 1;
    }
    scoreSum += computeStruct102OutputScore(s);
  }

  const avgPatchVolume = roundToOneDecimal(
    clampFloat(patchVolSum / structs.length, 40, 70),
  );
  const avgIrVolume = roundToOneDecimal(
    clampFloat(irCount > 0 ? irVolSum / irCount : DEFAULT_IR_VOLUME, 15, 25),
  );
  const avgAmpLevel = roundToOneDecimal(
    clampFloat(ampCount > 0 ? ampLevelSum / ampCount : DEFAULT_AMP_LEVEL, 45, 90),
  );
  const avgOutputScore = clampFloat(scoreSum / structs.length, 0.65, 1.6);

  return {
    source,
    sampleCount: structs.length,
    avgPatchVolume,
    avgIrVolume,
    avgAmpLevel,
    avgOutputScore,
  };
}

function collectNuxPresetStructsFromDirs(directories: readonly (string | null | undefined)[]): Uint8Array[] {
  const uniqueDirs = Array.from(
    new Set(
      directories
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d) => path.resolve(d)),
    ),
  );

  const structs: Uint8Array[] = [];
  for (const dir of uniqueDirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.nuxpreset')) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const buf = fs.readFileSync(fullPath);
        const parsed = parseNuxPresetWithStruct102(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          { sourceFile: fullPath },
        );
        for (const item of parsed.entries) {
          if (!isBlankOrPlaceholderStruct(item.struct102)) {
            structs.push(item.struct102);
          }
        }
      } catch {
        // Ignore corrupt/non-MG300 files when building calibration averages
      }
    }
  }
  return structs;
}

export function resolveCalibrationBaseline(options: {
  knownUserStructs?: ReadonlyMap<number, Uint8Array>;
  presetsDirectory?: string | null;
  calibrationDir?: string | null;
}): CalibrationBaseline {
  const hardwareList = options.knownUserStructs
    ? Array.from(options.knownUserStructs.values())
    : [];

  if (hardwareList.length > 0) {
    const customUserStructs = hardwareList.filter(
      (s) => !isBlankOrPlaceholderStruct(s) && !isFactoryCopyStruct(s),
    );
    if (customUserStructs.length > 0) {
      return computeBaselineFromStructs('hardware_user', customUserStructs);
    }
    const nonBlankStructs = hardwareList.filter((s) => !isBlankOrPlaceholderStruct(s));
    if (nonBlankStructs.length > 0) {
      return computeBaselineFromStructs('hardware_user', nonBlankStructs);
    }
  }

  const defaultFilesDir = path.resolve(MONOREPO_ROOT, 'files', 'nuxpreset');
  const fileStructs = collectNuxPresetStructsFromDirs([
    options.presetsDirectory,
    options.calibrationDir ?? defaultFilesDir,
  ]);
  if (fileStructs.length > 0) {
    return computeBaselineFromStructs('nuxpreset_files', fileStructs);
  }

  return computeBaselineFromStructs('factory_default', []);
}

function resolveParamValueByInput(
  paramLabel: string,
  paramIndex: number,
  declaredPosition: number,
  usePackedArrayOrder: boolean,
  rawParams: Record<string, number> | number[] | undefined,
): number | undefined {
  if (!rawParams) {
    return undefined;
  }
  if (Array.isArray(rawParams)) {
    const idx = usePackedArrayOrder ? declaredPosition : paramIndex;
    const val = rawParams[idx];
    return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
  }

  const exact = rawParams[paramLabel];
  if (typeof exact === 'number' && Number.isFinite(exact)) {
    return exact;
  }

  const targetLower = paramLabel.trim().toLowerCase();
  for (const [key, val] of Object.entries(rawParams)) {
    if (typeof val === 'number' && Number.isFinite(val) && key.trim().toLowerCase() === targetLower) {
      return val;
    }
  }

  const indexKey = rawParams[String(paramIndex)] ?? rawParams[`p${paramIndex}`];
  return typeof indexKey === 'number' && Number.isFinite(indexKey) ? indexKey : undefined;
}

function applyParamBlockDirective(
  out: Uint8Array,
  blockId: number,
  directive: AiBlockDirective,
  intent: AiToneIntent,
  existingStruct: Uint8Array,
): void {
  const blockMeta = getMg300BlockCatalog(blockId);
  if (!blockMeta || blockMeta.structParamOffset === null) {
    return;
  }

  const requestedModel = Number.isInteger(directive.modelId) ? directive.modelId : 0;
  if (!isValidMg300BlockModel(blockMeta.cc, requestedModel)) {
    return;
  }

  const previousModel = existingStruct[blockMeta.cc] ?? 0;
  out[blockMeta.cc] = requestedModel;

  if (requestedModel === 0) {
    // In edit_existing, preserve inactive parameter bytes of bypassed blocks untouched.
    return;
  }

  const spec = getMg300ModelSpec(blockId, requestedModel);
  if (!spec) {
    return;
  }

  const baseParams =
    intent === 'edit_existing' && previousModel === requestedModel
      ? Array.from(
          existingStruct.subarray(blockMeta.structParamOffset, blockMeta.structParamOffset + 6),
        )
      : getMg300ModelDefaultParams(blockId, requestedModel);

  const declaredIndices = new Set(spec.params.map((p) => p.paramIndex));
  for (let i = 0; i < 6; i++) {
    if (!declaredIndices.has(i)) {
      baseParams[i] = 0;
    }
  }

  // Models with a paramIndex gap (e.g. AMP 2/26 skipping p1, AMP 8/9/23 skipping p4) may receive
  // either a full 6-slot array indexed by paramIndex or a packed array matching spec.params order.
  const hasParamIndexGap = spec.params.some((p, idx) => p.paramIndex !== idx);
  const usePackedArrayOrder =
    Array.isArray(directive.params) &&
    hasParamIndexGap &&
    directive.params.length <= spec.params.length;

  for (let declaredPosition = 0; declaredPosition < spec.params.length; declaredPosition++) {
    const paramSpec = spec.params[declaredPosition]!;
    const provided = resolveParamValueByInput(
      paramSpec.label,
      paramSpec.paramIndex,
      declaredPosition,
      usePackedArrayOrder,
      directive.params,
    );
    const candidate = provided !== undefined ? provided : (baseParams[paramSpec.paramIndex] ?? 0);
    baseParams[paramSpec.paramIndex] = clampInt(candidate, paramSpec.min, paramSpec.max);
  }

  out.set(baseParams.slice(0, 6), blockMeta.structParamOffset);
}

function pickSafeFallbackCabId(ampModelId: number): number {
  const ampSpec = getMg300ModelSpec(3, ampModelId);
  if (ampSpec?.category === 'acoustic') {
    return 26; // T814
  }
  if (ampSpec?.category === 'bass') {
    return 28; // TRC 410
  }
  return 5; // Twin 212
}

function applyCabAndMicDirectives(
  out: Uint8Array,
  plan: AiTonePlan,
  intent: AiToneIntent,
  existingStruct: Uint8Array,
): void {
  const cabDirective = plan.blocks?.CAB;
  if (cabDirective) {
    let nextCab = Number.isInteger(cabDirective.modelId) ? cabDirective.modelId : 0;
    if (nextCab === MG300_USER_IR_CAB_ID) {
      const hadUserIr = (existingStruct[0x09] ?? 0) === MG300_USER_IR_CAB_ID;
      if (intent === 'create_new' || !hadUserIr) {
        nextCab = pickSafeFallbackCabId(out[0x03] ?? 1);
      }
    }
    out[0x09] = isValidMg300BlockModel(9, nextCab) ? nextCab : 0;
  }

  const micDirective = plan.blocks?.MIC;
  if (micDirective) {
    const nextMic = Number.isInteger(micDirective.modelId) ? micDirective.modelId : 0;
    if (isValidMg300BlockModel(10, nextMic)) {
      out[0x0a] = nextMic;
    }
  }

  // Hardware rule: when AMP is bypassed (0), firmware forces CAB to 0.
  if ((out[0x03] ?? 0) === 0) {
    out[0x09] = 0;
  }

  // If User IR is not active, clear/reset custom IR name marker to 0x10 (unless edit_existing left CAB=100).
  if ((out[0x09] ?? 0) !== MG300_USER_IR_CAB_ID) {
    if (intent === 'create_new' || (existingStruct[0x09] ?? 0) === MG300_USER_IR_CAB_ID) {
      out[0x57] = 0x10;
      out.fill(0, 0x58, 0x62);
    }
  }
}

function applyCreateNewCalibration(out: Uint8Array, baseline: CalibrationBaseline): void {
  const targetIrVol = clampInt(Math.round(baseline.avgIrVolume), 15, 25);
  out[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = targetIrVol;

  if ((out[0x01] ?? 0) > 0) {
    out[0x0c] = clampInt(out[0x0c] ?? 50, 40, 65);
  }
  if ((out[0x02] ?? 0) > 0 && (out[0x02] ?? 0) !== 12) {
    out[0x13] = clampInt(out[0x13] ?? 55, 40, 75);
  }

  const maxAllowedScore = baseline.avgOutputScore * 1.08;
  const minDesiredScore = baseline.avgOutputScore * 0.72;

  if (computeStruct102OutputScore(out) > maxAllowedScore && (out[0x03] ?? 0) > 0) {
    const currentScore = computeStruct102OutputScore(out);
    const currentAmp = out[0x1c] ?? DEFAULT_AMP_LEVEL;
    const scaledAmp = clampInt(Math.floor(currentAmp * (maxAllowedScore / currentScore)), 35, 90);
    out[0x1c] = scaledAmp;
  }

  if (computeStruct102OutputScore(out) > maxAllowedScore) {
    const currentScore = computeStruct102OutputScore(out);
    const currentPatch = out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? DEFAULT_PATCH_VOLUME;
    const scaledPatch = clampInt(
      Math.floor(currentPatch * (maxAllowedScore / currentScore)),
      20,
      75,
    );
    out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] = scaledPatch;
  }

  if (computeStruct102OutputScore(out) < minDesiredScore) {
    if ((out[0x03] ?? 0) > 0) {
      const currentScore = Math.max(0.1, computeStruct102OutputScore(out));
      const currentAmp = out[0x1c] ?? DEFAULT_AMP_LEVEL;
      out[0x1c] = clampInt(Math.round(currentAmp * (baseline.avgOutputScore / currentScore)), 45, 85);
    }
    if (computeStruct102OutputScore(out) < minDesiredScore) {
      const currentScore = Math.max(0.1, computeStruct102OutputScore(out));
      const currentPatch = out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? DEFAULT_PATCH_VOLUME;
      out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] = clampInt(
        Math.round(currentPatch * (baseline.avgOutputScore / currentScore)),
        40,
        70,
      );
    }
  }
}

function applyEditExistingCalibration(
  out: Uint8Array,
  existingStruct: Uint8Array,
  baseline: CalibrationBaseline,
): void {
  const baselineScore = computeStruct102OutputScore(existingStruct);
  const ceiling = Math.max(baselineScore * 1.12, baseline.avgOutputScore * 1.12);
  if (computeStruct102OutputScore(out) > ceiling && (out[0x03] ?? 0) > 0) {
    const currentScore = computeStruct102OutputScore(out);
    const currentAmp = out[0x1c] ?? DEFAULT_AMP_LEVEL;
    out[0x1c] = clampInt(Math.floor(currentAmp * (ceiling / currentScore)), 35, 95);
  }
}

function isHighGainTone(out: Uint8Array): boolean {
  if ((out[0x03] ?? 0) > 0 && (out[0x1a] ?? 0) >= 55) {
    return true;
  }
  const efxModel = out[0x02] ?? 0;
  if (efxModel > 0 && efxModel !== 12) {
    // EFX 1..3 (Dist+, RC Bst, AC Bst) store Distortion/Gain at p1 (0x14);
    // EFX 4..11 (Dist Uno..Muf Dist) store Drive/Gain/Distortion/Sustain at p2 (0x15).
    const efxDrive = efxModel <= 3 ? (out[0x14] ?? 0) : (out[0x15] ?? 0);
    if (efxDrive >= 50) {
      return true;
    }
  }
  return false;
}

function getSpecParamOffset(
  blockId: number,
  modelId: number,
  paramLabel: string,
  baseOffset: number,
): number | null {
  const spec = getMg300ModelSpec(blockId, modelId);
  const param = spec?.params.find((p) => p.label === paramLabel);
  return param ? baseOffset + param.paramIndex : null;
}

/**
 * Calibrates DLY and RVB deterministically for the MG-300's series `AMP -> DLY -> RVB` DSP chain
 * so rock/blues/solo tones stay clear and non-resonant while honoring explicit ambient requests.
 */
function applyAmbienceCalibration(
  out: Uint8Array,
  plan: AiTonePlan,
  intent: AiToneIntent,
  userPrompt?: string,
): void {
  const shouldCalibrateDly = intent === 'create_new' || plan.blocks?.DLY !== undefined;
  const shouldCalibrateRvb = intent === 'create_new' || plan.blocks?.RVB !== undefined;
  const dlyModel = out[0x07] ?? 0;
  const rvbModel = out[0x08] ?? 0;
  const isAmbient = isAmbientOrHeavyAmbienceRequest(userPrompt);

  if (isAmbient) {
    const ceiling = intent === 'create_new' ? 75 : 65;
    if (shouldCalibrateDly && dlyModel >= 1 && dlyModel <= 6) {
      out[DLY_PARAM_OFFSET + 1] = clampInt(out[DLY_PARAM_OFFSET + 1] ?? 0, 0, ceiling);
      out[DLY_PARAM_OFFSET + 2] = clampInt(out[DLY_PARAM_OFFSET + 2] ?? 0, 0, ceiling);
    }
    if (shouldCalibrateRvb && rvbModel > 0) {
      const mixOffset = getSpecParamOffset(8, rvbModel, 'Mix', RVB_PARAM_OFFSET);
      if (mixOffset !== null) {
        out[mixOffset] = clampInt(out[mixOffset] ?? 0, 0, ceiling);
      }
      if (intent === 'edit_existing') {
        const decayOffset = getSpecParamOffset(8, rvbModel, 'Decay', RVB_PARAM_OFFSET);
        if (decayOffset !== null) {
          out[decayOffset] = clampInt(out[decayOffset] ?? 0, 0, ceiling);
        }
      }
    }
    return;
  }

  const highGain = isHighGainTone(out);

  if (shouldCalibrateDly && dlyModel > 0) {
    if (dlyModel === 1) {
      // Analog Delay reverses p1/p2 relative to other delays: p1=Echo (level), p2=Intensity (feedback).
      out[DLY_PARAM_OFFSET + 1] = clampInt(out[DLY_PARAM_OFFSET + 1] ?? 20, 12, highGain ? 24 : 28);
      out[DLY_PARAM_OFFSET + 2] = clampInt(out[DLY_PARAM_OFFSET + 2] ?? 16, 10, highGain ? 20 : 24);
    } else if (dlyModel >= 2 && dlyModel <= 6) {
      // Digi Delay, Modulate, Tape Echo, Reverse, Pan: p1=F.Back, p2=Level/Mix.
      out[DLY_PARAM_OFFSET + 1] = clampInt(out[DLY_PARAM_OFFSET + 1] ?? 18, 12, highGain ? 22 : 26);
      out[DLY_PARAM_OFFSET + 2] = clampInt(out[DLY_PARAM_OFFSET + 2] ?? 20, 12, highGain ? 24 : 28);
      if (dlyModel === 3) {
        out[DLY_PARAM_OFFSET + 3] = clampInt(out[DLY_PARAM_OFFSET + 3] ?? 15, 0, 30);
      }
    }
  }

  if (shouldCalibrateRvb && rvbModel > 0) {
    const mixOffset = getSpecParamOffset(8, rvbModel, 'Mix', RVB_PARAM_OFFSET);
    if (mixOffset !== null) {
      out[mixOffset] = clampInt(out[mixOffset] ?? 18, 10, highGain ? 22 : 26);
    }

    const decayOffset = getSpecParamOffset(8, rvbModel, 'Decay', RVB_PARAM_OFFSET);
    if (decayOffset !== null) {
      const maxDecay = highGain && (rvbModel === 2 || rvbModel === 3) ? 42 : 48;
      out[decayOffset] = clampInt(out[decayOffset] ?? 32, 20, maxDecay);
    }

    if (rvbModel === 2) {
      const preDelayOffset = getSpecParamOffset(8, rvbModel, 'Pre.D', RVB_PARAM_OFFSET);
      if (preDelayOffset !== null) {
        out[preDelayOffset] = clampInt(out[preDelayOffset] ?? 25, 20, 60);
      }
      const livelinessOffset = getSpecParamOffset(8, rvbModel, 'Liveliness', RVB_PARAM_OFFSET);
      if (livelinessOffset !== null) {
        out[livelinessOffset] = clampInt(out[livelinessOffset] ?? 30, 15, 45);
      }
    }
  }
}

function buildAppliedBlocksSummary(
  finalStruct: Uint8Array,
  existingStruct: Uint8Array,
  intent: AiToneIntent,
): AiAppliedBlockSummary[] {
  const summaries: AiAppliedBlockSummary[] = [];

  for (const block of MG300_BLOCK_CATALOG) {
    const modelId = finalStruct[block.cc] ?? 0;
    const prevModelId = existingStruct[block.cc] ?? 0;
    const spec = modelId > 0 ? getMg300ModelSpec(block.id, modelId) : undefined;
    const params: Array<{ label: string; value: number | string }> = [];
    let paramsChanged = false;

    if (spec && block.structParamOffset !== null) {
      for (const paramSpec of spec.params) {
        const rawValue = finalStruct[block.structParamOffset + paramSpec.paramIndex] ?? 0;
        const prevValue = existingStruct[block.structParamOffset + paramSpec.paramIndex] ?? 0;
        if (rawValue !== prevValue) {
          paramsChanged = true;
        }
        let displayValue: number | string = rawValue;
        if (paramSpec.controlType === 'toggle') {
          displayValue = rawValue > 0 ? 'ON' : 'OFF';
        } else if (paramSpec.controlType === 'select' && paramSpec.options) {
          const opt = paramSpec.options.find((o) => o.value === rawValue);
          displayValue = opt ? opt.label : rawValue;
        }
        params.push({ label: paramSpec.label, value: displayValue });
      }
    }

    const changed =
      intent === 'create_new'
        ? modelId > 0
        : modelId !== prevModelId || (modelId > 0 && paramsChanged);

    summaries.push({
      blockCode: block.code,
      enabled: modelId > 0,
      modelName: modelId === 0 ? 'Bypass' : (spec?.name ?? `Model ${modelId}`),
      params,
      changed,
    });
  }

  return summaries;
}

export function buildAndCalibrateStruct102(options: {
  plan: AiTonePlan;
  existingStruct: Uint8Array;
  baseline: CalibrationBaseline;
  userPrompt?: string;
}): CalibratedToneResult {
  const { plan, existingStruct, baseline, userPrompt } = options;
  const intent: AiToneIntent = plan.intent === 'edit_existing' ? 'edit_existing' : 'create_new';

  const safeName = sanitizeMg300PresetName(
    plan.presetName || decodeMg300PresetName(existingStruct) || 'AI Tone',
    'AI Tone',
  );
  const defaultBpm = existingStruct[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] ?? 120;
  const bpm = clampInt(plan.bpm ?? (intent === 'edit_existing' ? defaultBpm : 120), 40, 240);
  const timeFlag =
    plan.timeFlag !== undefined
      ? plan.timeFlag === 1
        ? 1
        : 0
      : intent === 'edit_existing'
        ? (existingStruct[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0
          ? 1
          : 0
        : 0;

  const out =
    intent === 'edit_existing'
      ? Uint8Array.from(existingStruct.subarray(0, MG300_FILE_FORMAT.PRESET_STRUCT_SIZE))
      : createBlankMg300Struct102({
          name: safeName,
          bpm,
          timeFlag,
          patchVolume: clampInt(Math.round(baseline.avgPatchVolume), 40, 70),
          irVolume: clampInt(Math.round(baseline.avgIrVolume), 15, 25),
          irCut: clampInt(plan.irCut ?? 0, 0, 2),
        });

  if (intent === 'edit_existing') {
    const encodedName = encodeMg300PresetName(safeName);
    out[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = encodedName.length;
    out.set(encodedName.bytes, MG300_FILE_FORMAT.NAME_CHARS_OFFSET);
    out[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] = bpm;
    out[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = timeFlag;
    if (plan.irCut !== undefined) {
      out[0x43] = clampInt(plan.irCut, 0, 2);
    }
    if (plan.irVolume !== undefined) {
      out[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = clampInt(plan.irVolume, 0, 40);
    }
    if (plan.patchVolume !== undefined) {
      out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] = clampInt(plan.patchVolume, 0, 100);
    }
  } else {
    if (plan.patchVolume !== undefined) {
      out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] = clampInt(plan.patchVolume, 35, 75);
    }
    if (plan.irVolume !== undefined) {
      out[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = clampInt(plan.irVolume, 15, 25);
    }
  }

  for (const paramBlock of MG300_PARAM_BLOCKS) {
    const directive = plan.blocks?.[paramBlock.code];
    if (directive) {
      applyParamBlockDirective(out, paramBlock.id, directive, intent, existingStruct);
    }
  }

  applyCabAndMicDirectives(out, plan, intent, existingStruct);

  if (intent === 'create_new') {
    applyCreateNewCalibration(out, baseline);
  } else {
    applyEditExistingCalibration(out, existingStruct, baseline);
  }

  applyAmbienceCalibration(out, plan, intent, userPrompt);

  const finalStruct = sanitizeStruct102ForSysEx(out);
  const appliedBlocks = buildAppliedBlocksSummary(finalStruct, existingStruct, intent);

  const calibration: AiOutputCalibrationSummary = {
    source: baseline.source,
    sampleCount: baseline.sampleCount,
    avgPatchVolume: baseline.avgPatchVolume,
    avgIrVolume: baseline.avgIrVolume,
    avgAmpLevel: baseline.avgAmpLevel,
    appliedPatchVolume: finalStruct[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? DEFAULT_PATCH_VOLUME,
    appliedIrVolume: finalStruct[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? DEFAULT_IR_VOLUME,
    appliedAmpLevel:
      (finalStruct[0x03] ?? 0) > 0
        ? (finalStruct[0x1c] ?? DEFAULT_AMP_LEVEL)
        : 0,
  };

  return {
    struct102: finalStruct,
    intent,
    presetName: decodeMg300PresetName(finalStruct) || safeName,
    bpm: finalStruct[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] ?? bpm,
    timeFlag: (finalStruct[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0,
    appliedBlocks,
    calibration,
  };
}
