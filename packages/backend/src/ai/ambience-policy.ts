import {
  type AiDelayProfile,
  type AiGainStage,
  type AiMusicalPurpose,
  type AiToneIntent,
  getMg300ModelSpec,
} from '@quicktone/shared';

export interface DelayModelLayout {
  readonly modelId: number;
  readonly name: string;
  readonly timeIndex: number;
  readonly feedbackIndex: number;
  readonly mixIndex: number;
  readonly modIndex: number | null;
  readonly feedbackLabel: string;
  readonly mixLabel: string;
  readonly allowedProfiles: readonly AiDelayProfile[];
}

export type ParamRangeTuple = readonly [min: number, max: number, def: number];

export interface DelayModelProfileLimits {
  readonly time: ParamRangeTuple;
  readonly feedback: ParamRangeTuple;
  readonly mix: ParamRangeTuple;
  readonly mod?: ParamRangeTuple;
  /** Heuristic upper bound for `time * 0.35 + feedback * 0.65` (with timeFlag === 0) to prevent excessive repeats. */
  readonly maxRepeatIndex: number;
}

export type DelayProfileBucket =
  | 'RHYTHM'
  | 'SLAPBACK'
  | 'LEAD_HIGH_GAIN'
  | 'LEAD_STANDARD'
  | 'LEAD_MELODIC'
  | 'AMBIENT';

export interface AmbienceBudgetRule {
  readonly rvbMixMax: number;
  readonly rvbDecayMax: number;
  readonly roomSpringDecayMax: number;
  readonly hallLivelinessMax: number;
  readonly hallPreDelayMin: number;
  readonly jointWetMax: number;
  readonly modStackPenalty: number;
}

export interface AmbiencePolicyDecision {
  readonly musicalPurpose: AiMusicalPurpose;
  readonly delayProfile: AiDelayProfile;
  readonly aiSuggestedProfile: AiDelayProfile | null;
  readonly delayAllowed: boolean;
  readonly delayDecisionReason: string;
  readonly explicitNoDelay: boolean;
  readonly explicitDelayMention: boolean;
  readonly explicitReverseMention: boolean;
  readonly explicitDelayIncrease: boolean;
  readonly explicitReverbIncrease: boolean;
  readonly explicitAmbienceIncrease: boolean;
  readonly budget: AmbienceBudgetRule;
}

/**
 * Authoritative parameter layouts for NUX MG-300 DLY models (IDs 1..6) from `MG300_BLOCK_CATALOG`.
 * Note: Analog Delay (`id=1`) reverses p1 (`Echo`, mix) and p2 (`Intensity`, feedback) compared to models `2..6`.
 */
export const DELAY_MODEL_LAYOUTS: Readonly<Record<number, DelayModelLayout>> = {
  1: {
    modelId: 1,
    name: 'Analog Delay',
    timeIndex: 0,
    mixIndex: 1,
    feedbackIndex: 2,
    modIndex: null,
    feedbackLabel: 'Intensity',
    mixLabel: 'Echo',
    allowedProfiles: ['RHYTHM', 'LEAD', 'AMBIENT', 'SLAPBACK'],
  },
  2: {
    modelId: 2,
    name: 'Digi Delay',
    timeIndex: 0,
    feedbackIndex: 1,
    mixIndex: 2,
    modIndex: null,
    feedbackLabel: 'F.Back',
    mixLabel: 'Level',
    allowedProfiles: ['RHYTHM', 'LEAD', 'AMBIENT', 'SLAPBACK'],
  },
  3: {
    modelId: 3,
    name: 'Modulate',
    timeIndex: 0,
    feedbackIndex: 1,
    mixIndex: 2,
    modIndex: 3,
    feedbackLabel: 'F.Back',
    mixLabel: 'Level',
    allowedProfiles: ['RHYTHM', 'LEAD', 'AMBIENT'],
  },
  4: {
    modelId: 4,
    name: 'Tape Echo',
    timeIndex: 0,
    feedbackIndex: 1,
    mixIndex: 2,
    modIndex: null,
    feedbackLabel: 'F.Back',
    mixLabel: 'Level',
    allowedProfiles: ['RHYTHM', 'LEAD', 'AMBIENT', 'SLAPBACK'],
  },
  5: {
    modelId: 5,
    name: 'Reverse',
    timeIndex: 0,
    feedbackIndex: 1,
    mixIndex: 2,
    modIndex: null,
    feedbackLabel: 'F.Back',
    mixLabel: 'Mix',
    allowedProfiles: ['AMBIENT'],
  },
  6: {
    modelId: 6,
    name: 'Pan',
    timeIndex: 0,
    feedbackIndex: 1,
    mixIndex: 2,
    modIndex: null,
    feedbackLabel: 'F.Back',
    mixLabel: 'Mix',
    allowedProfiles: ['LEAD', 'AMBIENT'],
  },
};

export const DELAY_MODEL_PROFILE_LIMITS: Readonly<
  Record<DelayProfileBucket, Readonly<Partial<Record<number, DelayModelProfileLimits>>>>
> = {
  RHYTHM: {
    1: { time: [18, 38, 28], mix: [8, 16, 12], feedback: [6, 14, 10], maxRepeatIndex: 22 },
    2: { time: [20, 42, 30], feedback: [8, 16, 12], mix: [8, 16, 12], maxRepeatIndex: 24 },
    3: {
      time: [20, 40, 30],
      feedback: [8, 14, 10],
      mix: [8, 15, 12],
      mod: [0, 15, 10],
      maxRepeatIndex: 22,
    },
    4: { time: [20, 42, 32], feedback: [8, 16, 12], mix: [8, 16, 12], maxRepeatIndex: 24 },
  },
  SLAPBACK: {
    1: { time: [8, 24, 16], mix: [18, 34, 26], feedback: [0, 10, 6], maxRepeatIndex: 15 },
    2: { time: [8, 24, 15], feedback: [0, 10, 5], mix: [18, 32, 24], maxRepeatIndex: 15 },
    4: { time: [8, 24, 16], feedback: [0, 12, 8], mix: [18, 34, 26], maxRepeatIndex: 16 },
  },
  LEAD_HIGH_GAIN: {
    1: { time: [28, 56, 42], mix: [10, 24, 18], feedback: [8, 20, 15], maxRepeatIndex: 33 },
    2: { time: [30, 58, 44], feedback: [8, 20, 16], mix: [10, 22, 18], maxRepeatIndex: 33 },
    3: {
      time: [30, 56, 44],
      feedback: [8, 20, 15],
      mix: [10, 22, 17],
      mod: [0, 25, 16],
      maxRepeatIndex: 32,
    },
    4: { time: [30, 58, 45], feedback: [10, 22, 18], mix: [10, 24, 20], maxRepeatIndex: 33 },
    6: { time: [30, 54, 42], feedback: [8, 18, 14], mix: [10, 20, 16], maxRepeatIndex: 31 },
  },
  LEAD_STANDARD: {
    1: { time: [28, 58, 44], mix: [10, 28, 20], feedback: [8, 24, 18], maxRepeatIndex: 36 },
    2: { time: [30, 62, 46], feedback: [10, 26, 20], mix: [10, 26, 20], maxRepeatIndex: 38 },
    3: {
      time: [30, 60, 46],
      feedback: [10, 24, 18],
      mix: [10, 26, 20],
      mod: [0, 30, 18],
      maxRepeatIndex: 36,
    },
    4: { time: [30, 62, 46], feedback: [10, 26, 20], mix: [10, 28, 22], maxRepeatIndex: 39 },
    6: { time: [30, 58, 44], feedback: [10, 24, 18], mix: [10, 26, 20], maxRepeatIndex: 36 },
  },
  LEAD_MELODIC: {
    1: { time: [34, 62, 48], mix: [14, 28, 22], feedback: [14, 26, 22], maxRepeatIndex: 39 },
    2: { time: [36, 64, 50], feedback: [16, 32, 26], mix: [14, 28, 24], maxRepeatIndex: 43 },
    3: {
      time: [36, 62, 48],
      feedback: [14, 28, 22],
      mix: [14, 26, 22],
      mod: [0, 30, 18],
      maxRepeatIndex: 40,
    },
    4: { time: [36, 64, 50], feedback: [16, 34, 26], mix: [14, 30, 24], maxRepeatIndex: 44 },
    6: { time: [36, 60, 48], feedback: [14, 28, 22], mix: [14, 26, 22], maxRepeatIndex: 40 },
  },
  AMBIENT: {
    1: { time: [35, 78, 56], mix: [20, 60, 42], feedback: [20, 58, 42], maxRepeatIndex: 66 },
    2: { time: [35, 82, 58], feedback: [24, 68, 48], mix: [20, 62, 44], maxRepeatIndex: 74 },
    3: {
      time: [35, 80, 56],
      feedback: [22, 65, 46],
      mix: [20, 60, 42],
      mod: [12, 55, 32],
      maxRepeatIndex: 71,
    },
    4: { time: [35, 82, 58], feedback: [22, 65, 48], mix: [20, 62, 44], maxRepeatIndex: 72 },
    5: { time: [35, 80, 56], feedback: [18, 58, 40], mix: [22, 65, 45], maxRepeatIndex: 66 },
    6: { time: [35, 80, 56], feedback: [22, 62, 44], mix: [20, 60, 42], maxRepeatIndex: 69 },
  },
};

export const AMBIENCE_BUDGET_RULES: Readonly<
  Record<AiMusicalPurpose, Readonly<Record<AiGainStage, AmbienceBudgetRule>>>
> = {
  heavy_rhythm: {
    clean: {
      rvbMixMax: 16,
      rvbDecayMax: 28,
      roomSpringDecayMax: 30,
      hallLivelinessMax: 35,
      hallPreDelayMin: 20,
      jointWetMax: 20,
      modStackPenalty: 4,
    },
    crunch: {
      rvbMixMax: 15,
      rvbDecayMax: 28,
      roomSpringDecayMax: 30,
      hallLivelinessMax: 35,
      hallPreDelayMin: 20,
      jointWetMax: 18,
      modStackPenalty: 4,
    },
    high_gain: {
      rvbMixMax: 14,
      rvbDecayMax: 26,
      roomSpringDecayMax: 28,
      hallLivelinessMax: 35,
      hallPreDelayMin: 20,
      jointWetMax: 16,
      modStackPenalty: 4,
    },
  },
  rhythm: {
    clean: {
      rvbMixMax: 22,
      rvbDecayMax: 38,
      roomSpringDecayMax: 42,
      hallLivelinessMax: 42,
      hallPreDelayMin: 20,
      jointWetMax: 30,
      modStackPenalty: 4,
    },
    crunch: {
      rvbMixMax: 20,
      rvbDecayMax: 36,
      roomSpringDecayMax: 40,
      hallLivelinessMax: 42,
      hallPreDelayMin: 20,
      jointWetMax: 28,
      modStackPenalty: 4,
    },
    high_gain: {
      rvbMixMax: 18,
      rvbDecayMax: 32,
      roomSpringDecayMax: 36,
      hallLivelinessMax: 38,
      hallPreDelayMin: 20,
      jointWetMax: 24,
      modStackPenalty: 4,
    },
  },
  slapback: {
    clean: {
      rvbMixMax: 20,
      rvbDecayMax: 30,
      roomSpringDecayMax: 32,
      hallLivelinessMax: 38,
      hallPreDelayMin: 20,
      jointWetMax: 46,
      modStackPenalty: 4,
    },
    crunch: {
      rvbMixMax: 18,
      rvbDecayMax: 28,
      roomSpringDecayMax: 30,
      hallLivelinessMax: 38,
      hallPreDelayMin: 20,
      jointWetMax: 44,
      modStackPenalty: 4,
    },
    high_gain: {
      rvbMixMax: 16,
      rvbDecayMax: 26,
      roomSpringDecayMax: 28,
      hallLivelinessMax: 35,
      hallPreDelayMin: 20,
      jointWetMax: 40,
      modStackPenalty: 4,
    },
  },
  lead_solo: {
    clean: {
      rvbMixMax: 26,
      rvbDecayMax: 48,
      roomSpringDecayMax: 48,
      hallLivelinessMax: 45,
      hallPreDelayMin: 20,
      jointWetMax: 48,
      modStackPenalty: 4,
    },
    crunch: {
      rvbMixMax: 26,
      rvbDecayMax: 48,
      roomSpringDecayMax: 48,
      hallLivelinessMax: 45,
      hallPreDelayMin: 20,
      jointWetMax: 46,
      modStackPenalty: 4,
    },
    high_gain: {
      rvbMixMax: 22,
      rvbDecayMax: 42,
      roomSpringDecayMax: 48,
      hallLivelinessMax: 45,
      hallPreDelayMin: 20,
      jointWetMax: 42,
      modStackPenalty: 4,
    },
  },
  melodic_lead: {
    clean: {
      rvbMixMax: 26,
      rvbDecayMax: 48,
      roomSpringDecayMax: 48,
      hallLivelinessMax: 45,
      hallPreDelayMin: 20,
      jointWetMax: 52,
      modStackPenalty: 4,
    },
    crunch: {
      rvbMixMax: 24,
      rvbDecayMax: 46,
      roomSpringDecayMax: 48,
      hallLivelinessMax: 45,
      hallPreDelayMin: 20,
      jointWetMax: 52,
      modStackPenalty: 4,
    },
    high_gain: {
      rvbMixMax: 22,
      rvbDecayMax: 42,
      roomSpringDecayMax: 46,
      hallLivelinessMax: 45,
      hallPreDelayMin: 20,
      jointWetMax: 48,
      modStackPenalty: 4,
    },
  },
  clean_dry: {
    clean: {
      rvbMixMax: 24,
      rvbDecayMax: 42,
      roomSpringDecayMax: 44,
      hallLivelinessMax: 45,
      hallPreDelayMin: 15,
      jointWetMax: 24,
      modStackPenalty: 4,
    },
    crunch: {
      rvbMixMax: 22,
      rvbDecayMax: 38,
      roomSpringDecayMax: 42,
      hallLivelinessMax: 42,
      hallPreDelayMin: 15,
      jointWetMax: 22,
      modStackPenalty: 4,
    },
    high_gain: {
      rvbMixMax: 18,
      rvbDecayMax: 34,
      roomSpringDecayMax: 38,
      hallLivelinessMax: 40,
      hallPreDelayMin: 20,
      jointWetMax: 18,
      modStackPenalty: 4,
    },
  },
  clean_modulated: {
    clean: {
      rvbMixMax: 28,
      rvbDecayMax: 48,
      roomSpringDecayMax: 48,
      hallLivelinessMax: 45,
      hallPreDelayMin: 15,
      jointWetMax: 28,
      modStackPenalty: 2,
    },
    crunch: {
      rvbMixMax: 24,
      rvbDecayMax: 42,
      roomSpringDecayMax: 44,
      hallLivelinessMax: 45,
      hallPreDelayMin: 15,
      jointWetMax: 24,
      modStackPenalty: 2,
    },
    high_gain: {
      rvbMixMax: 20,
      rvbDecayMax: 36,
      roomSpringDecayMax: 38,
      hallLivelinessMax: 42,
      hallPreDelayMin: 20,
      jointWetMax: 20,
      modStackPenalty: 3,
    },
  },
  generic: {
    clean: {
      rvbMixMax: 24,
      rvbDecayMax: 40,
      roomSpringDecayMax: 42,
      hallLivelinessMax: 45,
      hallPreDelayMin: 15,
      jointWetMax: 24,
      modStackPenalty: 4,
    },
    crunch: {
      rvbMixMax: 22,
      rvbDecayMax: 36,
      roomSpringDecayMax: 38,
      hallLivelinessMax: 42,
      hallPreDelayMin: 15,
      jointWetMax: 22,
      modStackPenalty: 4,
    },
    high_gain: {
      rvbMixMax: 18,
      rvbDecayMax: 32,
      roomSpringDecayMax: 34,
      hallLivelinessMax: 40,
      hallPreDelayMin: 20,
      jointWetMax: 18,
      modStackPenalty: 4,
    },
  },
  ambient: {
    clean: {
      rvbMixMax: 65,
      rvbDecayMax: 82,
      roomSpringDecayMax: 80,
      hallLivelinessMax: 75,
      hallPreDelayMin: 15,
      jointWetMax: 115,
      modStackPenalty: 5,
    },
    crunch: {
      rvbMixMax: 60,
      rvbDecayMax: 78,
      roomSpringDecayMax: 75,
      hallLivelinessMax: 70,
      hallPreDelayMin: 15,
      jointWetMax: 108,
      modStackPenalty: 5,
    },
    high_gain: {
      rvbMixMax: 52,
      rvbDecayMax: 70,
      roomSpringDecayMax: 68,
      hallLivelinessMax: 62,
      hallPreDelayMin: 20,
      jointWetMax: 95,
      modStackPenalty: 6,
    },
  },
};

const HEAVY_AMBIENCE_PATTERNS: readonly RegExp[] = [
  /\bambient\b/,
  /\bambiencia\b/,
  /\bshoegaze\b/,
  /\bpost[- ]?rock\b/,
  /\bdream[- ]?pop\b/,
  /\bcathedral\b/,
  /\bcatedral\b/,
  /\bwash\b/,
  /\bshimmer\b/,
  /\bespacial\b/,
  /\bspatial\b/,
  /\batmosfer\w*\b/,
  /\batmospher\w*\b/,
  /\betere[oa]\b/,
  /\bethereal\b/,
  /\bthe\s+edge\b/,
  /\b(?:delay|eco)\s+(?:longo|carregado|pesado|forte|alto|intenso|profundo|infinito)\b/,
  /\b(?:muito|mais|bastante|aumentar|aumenta|subir|sobe|dobrar|dobra)\s+(?:o\s+)?(?:delay|eco)\b/,
  /\breverb\s+(?:longo|carregado|pesado|forte|alto|intenso|profundo|enorme|gigante|grande)\b/,
  /\b(?:muito|long|heavy|high)\s+(?:delay|reverb)\b/,
  /\bmore\s+delay\b/,
];

const EXPLICIT_NO_DELAY_PATTERNS: readonly RegExp[] = [
  /\b(?:sem|without|tirar|tira|remover|remove|desligar|desliga|disable|zero|seco\s+sem)\s+(?:o\s+)?(?:delay|eco|echo)\b/,
  /(?:^|[,.!?]\s*|\b(?:with|want|use|keep|prefer|dry|strictly|totally)\s+)no\s+(?:delay|echo)\b/,
  /\bdelay\s+(?:off|desligado|zero|0)\b/,
];

const EXPLICIT_DELAY_MENTION_PATTERNS: readonly RegExp[] = [
  /\bdelay\b/,
  /\beco\b/,
  /\becho\b/,
  /\bslap\s*back\b/,
  /\brepetic(?:ao|oes)\b/,
  /\brepeats?\b/,
  /\bdotted\b/,
  /\bcolcheia\s+pontuada\b/,
  /\btape\s+echo\b/,
  /\breverse\s+delay\b/,
];

const EXPLICIT_DELAY_INCREASE_PATTERNS: readonly RegExp[] = [
  /\b(?:muito|mais|bastante|aumentar|aumenta|subir|sobe|dobrar|dobra|more)\s+(?:o\s+)?(?:delay|eco|echo|ambiencia)\b/,
  /\b(?:delay|eco|echo)\s+(?:mais\s+presente|mais\s+alto|mais\s+forte|mais\s+longo)\b/,
];

const EXPLICIT_REVERB_INCREASE_PATTERNS: readonly RegExp[] = [
  /\b(?:muito|mais|bastante|aumentar|aumenta|subir|sobe|dobrar|dobra|more)\s+(?:o\s+)?(?:reverb|ambiencia)\b/,
  /\breverb\s+(?:mais\s+presente|mais\s+alto|mais\s+forte|mais\s+longo|longo|carregado)\b/,
];

const SLAPBACK_PATTERNS: readonly RegExp[] = [
  /\bslap\s*back\b/,
  /\brockabilly\b/,
  /\bbrian\s+setzer\b/,
  /\bscotty\s+moore\b/,
  /\bcountry\s+slap\b/,
];

const MELODIC_LEAD_PATTERNS: readonly RegExp[] = [
  /\bpink\s+floyd\b/,
  /\bgilmour\b/,
  /\bcomfortably\s+numb\b/,
  /\banother\s+brick\b/,
  /\bsolo\s+melodic[oa]\b/,
  /\bmelodic\s+(?:solo|lead)\b/,
];

const HEAVY_ARTIST_OR_GENRE_PATTERN =
  /\b(?:metallica|megadeth|slayer|pantera|thrash|metal|heavy|djent|hardcore|palm\s*mute|chug)\b/;
const RHYTHM_WORD_PATTERN =
  /\b(?:riffs?|base|bases|ritm(?:o|ica|ico)|rhythm|power\s*chords?|caval(?:o|inho)|cavalgada)\b/;
const HEAVY_RHYTHM_PHRASE_PATTERNS: readonly RegExp[] = [
  /\briffs?\s+pesad[oa]s?\b/,
  /\bbases?\s+pesad[oa]s?\b/,
  /\bbase\s+(?:rock\s+direto|ac\/dc|hard\s+rock)\b/,
];

const LEAD_SOLO_PATTERNS: readonly RegExp[] = [
  /\bsolos?\b/,
  /\blead\b/,
  /\bshred\b/,
  /\bkirk\s+hammett\b/,
  /\bslash\b/,
  /\bgary\s+moore\b/,
  /\bsweet\s+child\b/,
  /\bnovember\s+rain\b/,
  /\bhotel\s+california\b/,
  /\bstill\s+got\s+the\s+blues\b/,
];

const CLEAN_WORD_PATTERN = /\b(?:clean|limp[oa]|cristalin[oa]|jazz|acustic[oa]|violao)\b/;
const MODULATION_WORD_PATTERN = /\b(?:chorus|flanger|phaser|tremolo|rotary|vibrato|u[- ]?vibe)\b/;

export function normalizeAmbiencePrompt(prompt?: string): string {
  if (!prompt || !prompt.trim()) {
    return '';
  }
  return prompt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Detects whether the musician explicitly requested ambient/heavy delay/reverb or asked to
 * raise delay/reverb, so deterministic ambience clamping does not fight intentional wet tones.
 */
export function isAmbientOrHeavyAmbienceRequest(prompt?: string): boolean {
  const normalized = normalizeAmbiencePrompt(prompt);
  if (!normalized) {
    return false;
  }
  if (EXPLICIT_NO_DELAY_PATTERNS.some((p) => p.test(normalized))) {
    return false;
  }
  if (HEAVY_AMBIENCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  const hasPinkFloyd = /\b(?:pink\s+floyd|shine\s+on|echoes)\b/.test(normalized);
  const hasSolo = /\bsolos?\b|\blead\b/.test(normalized);
  return hasPinkFloyd && !hasSolo && /\b(?:atmosfer\w*|espacial|ambient|crazy\s+diamond)\b/.test(normalized);
}

export function classifyGainStage(struct102: Uint8Array): AiGainStage {
  const ampActive = (struct102[0x03] ?? 0) > 0;
  const ampGain = ampActive ? (struct102[0x1a] ?? 0) : 0;
  const efxModel = struct102[0x02] ?? 0;
  const efxDrive =
    efxModel > 0 && efxModel !== 12
      ? efxModel <= 3
        ? (struct102[0x14] ?? 0)
        : (struct102[0x15] ?? 0)
      : 0;

  if (ampGain >= 55 || efxDrive >= 50) {
    return 'high_gain';
  }
  if (ampGain >= 38 || efxDrive >= 25) {
    return 'crunch';
  }
  return 'clean';
}

export function getDelayProfileBucket(
  profile: AiDelayProfile,
  musicalPurpose: AiMusicalPurpose,
  gainStage: AiGainStage,
): DelayProfileBucket {
  if (profile === 'AMBIENT') {
    return 'AMBIENT';
  }
  if (profile === 'SLAPBACK') {
    return 'SLAPBACK';
  }
  if (profile === 'RHYTHM') {
    return 'RHYTHM';
  }
  if (musicalPurpose === 'melodic_lead') {
    return 'LEAD_MELODIC';
  }
  if (gainStage === 'high_gain') {
    return 'LEAD_HIGH_GAIN';
  }
  return 'LEAD_STANDARD';
}

export function getDelayModelProfileLimits(
  modelId: number,
  profile: AiDelayProfile,
  musicalPurpose: AiMusicalPurpose,
  gainStage: AiGainStage,
): DelayModelProfileLimits | undefined {
  const bucket = getDelayProfileBucket(profile, musicalPurpose, gainStage);
  return DELAY_MODEL_PROFILE_LIMITS[bucket][modelId];
}

export function isDelayModelAllowedForProfile(
  modelId: number,
  profile: AiDelayProfile,
  explicitReverseMention: boolean,
): boolean {
  const layout = DELAY_MODEL_LAYOUTS[modelId];
  if (!layout) {
    return false;
  }
  if (modelId === 5 && explicitReverseMention) {
    return profile !== 'NONE' && profile !== 'SLAPBACK';
  }
  return layout.allowedProfiles.includes(profile);
}

export function resolvePreferredFallbackDelayModel(_profile: AiDelayProfile): number {
  return 4; // Tape Echo is the safest warm fallback across profiles
}

export function getSafeAmbienceDefaultParams(
  blockId: 7 | 8,
  modelId: number,
  policy: AmbiencePolicyDecision,
  gainStage: AiGainStage,
): number[] {
  const spec = getMg300ModelSpec(blockId, modelId);
  if (!spec) {
    return [0, 0, 0, 0, 0, 0];
  }

  if (blockId === 7) {
    const layout = DELAY_MODEL_LAYOUTS[modelId];
    const effectiveProfile: AiDelayProfile =
      policy.delayProfile === 'NONE' ? 'LEAD' : policy.delayProfile;
    const limits =
      getDelayModelProfileLimits(modelId, effectiveProfile, policy.musicalPurpose, gainStage) ??
      DELAY_MODEL_PROFILE_LIMITS.LEAD_STANDARD[4]!;
    const out = [0, 0, 0, 0, 0, 0];
    if (layout) {
      out[layout.timeIndex] = limits.time[2];
      out[layout.feedbackIndex] = limits.feedback[2];
      out[layout.mixIndex] = limits.mix[2];
      if (layout.modIndex !== null && limits.mod) {
        out[layout.modIndex] = limits.mod[2];
      }
    }
    return out;
  }

  // blockId === 8 (RVB)
  const budget = policy.budget;
  const isAmbient = policy.delayProfile === 'AMBIENT';
  const defaultMix = Math.min(budget.rvbMixMax, isAmbient ? 42 : gainStage === 'high_gain' ? 16 : 20);
  const maxDecay =
    modelId === 2 || modelId === 3 ? budget.rvbDecayMax : budget.roomSpringDecayMax;
  const defaultDecay = Math.min(maxDecay, isAmbient ? 65 : gainStage === 'high_gain' ? 32 : 36);

  if (modelId === 1) {
    // Room: p0=Mix, p1=Tone, p2=Decay
    return [defaultMix, 50, defaultDecay, 0, 0, 0];
  }
  if (modelId === 2) {
    // Hall: p0=Mix, p1=Decay, p2=Pre.D, p3=Liveliness
    return [
      defaultMix,
      defaultDecay,
      Math.max(budget.hallPreDelayMin, 25),
      Math.min(budget.hallLivelinessMax, 35),
      0,
      0,
    ];
  }
  // Plate (3) / Spring (4): p0=Mix, p1=Decay
  return [defaultMix, defaultDecay, 0, 0, 0, 0];
}

export function resolveAmbiencePolicy(options: {
  userPrompt?: string;
  intent: AiToneIntent;
  aiSuggestedProfile?: AiDelayProfile | null;
  aiSuggestedPurpose?: AiMusicalPurpose | null;
  gainStage: AiGainStage;
}): AmbiencePolicyDecision {
  const { userPrompt, intent, aiSuggestedProfile = null, aiSuggestedPurpose = null, gainStage } =
    options;
  const normalized = normalizeAmbiencePrompt(userPrompt);

  const explicitNoDelay = EXPLICIT_NO_DELAY_PATTERNS.some((p) => p.test(normalized));
  const explicitDelayMention =
    !explicitNoDelay && EXPLICIT_DELAY_MENTION_PATTERNS.some((p) => p.test(normalized));
  const explicitReverseMention = /\breverse\b|\breverso\b/.test(normalized);
  const explicitDelayIncrease =
    !explicitNoDelay && EXPLICIT_DELAY_INCREASE_PATTERNS.some((p) => p.test(normalized));
  const explicitReverbIncrease = EXPLICIT_REVERB_INCREASE_PATTERNS.some((p) => p.test(normalized));
  const explicitAmbienceIncrease = explicitDelayIncrease || explicitReverbIncrease;
  const isAmbient = !explicitNoDelay && isAmbientOrHeavyAmbienceRequest(userPrompt);
  const isSlapback = !explicitNoDelay && SLAPBACK_PATTERNS.some((p) => p.test(normalized));
  const isMelodicLead = !explicitNoDelay && MELODIC_LEAD_PATTERNS.some((p) => p.test(normalized));
  const hasHeavyMarker = HEAVY_ARTIST_OR_GENRE_PATTERN.test(normalized);
  const hasRhythmWord = RHYTHM_WORD_PATTERN.test(normalized);
  const isHeavyRhythm =
    (hasHeavyMarker && hasRhythmWord) ||
    HEAVY_RHYTHM_PHRASE_PATTERNS.some((p) => p.test(normalized));
  const isLeadSolo = LEAD_SOLO_PATTERNS.some((p) => p.test(normalized));
  const isClean = CLEAN_WORD_PATTERN.test(normalized);
  const hasModulation = MODULATION_WORD_PATTERN.test(normalized);

  let musicalPurpose: AiMusicalPurpose;
  let delayProfile: AiDelayProfile;
  let delayAllowed: boolean;
  let delayDecisionReason: string;

  if (explicitNoDelay) {
    delayProfile = 'NONE';
    delayAllowed = false;
    musicalPurpose = isHeavyRhythm
      ? 'heavy_rhythm'
      : hasRhythmWord
        ? 'rhythm'
        : isClean && hasModulation
          ? 'clean_modulated'
          : isClean
            ? 'clean_dry'
            : 'generic';
    delayDecisionReason =
      'Pedido explícito do músico para manter o timbre sem delay.';
  } else if (isSlapback) {
    musicalPurpose = 'slapback';
    delayProfile = 'SLAPBACK';
    delayAllowed = true;
    delayDecisionReason =
      'Perfil SLAPBACK ativado por referência explícita a slapback/rockabilly (tempo curto e poucas repetições).';
  } else if (isAmbient && (!isLeadSolo || /\b(?:shoegaze|cathedral|catedral|wash|shimmer|atmosfer\w*|atmospher\w*|the\s+edge|muito\s+delay|delay\s+longo)\b/.test(normalized))) {
    musicalPurpose = 'ambient';
    delayProfile = 'AMBIENT';
    delayAllowed = true;
    delayDecisionReason =
      'Perfil AMBIENT ativado por solicitação explícita de textura atmosférica/espacial ou delay/reverb longos.';
  } else if (isMelodicLead) {
    musicalPurpose = 'melodic_lead';
    delayProfile = 'LEAD';
    delayAllowed = true;
    delayDecisionReason =
      'Perfil LEAD (melodic_lead) ativado para solo melódico com delay expressivo e controlado contra embolamento.';
  } else if (isHeavyRhythm && !isLeadSolo) {
    musicalPurpose = 'heavy_rhythm';
    delayProfile = 'RHYTHM';
    delayAllowed = explicitDelayMention;
    delayDecisionReason = explicitDelayMention
      ? 'Perfil RHYTHM com delay discreto permitido por menção explícita ao delay em riff/base pesada.'
      : 'Riff/base pesada prioriza ataque e definição: delay excluído por padrão (política RHYTHM sem menção explícita a delay).';
  } else if (isLeadSolo) {
    musicalPurpose = 'lead_solo';
    delayProfile = 'LEAD';
    delayAllowed = true;
    delayDecisionReason =
      'Perfil LEAD ativado para solo/lead com repetições perceptíveis e limite de feedback/mix sem competir com a nota principal.';
  } else if (hasRhythmWord) {
    musicalPurpose = gainStage === 'high_gain' ? 'heavy_rhythm' : 'rhythm';
    delayProfile = 'RHYTHM';
    delayAllowed = explicitDelayMention;
    delayDecisionReason = explicitDelayMention
      ? 'Perfil RHYTHM com ambiência discreta permitido por solicitação explícita de delay na base.'
      : 'Base/ritmo prioriza definição e ataque: delay excluído por padrão (sem solicitação explícita).';
  } else if (isClean && hasModulation) {
    musicalPurpose = 'clean_modulated';
    delayProfile = explicitDelayMention ? 'LEAD' : 'NONE';
    delayAllowed = explicitDelayMention;
    delayDecisionReason = explicitDelayMention
      ? 'Clean modulado com delay controlado habilitado por pedido explícito de delay.'
      : 'Som limpo com modulação (chorus/etc.) e reverb não requer delay por padrão: DLY mantido desligado para evitar sobreposição.';
  } else if (isClean) {
    musicalPurpose = 'clean_dry';
    delayProfile = explicitDelayMention ? 'LEAD' : 'NONE';
    delayAllowed = explicitDelayMention;
    delayDecisionReason = explicitDelayMention
      ? 'Clean com delay controlado habilitado por pedido explícito de delay.'
      : 'Som limpo sem menção a delay: DLY excluído por padrão para preservar clareza e dinâmica.';
  } else if (explicitDelayMention) {
    musicalPurpose = aiSuggestedPurpose === 'melodic_lead' ? 'melodic_lead' : 'lead_solo';
    delayProfile = 'LEAD';
    delayAllowed = true;
    delayDecisionReason =
      'Delay explicitamente mencionado no pedido: perfil LEAD aplicado com limites determinísticos.';
  } else {
    musicalPurpose = 'generic';
    delayProfile = 'NONE';
    delayAllowed = false;
    delayDecisionReason =
      intent === 'edit_existing'
        ? 'Edição incremental sem menção a delay no pedido: novo delay não autorizado (bloco existente permanece preservado se não editado).'
        : 'Solicitação genérica sem referência a delay ou finalidade que exija eco: DLY excluído por padrão (política NONE).';
  }

  const budget = AMBIENCE_BUDGET_RULES[musicalPurpose][gainStage];

  return {
    musicalPurpose,
    delayProfile,
    aiSuggestedProfile,
    delayAllowed,
    delayDecisionReason,
    explicitNoDelay,
    explicitDelayMention,
    explicitReverseMention,
    explicitDelayIncrease,
    explicitReverbIncrease,
    explicitAmbienceIncrease,
    budget,
  };
}
