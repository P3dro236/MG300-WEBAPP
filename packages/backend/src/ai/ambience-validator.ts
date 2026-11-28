import {
  type AiAmbienceBlockSnapshot,
  type AiAmbienceCorrection,
  type AiDelayProfile,
  type AiGainStage,
  type AiToneAmbienceDiagnostics,
  type AiToneIntent,
  MG300_FILE_FORMAT,
  getMg300ModelSpec,
} from '@quicktone/shared';
import {
  type AmbiencePolicyDecision,
  DELAY_MODEL_LAYOUTS,
  type DelayModelLayout,
  getDelayModelProfileLimits,
  isDelayModelAllowedForProfile,
  resolvePreferredFallbackDelayModel,
} from './ambience-policy.js';

const DLY_PARAM_OFFSET = 0x36;
const RVB_PARAM_OFFSET = 0x3d;
const EDIT_INCREASE_SAFETY_CEILING = 65;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
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

export function captureAmbienceBlockSnapshot(
  blockId: 7 | 8,
  struct102: Uint8Array,
): AiAmbienceBlockSnapshot {
  const ccOffset = blockId === 7 ? 0x07 : 0x08;
  const paramOffset = blockId === 7 ? DLY_PARAM_OFFSET : RVB_PARAM_OFFSET;
  const modelId = struct102[ccOffset] ?? 0;
  if (modelId === 0) {
    return {
      modelId: 0,
      modelName: 'Bypass',
      params: [],
    };
  }
  const spec = getMg300ModelSpec(blockId, modelId);
  const params =
    spec?.params.map((p) => ({
      label: p.label,
      value: struct102[paramOffset + p.paramIndex] ?? 0,
    })) ?? [];
  return {
    modelId,
    modelName: spec?.name ?? `Model ${modelId}`,
    params,
  };
}

function readDelayMetrics(
  struct102: Uint8Array,
  layout: DelayModelLayout,
): { time: number; feedback: number; mix: number; mod: number | null } {
  return {
    time: struct102[DLY_PARAM_OFFSET + layout.timeIndex] ?? 0,
    feedback: struct102[DLY_PARAM_OFFSET + layout.feedbackIndex] ?? 0,
    mix: struct102[DLY_PARAM_OFFSET + layout.mixIndex] ?? 0,
    mod: layout.modIndex !== null ? (struct102[DLY_PARAM_OFFSET + layout.modIndex] ?? 0) : null,
  };
}

function writeDelayMetrics(
  struct102: Uint8Array,
  layout: DelayModelLayout,
  metrics: { time: number; feedback: number; mix: number; mod?: number | null },
): void {
  struct102[DLY_PARAM_OFFSET + layout.timeIndex] = clampInt(metrics.time, 0, 100);
  struct102[DLY_PARAM_OFFSET + layout.feedbackIndex] = clampInt(metrics.feedback, 0, 100);
  struct102[DLY_PARAM_OFFSET + layout.mixIndex] = clampInt(metrics.mix, 0, 100);
  if (layout.modIndex !== null) {
    struct102[DLY_PARAM_OFFSET + layout.modIndex] = clampInt(metrics.mod ?? 0, 0, 100);
  }
}

function computeJointAmbienceScore(
  struct102: Uint8Array,
  gainStage: AiGainStage,
): number {
  const dlyModel = struct102[0x07] ?? 0;
  const rvbModel = struct102[0x08] ?? 0;
  const modActive = (struct102[0x06] ?? 0) > 0;
  const dlyLayout = DELAY_MODEL_LAYOUTS[dlyModel];
  const dlyMetrics = dlyLayout ? readDelayMetrics(struct102, dlyLayout) : null;
  const rvbMix = rvbModel > 0 ? (struct102[RVB_PARAM_OFFSET] ?? 0) : 0;
  const decayOffset =
    rvbModel > 0 ? getSpecParamOffset(8, rvbModel, 'Decay', RVB_PARAM_OFFSET) : null;
  const rvbDecay = decayOffset !== null ? (struct102[decayOffset] ?? 0) : 0;

  const dlyComponent = dlyMetrics
    ? dlyMetrics.mix * 0.8 + dlyMetrics.feedback * 0.55 + dlyMetrics.time * 0.15
    : 0;
  const rvbComponent = rvbModel > 0 ? rvbMix * 0.85 + rvbDecay * 0.25 : 0;
  const modBonus = modActive ? 8 : 0;
  const gainMultiplier = gainStage === 'high_gain' ? 1.15 : gainStage === 'crunch' ? 1.05 : 1.0;

  return Math.round((dlyComponent + rvbComponent + modBonus) * gainMultiplier * 10) / 10;
}

function enforceDelayModelCompatibility(
  out: Uint8Array,
  profile: AiDelayProfile,
  explicitReverseMention: boolean,
  corrections: AiAmbienceCorrection[],
): number {
  const dlyModel = out[0x07] ?? 0;
  if (isDelayModelAllowedForProfile(dlyModel, profile, explicitReverseMention)) {
    return dlyModel;
  }

  const oldLayout = DELAY_MODEL_LAYOUTS[dlyModel];
  const fallbackModel = resolvePreferredFallbackDelayModel(profile);
  const newLayout = DELAY_MODEL_LAYOUTS[fallbackModel]!;
  const oldMetrics = oldLayout
    ? readDelayMetrics(out, oldLayout)
    : { time: 30, feedback: 15, mix: 20, mod: null };

  out[0x07] = fallbackModel;
  out.fill(0, DLY_PARAM_OFFSET, DLY_PARAM_OFFSET + 6);
  writeDelayMetrics(out, newLayout, {
    time: oldMetrics.time,
    feedback: oldMetrics.feedback,
    mix: oldMetrics.mix,
    mod: null,
  });

  corrections.push({
    block: 'DLY',
    param: 'modelId',
    proposed: `${dlyModel} (${oldLayout?.name ?? 'Unknown'})`,
    applied: `${fallbackModel} (${newLayout.name})`,
    rule: 'incompatible_delay_model',
    reason: `Modelo ${oldLayout?.name ?? dlyModel} incompatível com o perfil ${profile}.`,
  });
  return fallbackModel;
}

function enforceActiveDelayLimits(
  out: Uint8Array,
  dlyModel: number,
  policy: AmbiencePolicyDecision,
  gainStage: AiGainStage,
  isEditIncrease: boolean,
  corrections: AiAmbienceCorrection[],
): void {
  const layout = DELAY_MODEL_LAYOUTS[dlyModel];
  const effectiveProfile: AiDelayProfile =
    isEditIncrease && policy.delayProfile === 'NONE' ? 'AMBIENT' : policy.delayProfile;
  const limits = layout
    ? getDelayModelProfileLimits(dlyModel, effectiveProfile, policy.musicalPurpose, gainStage)
    : undefined;

  if (!layout || !limits) {
    return;
  }

  const currentTf = (out[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0;
  if (policy.delayProfile === 'SLAPBACK' && currentTf === 1) {
    out[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = 0;
    corrections.push({
      block: 'META',
      param: 'timeFlag',
      proposed: 1,
      applied: 0,
      rule: 'incompatible_delay_time',
      reason: 'Slapback exige tempo curto absoluto (timeFlag=0 em ms), não BPM sync.',
    });
  }

  const effectiveTf = (out[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0;
  const metrics = readDelayMetrics(out, layout);

  let nextTime = metrics.time;
  if (effectiveTf === 0) {
    const clampedTime = clampInt(metrics.time, limits.time[0], limits.time[1]);
    if (clampedTime !== metrics.time) {
      corrections.push({
        block: 'DLY',
        param: 'Time',
        proposed: metrics.time,
        applied: clampedTime,
        rule: 'incompatible_delay_time',
        reason: `Tempo ajustado para faixa [${limits.time[0]}..${limits.time[1]}] do modelo ${layout.name} no perfil ${effectiveProfile}.`,
      });
      nextTime = clampedTime;
    }
  } else if (metrics.time > limits.time[1]) {
    const clampedTime = limits.time[1];
    corrections.push({
      block: 'DLY',
      param: 'Time',
      proposed: metrics.time,
      applied: clampedTime,
      rule: 'incompatible_delay_time',
      reason: `Com timeFlag=1, Time foi limitado ao teto [${clampedTime}] do perfil ${effectiveProfile}.`,
    });
    nextTime = clampedTime;
  }

  const mixMin = isEditIncrease ? 0 : limits.mix[0];
  const mixMax = isEditIncrease ? Math.min(limits.mix[1], EDIT_INCREASE_SAFETY_CEILING) : limits.mix[1];
  const fbMin = isEditIncrease ? 0 : limits.feedback[0];
  const fbMax = isEditIncrease
    ? Math.min(limits.feedback[1], EDIT_INCREASE_SAFETY_CEILING)
    : limits.feedback[1];

  const nextMix = clampInt(metrics.mix, mixMin, mixMax);
  if (nextMix !== metrics.mix) {
    corrections.push({
      block: 'DLY',
      param: layout.mixLabel,
      proposed: metrics.mix,
      applied: nextMix,
      rule: 'excessive_delay_mix',
      reason: `${layout.mixLabel} ajustado para faixa [${mixMin}..${mixMax}] de ${layout.name} (${effectiveProfile}/${gainStage}).`,
    });
  }

  let nextFeedback = clampInt(metrics.feedback, fbMin, fbMax);
  if (nextFeedback !== metrics.feedback) {
    corrections.push({
      block: 'DLY',
      param: layout.feedbackLabel,
      proposed: metrics.feedback,
      applied: nextFeedback,
      rule: 'excessive_delay_feedback',
      reason: `${layout.feedbackLabel} ajustado para faixa [${fbMin}..${fbMax}] de ${layout.name} (${effectiveProfile}/${gainStage}).`,
    });
  }

  const repeatIndex = nextTime * 0.35 + nextFeedback * 0.65;
  if (repeatIndex > limits.maxRepeatIndex) {
    const maxFeedbackForTime = Math.floor((limits.maxRepeatIndex - nextTime * 0.35) / 0.65);
    const adjustedFeedback = clampInt(maxFeedbackForTime, fbMin, nextFeedback);
    if (adjustedFeedback !== nextFeedback) {
      corrections.push({
        block: 'DLY',
        param: layout.feedbackLabel,
        proposed: nextFeedback,
        applied: adjustedFeedback,
        rule: 'excessive_repeats',
        reason: `Combinação Time=${nextTime} + ${layout.feedbackLabel}=${nextFeedback} excedeu densidade máxima de repetições (${limits.maxRepeatIndex}).`,
      });
      nextFeedback = adjustedFeedback;
    }
  }

  let nextMod = metrics.mod;
  if (layout.modIndex !== null && limits.mod && metrics.mod !== null) {
    const modMin = isEditIncrease ? 0 : limits.mod[0];
    nextMod = clampInt(metrics.mod, modMin, limits.mod[1]);
    if (nextMod !== metrics.mod) {
      corrections.push({
        block: 'DLY',
        param: 'Mod',
        proposed: metrics.mod,
        applied: nextMod,
        rule: 'excessive_delay_modulation',
        reason: `Modulação do delay limitada a [${modMin}..${limits.mod[1]}] para evitar desafinação em bends.`,
      });
    }
  }

  writeDelayMetrics(out, layout, {
    time: nextTime,
    feedback: nextFeedback,
    mix: nextMix,
    mod: nextMod,
  });
}

function enforceDelayPolicyAndLimits(options: {
  out: Uint8Array;
  existingStruct: Uint8Array;
  intent: AiToneIntent;
  policy: AmbiencePolicyDecision;
  gainStage: AiGainStage;
  hasDelayDirective: boolean;
  corrections: AiAmbienceCorrection[];
  warnings: string[];
}): { delayDecision: 'included' | 'excluded' | 'preserved'; delayDecisionReason: string } {
  const {
    out,
    existingStruct,
    intent,
    policy,
    gainStage,
    hasDelayDirective,
    corrections,
    warnings,
  } = options;

  const preservedExistingDly =
    intent === 'edit_existing' && !hasDelayDirective && !policy.explicitNoDelay;
  if (preservedExistingDly) {
    if ((out[0x07] ?? 0) > 0) {
      return {
        delayDecision: 'preserved',
        delayDecisionReason: 'DLY existente preservado sem alteração em edição incremental.',
      };
    }
    return {
      delayDecision: 'excluded',
      delayDecisionReason: 'DLY mantido em bypass conforme preset existente.',
    };
  }

  if (!policy.delayAllowed) {
    const proposedModel = out[0x07] ?? 0;
    if (proposedModel > 0) {
      const prevSnapshot = captureAmbienceBlockSnapshot(7, out);
      out[0x07] = 0;
      if (intent === 'create_new') {
        out.fill(0, DLY_PARAM_OFFSET, DLY_PARAM_OFFSET + 6);
      } else {
        out.set(existingStruct.subarray(DLY_PARAM_OFFSET, DLY_PARAM_OFFSET + 6), DLY_PARAM_OFFSET);
      }
      corrections.push({
        block: 'DLY',
        param: 'modelId',
        proposed: `${prevSnapshot.modelId} (${prevSnapshot.modelName})`,
        applied: '0 (Bypass)',
        rule: 'unjustified_delay_removed',
        reason: policy.delayDecisionReason,
      });
      warnings.push(
        `Delay removido pela política (${policy.delayProfile}): ${policy.delayDecisionReason}`,
      );
    }
    return {
      delayDecision: 'excluded',
      delayDecisionReason: policy.delayDecisionReason,
    };
  }

  if ((out[0x07] ?? 0) === 0) {
    return {
      delayDecision: 'excluded',
      delayDecisionReason: 'A IA manteve DLY desligado para este pedido.',
    };
  }

  const isEditDelayIncrease = intent === 'edit_existing' && policy.explicitDelayIncrease;
  const validatedModel = enforceDelayModelCompatibility(
    out,
    policy.delayProfile,
    policy.explicitReverseMention,
    corrections,
  );
  enforceActiveDelayLimits(
    out,
    validatedModel,
    policy,
    gainStage,
    isEditDelayIncrease,
    corrections,
  );

  return {
    delayDecision: 'included',
    delayDecisionReason: policy.delayDecisionReason,
  };
}

function enforceReverbLimits(options: {
  out: Uint8Array;
  intent: AiToneIntent;
  policy: AmbiencePolicyDecision;
  gainStage: AiGainStage;
  modEnabled: boolean;
  hasReverbDirective: boolean;
  corrections: AiAmbienceCorrection[];
}): void {
  const { out, intent, policy, gainStage, modEnabled, hasReverbDirective, corrections } = options;
  const rvbModel = out[0x08] ?? 0;
  const shouldEnforceRvb = intent === 'create_new' || hasReverbDirective;
  if (rvbModel === 0 || !shouldEnforceRvb) {
    return;
  }

  const isEditRvbIncrease = intent === 'edit_existing' && policy.explicitReverbIncrease;
  const budget = policy.budget;
  const mixMax = isEditRvbIncrease ? EDIT_INCREASE_SAFETY_CEILING : budget.rvbMixMax;

  const mixOffset = getSpecParamOffset(8, rvbModel, 'Mix', RVB_PARAM_OFFSET);
  if (mixOffset !== null) {
    const prev = out[mixOffset] ?? 0;
    const clamped = clampInt(prev, 0, mixMax);
    if (clamped !== prev) {
      out[mixOffset] = clamped;
      corrections.push({
        block: 'RVB',
        param: 'Mix',
        proposed: prev,
        applied: clamped,
        rule: 'excessive_reverb_mix',
        reason: isEditRvbIncrease
          ? 'Limite de segurança em edição incremental (<= 65).'
          : `Mix do reverb limitado a <= ${mixMax} para ${policy.musicalPurpose} (${gainStage}).`,
      });
    }
  }

  const decayOffset = getSpecParamOffset(8, rvbModel, 'Decay', RVB_PARAM_OFFSET);
  if (decayOffset !== null) {
    const prev = out[decayOffset] ?? 0;
    let maxDecay = isEditRvbIncrease
      ? EDIT_INCREASE_SAFETY_CEILING
      : rvbModel === 2 || rvbModel === 3
        ? budget.rvbDecayMax
        : budget.roomSpringDecayMax;
    if (
      !isEditRvbIncrease &&
      policy.delayProfile !== 'AMBIENT' &&
      gainStage === 'high_gain' &&
      modEnabled &&
      (out[0x07] ?? 0) > 0
    ) {
      maxDecay = Math.min(maxDecay, 38);
    }
    const clamped = clampInt(prev, 0, maxDecay);
    if (clamped !== prev) {
      out[decayOffset] = clamped;
      corrections.push({
        block: 'RVB',
        param: 'Decay',
        proposed: prev,
        applied: clamped,
        rule: 'excessive_reverb_decay',
        reason: `Decay do reverb limitado a <= ${maxDecay} para evitar cauda embolada.`,
      });
    }
  }

  if (rvbModel === 2) {
    const preDelayOffset = getSpecParamOffset(8, rvbModel, 'Pre.D', RVB_PARAM_OFFSET);
    if (preDelayOffset !== null) {
      const prev = out[preDelayOffset] ?? 0;
      const clamped = clampInt(prev, budget.hallPreDelayMin, 65);
      if (clamped !== prev) {
        out[preDelayOffset] = clamped;
        corrections.push({
          block: 'RVB',
          param: 'Pre.D',
          proposed: prev,
          applied: clamped,
          rule: 'insufficient_reverb_predelay',
          reason: `Pre-delay mínimo de ${budget.hallPreDelayMin} no Hall para separar ataque da nota da cauda.`,
        });
      }
    }
    const livelinessOffset = getSpecParamOffset(8, rvbModel, 'Liveliness', RVB_PARAM_OFFSET);
    if (livelinessOffset !== null) {
      const prev = out[livelinessOffset] ?? 0;
      const livelinessMax = isEditRvbIncrease
        ? Math.max(budget.hallLivelinessMax, 60)
        : budget.hallLivelinessMax;
      const clamped = clampInt(prev, 10, livelinessMax);
      if (clamped !== prev) {
        out[livelinessOffset] = clamped;
        corrections.push({
          block: 'RVB',
          param: 'Liveliness',
          proposed: prev,
          applied: clamped,
          rule: 'excessive_reverb_liveliness',
          reason: `Liveliness do Hall limitado a <= ${livelinessMax} para evitar ressonância metálica.`,
        });
      }
    }
  }
}

function enforceJointAmbienceBudget(options: {
  out: Uint8Array;
  intent: AiToneIntent;
  policy: AmbiencePolicyDecision;
  gainStage: AiGainStage;
  modEnabled: boolean;
  hasDelayDirective: boolean;
  hasReverbDirective: boolean;
  corrections: AiAmbienceCorrection[];
}): void {
  const {
    out,
    intent,
    policy,
    gainStage,
    modEnabled,
    hasDelayDirective,
    hasReverbDirective,
    corrections,
  } = options;

  const touchedAmbience = intent === 'create_new' || hasDelayDirective || hasReverbDirective;
  const skipForExplicitEditIncrease =
    intent === 'edit_existing' && (policy.explicitDelayIncrease || policy.explicitReverbIncrease);
  const dlyModel = out[0x07] ?? 0;
  const rvbModel = out[0x08] ?? 0;
  const dlyLayout = DELAY_MODEL_LAYOUTS[dlyModel];
  const rvbMixOffset =
    rvbModel > 0 ? getSpecParamOffset(8, rvbModel, 'Mix', RVB_PARAM_OFFSET) : null;

  if (!touchedAmbience || skipForExplicitEditIncrease || !dlyLayout || rvbMixOffset === null) {
    return;
  }

  const budget = policy.budget;
  const effectiveJointWetMax = Math.max(
    14,
    budget.jointWetMax - (modEnabled ? budget.modStackPenalty : 0),
  );
  const dlyMetrics = readDelayMetrics(out, dlyLayout);
  const rvbMix = out[rvbMixOffset] ?? 0;
  const combinedWet = dlyMetrics.mix + rvbMix;

  if (combinedWet <= effectiveJointWetMax) {
    return;
  }

  let excess = combinedWet - effectiveJointWetMax;
  const minRvbMix = Math.min(rvbMix, 8);
  const rvbReduction = Math.min(excess, rvbMix - minRvbMix);
  if (rvbReduction > 0) {
    const nextRvbMix = rvbMix - rvbReduction;
    out[rvbMixOffset] = nextRvbMix;
    excess -= rvbReduction;
    corrections.push({
      block: 'RVB',
      param: 'Mix',
      proposed: rvbMix,
      applied: nextRvbMix,
      rule: 'excessive_combined_ambience',
      reason: `Controle conjunto DLY+RVB${modEnabled ? '+MOD' : ''} (${gainStage}): soma ${combinedWet} excedeu orçamento ${effectiveJointWetMax}.`,
    });
  }

  if (excess > 0) {
    const limits = getDelayModelProfileLimits(
      dlyModel,
      policy.delayProfile === 'NONE' ? 'LEAD' : policy.delayProfile,
      policy.musicalPurpose,
      gainStage,
    );
    const minDlyMix = limits ? limits.mix[0] : 8;
    const dlyReduction = Math.min(excess, Math.max(0, dlyMetrics.mix - minDlyMix));
    if (dlyReduction > 0) {
      const nextDlyMix = dlyMetrics.mix - dlyReduction;
      out[DLY_PARAM_OFFSET + dlyLayout.mixIndex] = nextDlyMix;
      corrections.push({
        block: 'DLY',
        param: dlyLayout.mixLabel,
        proposed: dlyMetrics.mix,
        applied: nextDlyMix,
        rule: 'excessive_combined_ambience',
        reason: `Controle conjunto DLY+RVB${modEnabled ? '+MOD' : ''}: redução complementar em ${dlyLayout.mixLabel} para preservar definição.`,
      });
    }
  }
}

export interface ValidateAmbienceOptions {
  out: Uint8Array;
  existingStruct: Uint8Array;
  intent: AiToneIntent;
  originalPrompt: string;
  policy: AmbiencePolicyDecision;
  gainStage: AiGainStage;
  modEnabled: boolean;
  hasDelayDirective: boolean;
  hasReverbDirective: boolean;
  duplicateDelayDirectives: number;
  aiProposedAmbience: {
    dly: AiAmbienceBlockSnapshot | null;
    rvb: AiAmbienceBlockSnapshot | null;
    modEnabled: boolean;
    gainStage: AiGainStage;
    timeFlag: number | undefined;
    duplicateDelayDirectives: number;
  };
}

/**
 * Deterministic ambience compiler-validator boundary: enforces single-delay rule,
 * per-profile/per-model delay ranges (time, mix, feedback, mod, repeat density),
 * reverb limits, and joint `DLY + RVB + MOD + gainStage` interaction without silent drops.
 */
export function validateAndEnforceAmbience(
  options: ValidateAmbienceOptions,
): AiToneAmbienceDiagnostics {
  const {
    out,
    existingStruct,
    intent,
    originalPrompt,
    policy,
    gainStage,
    modEnabled,
    hasDelayDirective,
    hasReverbDirective,
    duplicateDelayDirectives,
    aiProposedAmbience,
  } = options;

  const corrections: AiAmbienceCorrection[] = [];
  const warnings: string[] = [];

  if (duplicateDelayDirectives > 0) {
    corrections.push({
      block: 'META',
      param: 'delayBlocks',
      proposed: duplicateDelayDirectives + 1,
      applied: 1,
      rule: 'multiple_delay_blocks',
      reason: 'A MG-300 e a política de ambiência permitem apenas 1 bloco DLY ativo por preset.',
    });
    warnings.push('Diretivas duplicadas de delay foram consolidadas em um único bloco DLY.');
  }

  const { delayDecision, delayDecisionReason } = enforceDelayPolicyAndLimits({
    out,
    existingStruct,
    intent,
    policy,
    gainStage,
    hasDelayDirective,
    corrections,
    warnings,
  });

  enforceReverbLimits({
    out,
    intent,
    policy,
    gainStage,
    modEnabled,
    hasReverbDirective,
    corrections,
  });

  enforceJointAmbienceBudget({
    out,
    intent,
    policy,
    gainStage,
    modEnabled,
    hasDelayDirective,
    hasReverbDirective,
    corrections,
  });

  const finalDlySnapshot = captureAmbienceBlockSnapshot(7, out);
  const finalRvbSnapshot = captureAmbienceBlockSnapshot(8, out);
  const finalTimeFlag = (out[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0;

  return {
    originalPrompt,
    musicalPurpose: policy.musicalPurpose,
    delayProfile: policy.delayProfile,
    aiSuggestedProfile: policy.aiSuggestedProfile,
    delayDecision,
    delayDecisionReason,
    selectedDelayModel: {
      id: finalDlySnapshot.modelId,
      name: finalDlySnapshot.modelName,
    },
    aiProposedAmbience,
    finalAmbience: {
      dly: finalDlySnapshot,
      rvb: finalRvbSnapshot,
      modEnabled,
      gainStage,
      timeFlag: finalTimeFlag,
      jointAmbienceScore: computeJointAmbienceScore(out, gainStage),
    },
    corrections,
    warnings,
  };
}
