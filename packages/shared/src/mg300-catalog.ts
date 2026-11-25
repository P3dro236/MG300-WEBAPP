/**
 * Authoritative NUX MG-300 (`NUX NME-300`) 10-block model & parameter catalog.
 *
 * Extracted directly from `files/quicktone/QuickTone.exe` (v2.4.12.27):
 * - `NUX NME-300` device model lists (excluding MG-300MK2 / MG-400 / MG-30-only IDs)
 * - `MG300_DisplayConfig.json`, `MG300_AmpCabinetDisplayConfig.json`, `MG300_MicDisplayConfig.json`
 * - English UI translation keys & Harmonist key LED sequence (`Harmonist_LED_1_C`..`12_B`)
 */

export type Mg300BlockCode =
  | 'COMP'
  | 'EFX'
  | 'AMP'
  | 'EQ'
  | 'NR'
  | 'MOD'
  | 'DLY'
  | 'RVB'
  | 'CAB'
  | 'MIC';

export type Mg300ParamControlType = 'slider' | 'toggle' | 'select';

export interface Mg300ParamOption {
  value: number;
  label: string;
}

export interface Mg300ParamSpec {
  /** MIDI CC number (11..58) for this parameter. */
  cc: number;
  /** Zero-based offset (0..5) inside the block's 6 parameter slots. */
  paramIndex: number;
  label: string;
  controlType: Mg300ParamControlType;
  min: number;
  max: number;
  /** Value sent when a toggle control switches ON (`0` = OFF). */
  onValue?: number;
  /** Discrete options when `controlType === 'select'`. */
  options?: readonly Mg300ParamOption[];
}

export interface Mg300ModelSpec {
  id: number;
  name: string;
  category?: 'guitar' | 'acoustic' | 'bass' | 'user_ir';
  params: readonly Mg300ParamSpec[];
}

export interface Mg300BlockCatalogEntry {
  /** Block ID (1..10) inside `struct102[1..10]` and MIDI CC `1..10`. */
  id: number;
  code: Mg300BlockCode;
  label: string;
  cc: number;
  /** First parameter CC (`11..53`), or `null` for blocks without block-local param CCs (`CAB`, `MIC`). */
  paramCcBase: number | null;
  /** Offset of param 0 inside `struct102`, or `null` for `CAB`/`MIC`. */
  structParamOffset: number | null;
  paramSlotCount: number;
  /** Always true so every slot permits `0` (OFF/Bypass). */
  supportsBypass: boolean;
  models: readonly Mg300ModelSpec[];
}

/** Special CAB ID stored in `struct102[9]` / `CC 9` when a custom User IR slot is selected. */
export const MG300_USER_IR_CAB_ID = 100;

function slider(baseCc: number, cc: number, label: string, max = 100): Mg300ParamSpec {
  return {
    cc,
    paramIndex: cc - baseCc,
    label,
    controlType: 'slider',
    min: 0,
    max,
  };
}

function toggle(baseCc: number, cc: number, label: string): Mg300ParamSpec {
  return {
    cc,
    paramIndex: cc - baseCc,
    label,
    controlType: 'toggle',
    min: 0,
    max: 1,
    onValue: 1,
  };
}

function selectParam(
  baseCc: number,
  cc: number,
  label: string,
  options: readonly Mg300ParamOption[],
): Mg300ParamSpec {
  return {
    cc,
    paramIndex: cc - baseCc,
    label,
    controlType: 'select',
    min: 0,
    max: options.length > 0 ? options[options.length - 1]!.value : 0,
    options,
  };
}

const HARMONY_KEY_OPTIONS: readonly Mg300ParamOption[] = [
  'C',
  'C#',
  'D',
  'Eb',
  'E',
  'F',
  'F#',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
].map((label, value) => ({ value, label }));

const CHORUS_PLUS_MODE_OPTIONS: readonly Mg300ParamOption[] = [
  { value: 0, label: 'Mode 1' },
  { value: 1, label: 'Mode 2' },
  { value: 2, label: 'Mode 3' },
];

const EFX_BASE = 17;
const AMP_BASE = 23;
const MOD_BASE = 41;
const DLY_BASE = 47;
const RVB_BASE = 53;

function efx3(id: number, name: string, p2Label: string, p3Label: string): Mg300ModelSpec {
  return {
    id,
    name,
    params: [
      slider(EFX_BASE, 17, 'Level'),
      slider(EFX_BASE, 18, p2Label),
      slider(EFX_BASE, 19, p3Label),
    ],
  };
}

function ampStd(
  id: number,
  name: string,
  cc24Mode: 'pres' | 'cut' | 'bright' | 'mfreq' | 'none',
  options: { mid?: boolean; category?: 'guitar' | 'acoustic' | 'bass' } = {},
): Mg300ModelSpec {
  const params: Mg300ParamSpec[] = [slider(AMP_BASE, 23, 'Gain')];
  if (cc24Mode === 'bright') {
    params.push(toggle(AMP_BASE, 24, 'Bright'));
  } else if (cc24Mode === 'pres') {
    params.push(slider(AMP_BASE, 24, 'Pres'));
  } else if (cc24Mode === 'cut') {
    params.push(slider(AMP_BASE, 24, 'Cut'));
  } else if (cc24Mode === 'mfreq') {
    params.push(slider(AMP_BASE, 24, 'M.Freq'));
  }
  params.push(slider(AMP_BASE, 25, 'Level'));
  params.push(slider(AMP_BASE, 26, 'Bass'));
  if (options.mid !== false) {
    params.push(slider(AMP_BASE, 27, 'Middle'));
  }
  params.push(slider(AMP_BASE, 28, 'Treble'));
  return {
    id,
    name,
    category: options.category ?? 'guitar',
    params,
  };
}

export const MG300_BLOCK_CATALOG: readonly Mg300BlockCatalogEntry[] = [
  {
    id: 1,
    code: 'COMP',
    label: 'COMP',
    cc: 1,
    paramCcBase: 11,
    structParamOffset: 0x0c,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      {
        id: 1,
        name: 'Red Comp',
        params: [slider(11, 11, 'Output'), slider(11, 12, 'Sensitivity')],
      },
    ],
  },
  {
    id: 2,
    code: 'EFX',
    label: 'EFX',
    cc: 2,
    paramCcBase: EFX_BASE,
    structParamOffset: 0x13,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      {
        id: 1,
        name: 'Dist+',
        params: [slider(EFX_BASE, 17, 'Output'), slider(EFX_BASE, 18, 'Distortion')],
      },
      {
        id: 2,
        name: 'RC Bst',
        params: [
          slider(EFX_BASE, 17, 'Volume'),
          slider(EFX_BASE, 18, 'Gain'),
          slider(EFX_BASE, 19, 'Bass'),
          slider(EFX_BASE, 20, 'Treble'),
        ],
      },
      {
        id: 3,
        name: 'AC Bst',
        params: [
          slider(EFX_BASE, 17, 'Volume'),
          slider(EFX_BASE, 18, 'Gain'),
          slider(EFX_BASE, 19, 'Bass'),
          slider(EFX_BASE, 20, 'Treble'),
        ],
      },
      efx3(4, 'Dist Uno', 'Tone', 'Drive'),
      efx3(5, 'T Screamer', 'Tone', 'Drive'),
      efx3(6, 'Blues Drive', 'Tone', 'Gain'),
      efx3(7, 'Morning Drive', 'Tone', 'Drive'),
      efx3(8, 'Modern Dist', 'Filter', 'Distortion'),
      efx3(9, 'Red Dist', 'Tone', 'Drive'),
      efx3(10, 'Crunch', 'Tone', 'Gain'),
      efx3(11, 'Muf Dist', 'Tone', 'Sustain'),
      {
        id: 12,
        name: 'Pitch Bender',
        params: [
          slider(EFX_BASE, 17, 'Pitch'),
          toggle(EFX_BASE, 18, 'Range'),
        ],
      },
    ],
  },
  {
    id: 3,
    code: 'AMP',
    label: 'AMP',
    cc: 3,
    paramCcBase: AMP_BASE,
    structParamOffset: 0x1a,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      ampStd(1, 'Jazz Clean', 'bright'),
      ampStd(2, 'Deluxe Rvb', 'none'),
      ampStd(3, 'Bass Mate', 'pres'),
      {
        id: 4,
        name: 'Tweedy',
        category: 'guitar',
        params: [
          slider(AMP_BASE, 23, 'Gain'),
          slider(AMP_BASE, 24, 'Tone'),
          slider(AMP_BASE, 25, 'Level'),
        ],
      },
      ampStd(5, 'Twin Rvb', 'bright'),
      ampStd(6, 'Hiwire', 'pres'),
      ampStd(7, 'Cali Crunch', 'pres'),
      ampStd(8, 'Class A15', 'cut', { mid: false }),
      ampStd(9, 'Class A30', 'cut', { mid: false }),
      ampStd(10, 'Plexi 100W', 'pres'),
      ampStd(11, 'Plexi 45', 'pres'),
      ampStd(12, 'Brit 800', 'pres'),
      ampStd(13, '1987X 50W', 'pres'),
      ampStd(14, 'SLO 100', 'pres'),
      ampStd(15, 'Friedman', 'pres'),
      ampStd(16, 'Dual Rect', 'pres'),
      ampStd(17, 'Die VH4', 'pres'),
      ampStd(18, 'Vibro King', 'bright'),
      ampStd(19, 'Budda', 'cut'),
      ampStd(20, 'Mr.Z 38', 'cut'),
      ampStd(21, 'Super Rvb', 'bright'),
      ampStd(22, 'Brit Blues', 'pres'),
      ampStd(23, 'Match D30', 'cut', { mid: false }),
      ampStd(24, 'Brit 2000', 'pres'),
      ampStd(25, 'Uber HiGain', 'pres'),
      ampStd(26, 'Stageman', 'none', { category: 'acoustic' }),
      ampStd(27, 'MLD', 'mfreq', { category: 'bass' }),
    ],
  },
  {
    id: 4,
    code: 'EQ',
    label: 'EQ',
    cc: 4,
    paramCcBase: 29,
    structParamOffset: 0x21,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      {
        id: 1,
        name: '6-Band EQ',
        params: [
          slider(29, 29, '100Hz'),
          slider(29, 30, '220Hz'),
          slider(29, 31, '500Hz'),
          slider(29, 32, '1.2kHz'),
          slider(29, 33, '2.6kHz'),
          slider(29, 34, '6.4kHz'),
        ],
      },
    ],
  },
  {
    id: 5,
    code: 'NR',
    label: 'NR',
    cc: 5,
    paramCcBase: 35,
    structParamOffset: 0x28,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      {
        id: 1,
        name: 'NR (Noise Gate)',
        params: [slider(35, 35, 'Sens'), slider(35, 36, 'Decay')],
      },
    ],
  },
  {
    id: 6,
    code: 'MOD',
    label: 'MOD',
    cc: 6,
    paramCcBase: MOD_BASE,
    structParamOffset: 0x2f,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      {
        id: 1,
        name: 'CE-1',
        params: [
          slider(MOD_BASE, 41, 'Depth'),
          slider(MOD_BASE, 42, 'Rate'),
          slider(MOD_BASE, 43, 'Inten'),
        ],
      },
      {
        id: 2,
        name: 'Classic Chorus',
        params: [slider(MOD_BASE, 41, 'Depth'), slider(MOD_BASE, 42, 'Rate')],
      },
      {
        id: 3,
        name: 'ST.Chorus',
        params: [
          slider(MOD_BASE, 41, 'Depth'),
          slider(MOD_BASE, 42, 'Rate'),
          slider(MOD_BASE, 43, 'Inten'),
        ],
      },
      {
        id: 4,
        name: 'Vibrato',
        params: [slider(MOD_BASE, 41, 'Depth'), slider(MOD_BASE, 42, 'Rate')],
      },
      {
        id: 5,
        name: 'Detune',
        params: [
          slider(MOD_BASE, 41, 'Shift-L'),
          slider(MOD_BASE, 42, 'Shift-R'),
          slider(MOD_BASE, 43, 'Mix'),
        ],
      },
      {
        id: 6,
        name: 'Flange',
        params: [
          slider(MOD_BASE, 41, 'Depth'),
          slider(MOD_BASE, 42, 'Rate'),
          slider(MOD_BASE, 43, 'F.Back'),
          slider(MOD_BASE, 44, 'Width'),
        ],
      },
      {
        id: 7,
        name: 'PH 90',
        params: [slider(MOD_BASE, 41, 'Rate')],
      },
      {
        id: 8,
        name: 'Phase 100',
        params: [slider(MOD_BASE, 41, 'Inten'), slider(MOD_BASE, 42, 'Rate')],
      },
      {
        id: 9,
        name: 'Chorus+',
        params: [
          slider(MOD_BASE, 41, 'Depth'),
          slider(MOD_BASE, 42, 'Rate'),
          slider(MOD_BASE, 43, 'Inten'),
          selectParam(MOD_BASE, 44, 'Mode', CHORUS_PLUS_MODE_OPTIONS),
        ],
      },
      {
        id: 10,
        name: 'U-Vibe',
        params: [
          slider(MOD_BASE, 41, 'Inten'),
          slider(MOD_BASE, 42, 'Speed'),
          slider(MOD_BASE, 43, 'Volume'),
          toggle(MOD_BASE, 44, 'Vibrato'),
        ],
      },
      {
        id: 11,
        name: 'Trem',
        params: [slider(MOD_BASE, 41, 'Depth'), slider(MOD_BASE, 42, 'Rate')],
      },
      {
        id: 12,
        name: 'Rty Spk',
        params: [slider(MOD_BASE, 41, 'Balance'), slider(MOD_BASE, 42, 'Speed')],
      },
      {
        id: 13,
        name: 'Harmony',
        params: [
          toggle(MOD_BASE, 41, 'Minor Scale'),
          selectParam(MOD_BASE, 42, 'Key', HARMONY_KEY_OPTIONS),
          slider(MOD_BASE, 43, 'Harmo', 9),
          slider(MOD_BASE, 44, 'Balance'),
        ],
      },
    ],
  },
  {
    id: 7,
    code: 'DLY',
    label: 'DLY',
    cc: 7,
    paramCcBase: DLY_BASE,
    structParamOffset: 0x36,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      {
        id: 1,
        name: 'Analog Delay',
        params: [
          slider(DLY_BASE, 47, 'Time'),
          slider(DLY_BASE, 48, 'Echo'),
          slider(DLY_BASE, 49, 'Intensity'),
        ],
      },
      {
        id: 2,
        name: 'Digi Delay',
        params: [
          slider(DLY_BASE, 47, 'Time'),
          slider(DLY_BASE, 48, 'F.Back'),
          slider(DLY_BASE, 49, 'Level'),
        ],
      },
      {
        id: 3,
        name: 'Modulate',
        params: [
          slider(DLY_BASE, 47, 'Time'),
          slider(DLY_BASE, 48, 'F.Back'),
          slider(DLY_BASE, 49, 'Level'),
          slider(DLY_BASE, 50, 'Mod'),
        ],
      },
      {
        id: 4,
        name: 'Tape Echo',
        params: [
          slider(DLY_BASE, 47, 'Time'),
          slider(DLY_BASE, 48, 'F.Back'),
          slider(DLY_BASE, 49, 'Level'),
        ],
      },
      {
        id: 5,
        name: 'Reverse',
        params: [
          slider(DLY_BASE, 47, 'Time'),
          slider(DLY_BASE, 48, 'F.Back'),
          slider(DLY_BASE, 49, 'Mix'),
        ],
      },
      {
        id: 6,
        name: 'Pan',
        params: [
          slider(DLY_BASE, 47, 'Time'),
          slider(DLY_BASE, 48, 'F.Back'),
          slider(DLY_BASE, 49, 'Mix'),
        ],
      },
    ],
  },
  {
    id: 8,
    code: 'RVB',
    label: 'RVB',
    cc: 8,
    paramCcBase: RVB_BASE,
    structParamOffset: 0x3d,
    paramSlotCount: 6,
    supportsBypass: true,
    models: [
      {
        id: 1,
        name: 'Room',
        params: [
          slider(RVB_BASE, 53, 'Mix'),
          slider(RVB_BASE, 54, 'Tone'),
          slider(RVB_BASE, 55, 'Decay'),
        ],
      },
      {
        id: 2,
        name: 'Hall',
        params: [
          slider(RVB_BASE, 53, 'Mix'),
          slider(RVB_BASE, 54, 'Decay'),
          slider(RVB_BASE, 55, 'Pre.D'),
          slider(RVB_BASE, 56, 'Liveliness'),
        ],
      },
      {
        id: 3,
        name: 'Plate',
        params: [slider(RVB_BASE, 53, 'Mix'), slider(RVB_BASE, 54, 'Decay')],
      },
      {
        id: 4,
        name: 'Spring',
        params: [slider(RVB_BASE, 53, 'Mix'), slider(RVB_BASE, 54, 'Decay')],
      },
    ],
  },
  {
    id: 9,
    code: 'CAB',
    label: 'CAB',
    cc: 9,
    paramCcBase: null,
    structParamOffset: null,
    paramSlotCount: 0,
    supportsBypass: true,
    models: [
      { id: 1, name: 'Jazz 212', category: 'guitar', params: [] },
      { id: 2, name: 'Black 112', category: 'guitar', params: [] },
      { id: 3, name: 'Tweed 410', category: 'guitar', params: [] },
      { id: 4, name: 'Tweed 112', category: 'guitar', params: [] },
      { id: 5, name: 'Twin 212', category: 'guitar', params: [] },
      { id: 6, name: 'Custom 412', category: 'guitar', params: [] },
      { id: 7, name: 'Cali 112', category: 'guitar', params: [] },
      { id: 8, name: 'Blue 112', category: 'guitar', params: [] },
      { id: 9, name: 'Blue 212', category: 'guitar', params: [] },
      { id: 10, name: 'Green 412', category: 'guitar', params: [] },
      { id: 11, name: 'G12L 412', category: 'guitar', params: [] },
      { id: 12, name: 'T75 412', category: 'guitar', params: [] },
      { id: 13, name: 'V30 412', category: 'guitar', params: [] },
      { id: 14, name: 'SLO 412', category: 'guitar', params: [] },
      { id: 15, name: 'HBE 412', category: 'guitar', params: [] },
      { id: 16, name: 'Rect 412', category: 'guitar', params: [] },
      { id: 17, name: 'Botm 412', category: 'guitar', params: [] },
      { id: 18, name: 'Vibro 212', category: 'guitar', params: [] },
      { id: 19, name: 'Evl 112', category: 'guitar', params: [] },
      { id: 20, name: 'Butq 212', category: 'guitar', params: [] },
      { id: 21, name: 'Super 212', category: 'guitar', params: [] },
      { id: 22, name: 'Brit 212', category: 'guitar', params: [] },
      { id: 23, name: 'DC 212', category: 'guitar', params: [] },
      { id: 24, name: 'G12M 412', category: 'guitar', params: [] },
      { id: 25, name: 'Uber 412', category: 'guitar', params: [] },
      { id: 26, name: 'T814', category: 'acoustic', params: [] },
      { id: 27, name: 'M OM28', category: 'acoustic', params: [] },
      { id: 28, name: 'TRC 410', category: 'bass', params: [] },
      { id: 29, name: 'DB 810', category: 'bass', params: [] },
      { id: 30, name: 'SV 810', category: 'bass', params: [] },
      { id: MG300_USER_IR_CAB_ID, name: 'USER (Custom IR)', category: 'user_ir', params: [] },
    ],
  },
  {
    id: 10,
    code: 'MIC',
    label: 'MIC',
    cc: 10,
    paramCcBase: null,
    structParamOffset: null,
    paramSlotCount: 0,
    supportsBypass: true,
    models: [
      { id: 1, name: 'Dynamic E906', params: [] },
      { id: 2, name: 'Dynamic SM57', params: [] },
      { id: 3, name: 'Cond U87', params: [] },
      { id: 4, name: 'Cond C414', params: [] },
    ],
  },
] as const;

/** Blocks 1..8 (COMP..RVB) that expose per-block parameter CCs 11..58. */
export const MG300_PARAM_BLOCKS: readonly Mg300BlockCatalogEntry[] = MG300_BLOCK_CATALOG.filter(
  (block) => block.paramCcBase !== null,
);

export function getMg300BlockCatalog(
  blockOrCode: number | string,
): Mg300BlockCatalogEntry | undefined {
  if (typeof blockOrCode === 'number') {
    return MG300_BLOCK_CATALOG.find((entry) => entry.id === blockOrCode);
  }
  const normalized = blockOrCode.trim().toUpperCase();
  return MG300_BLOCK_CATALOG.find((entry) => entry.code === normalized);
}

export function getMg300BlockByCc(cc: number): Mg300BlockCatalogEntry | undefined {
  return MG300_BLOCK_CATALOG.find((entry) => entry.cc === cc);
}

export function getMg300ModelSpec(
  blockOrCode: number | string,
  modelId: number,
): Mg300ModelSpec | undefined {
  const block = getMg300BlockCatalog(blockOrCode);
  if (!block) {
    return undefined;
  }
  return block.models.find((model) => model.id === modelId);
}

export function isValidMg300BlockModel(cc: number, modelId: number): boolean {
  if (!Number.isInteger(modelId) || modelId < 0) {
    return false;
  }
  const block = getMg300BlockByCc(cc);
  if (!block) {
    return false;
  }
  if (modelId === 0) {
    return true;
  }
  return block.models.some((model) => model.id === modelId);
}

/**
 * Generates clean baseline parameter slots (length 6) when switching to a model on a draft
 * or resynchronizing controls whose defaults should be initialized predictably.
 */
export function getMg300ModelDefaultParams(blockId: number, modelId: number): number[] {
  const defaults = [0, 0, 0, 0, 0, 0];
  const spec = getMg300ModelSpec(blockId, modelId);
  if (!spec) {
    return defaults;
  }
  for (const param of spec.params) {
    if (param.paramIndex < 0 || param.paramIndex >= defaults.length) {
      continue;
    }
    if (param.controlType === 'toggle' || param.controlType === 'select') {
      defaults[param.paramIndex] = 0;
    } else if (blockId === 6 && modelId === 13 && param.cc === 43) {
      // Harmony Harmo interval 0..9
      defaults[param.paramIndex] = 0;
    } else {
      defaults[param.paramIndex] = 50;
    }
  }
  return defaults;
}
