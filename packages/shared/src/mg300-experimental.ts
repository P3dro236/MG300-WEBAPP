import {
  MG300_EXPERIMENTAL_SLOT,
  MG300_EXPERIMENTAL_SLOT_LABEL,
  MG300_FILE_FORMAT,
  MG300_MIDI_CC,
  MG300_SPACE_CHAR_CODE,
  MG300_CHAR_TABLE,
  MG300_SYSEX_PREFIX,
  encodeMg300PresetName,
  slotIndexToBankCoordinate,
} from './mg300-protocol.js';
import {
  MG300_PARAM_BLOCKS,
  MG300_USER_IR_CAB_ID,
  getMg300BlockByCc,
  getMg300ModelSpec,
  isValidMg300BlockModel,
} from './mg300-catalog.js';

/**
 * Real-time edit (MIDI CC 1..59, 71, 74) and permanent preset save (SysEx 0x0E) helpers
 * backed by docs/PRESET_EDITING_INVESTIGATION.md and QuickTone.exe MG-300 tables.
 */

export { MG300_EXPERIMENTAL_SLOT, MG300_EXPERIMENTAL_SLOT_LABEL };

export const MG300_USER_SLOT_MIN = 0;
export const MG300_USER_SLOT_MAX = 35;
export const MG300_FACTORY_SLOT_MIN = 36;
export const MG300_FACTORY_SLOT_MAX = 71;

/** All 36 writable User slot coordinates (`1A`..`9D`, indices `0..35`). */
export const MG300_USER_SLOTS: readonly ReturnType<typeof slotIndexToBankCoordinate>[] = Array.from(
  { length: MG300_USER_SLOT_MAX - MG300_USER_SLOT_MIN + 1 },
  (_, idx) => slotIndexToBankCoordinate(MG300_USER_SLOT_MIN + idx),
);

export const MG300_PRESET_WRITE_SUBCMD = 0x0e;
export const MG300_PRESET_WRITE_FRAME_SIZE = 113;
export const MG300_PRESET_WRITE_ACK_SIZE = 10;

export function isValidMg300UserSlot(slotIndex: number): boolean {
  return (
    Number.isInteger(slotIndex) &&
    slotIndex >= MG300_USER_SLOT_MIN &&
    slotIndex <= MG300_USER_SLOT_MAX
  );
}

/** CC 1..8 select/bypass blocks COMP..RVB; CC 11..58 adjust parameters of those 8 blocks. */
export const MG300_EXPERIMENTAL_BLOCK_CCS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const MG300_EXPERIMENTAL_AMP_PARAM_CC_BASE = 23;
export const MG300_EXPERIMENTAL_AMP_PARAM_COUNT = 6;
/** state[0x424] - state[0x40A]: first AMP parameter inside the 102-byte preset struct. */
export const MG300_AMP_PARAMS_STRUCT_OFFSET = 0x1a;

export interface ExperimentalBlockMeta {
  id: number;
  label: string;
  cc: number;
  paramCcBase: number;
  structParamOffset: number;
  paramLabels: readonly string[];
}

/** Derived from the authoritative `MG300_PARAM_BLOCKS` catalog (single source of truth). */
export const MG300_EXPERIMENTAL_BLOCKS: readonly ExperimentalBlockMeta[] = MG300_PARAM_BLOCKS.map(
  (block) => ({
    id: block.id,
    label: block.label,
    cc: block.cc,
    paramCcBase: block.paramCcBase!,
    structParamOffset: block.structParamOffset!,
    paramLabels: block.models[0]?.params.map((p) => p.label) ?? [],
  }),
);

export function getExperimentalBlockMeta(blockId: number): ExperimentalBlockMeta | undefined {
  return MG300_EXPERIMENTAL_BLOCKS.find((b) => b.id === blockId);
}

/**
 * Real-time RAM edit allowlist (`FUN_08038d04`):
 * - CC 1..10: block model/bypass (COMP..RVB, CAB, MIC)
 * - CC 11..58: 8 blocks x 6 params
 * - CC 59: IR Hi/Lo Cut (0..2)
 * - CC 71: IR Cab Volume (0..40)
 * - CC 74: Patch Level P.LVL (0..100)
 * CC 70 (clear User IR name) remains strictly blocked.
 */
export const MG300_EXPERIMENTAL_CC_ALLOWLIST: ReadonlySet<number> = new Set([
  ...Array.from({ length: 59 }, (_, i) => i + 1),
  MG300_MIDI_CC.IR_CAB_VOLUME,
  MG300_MIDI_CC.PATCH_LEVEL,
]);

export function getExperimentalCcMaxValue(cc: number): number {
  if (cc === 59) return 2;
  if (cc === MG300_MIDI_CC.IR_CAB_VOLUME) return 40;
  if (cc >= 1 && cc <= 10) {
    const block = getMg300BlockByCc(cc);
    if (!block || block.models.length === 0) return 0;
    return Math.max(...block.models.map((m) => m.id));
  }
  return 100;
}

export function isValidMg300ExperimentalCcValue(cc: number, value: number): boolean {
  if (!Number.isInteger(value) || value < 0) {
    return false;
  }
  if (!MG300_EXPERIMENTAL_CC_ALLOWLIST.has(cc)) {
    return false;
  }
  if (cc >= 1 && cc <= 10) {
    return isValidMg300BlockModel(cc, value);
  }
  return value <= getExperimentalCcMaxValue(cc);
}

/** Strips diacritics and restricts a preset name to 1..18 valid `MG300_CHAR_TABLE` glyphs. */
export function sanitizeMg300PresetName(rawName: string, fallback = 'New Preset'): string {
  const asciiFolded = rawName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let mapped = '';
  for (const ch of asciiFolded) {
    if (mapped.length >= MG300_FILE_FORMAT.MAX_NAME_LENGTH) {
      break;
    }
    if (MG300_CHAR_TABLE.includes(ch)) {
      mapped += ch;
    } else if (/\s/.test(ch)) {
      mapped += ' ';
    }
  }
  const trimmed = mapped.trim();
  if (trimmed.length > 0) {
    return trimmed.slice(0, MG300_FILE_FORMAT.MAX_NAME_LENGTH);
  }
  return fallback.slice(0, MG300_FILE_FORMAT.MAX_NAME_LENGTH) || 'Preset';
}

export interface BlankMg300PresetOptions {
  name?: string;
  bpm?: number;
  timeFlag?: number;
  patchVolume?: number;
  irVolume?: number;
  irCut?: number;
}

/**
 * Builds a clean, 7-bit-safe 102-byte MG-300 preset draft (`struct102`)
 * with baseline block header bytes (`0x0b..0x3c`) observed in hardware dumps.
 */
export function createBlankMg300Struct102(options: BlankMg300PresetOptions = {}): Uint8Array {
  const struct = new Uint8Array(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);

  // Chain: WAH off, COMP off, EFX off, AMP Jazz Clean (1), EQ off, NR (1), MOD/DLY/RVB off, CAB Jazz 212 (1), MIC SM57 (2)
  struct[0x00] = 0;
  struct[0x01] = 0;
  struct[0x02] = 0;
  struct[0x03] = 1;
  struct[0x04] = 0;
  struct[0x05] = 1;
  struct[0x06] = 0;
  struct[0x07] = 0;
  struct[0x08] = 0;
  struct[0x09] = 1;
  struct[0x0a] = 2;

  // Block headers & neutral params
  struct[0x0b] = 2;
  struct.set([50, 50, 0, 0, 0, 0], 0x0c); // COMP
  struct[0x12] = 51;
  struct.set([50, 50, 50, 50, 0, 0], 0x13); // EFX
  struct[0x19] = 22;
  struct.set([50, 0, 50, 50, 50, 50], 0x1a); // AMP (Gain=50, Bright/Pres=0, Level/Bass/Mid/Treb=50)
  struct[0x20] = 6;
  struct.set([50, 50, 50, 50, 50, 50], 0x21); // EQ flat 0 dB
  struct[0x27] = 2;
  struct.set([40, 30, 0, 0, 0, 0], 0x28); // NR
  struct[0x2e] = 36;
  struct.set([50, 50, 50, 0, 0, 0], 0x2f); // MOD
  struct[0x35] = 53;
  struct.set([50, 35, 35, 0, 0, 0], 0x36); // DLY
  struct[0x3c] = 18;
  struct.set([35, 50, 50, 0, 0, 0], 0x3d); // RVB

  const irCut = Math.max(0, Math.min(2, Math.round(options.irCut ?? 0)));
  const irVolume = Math.max(0, Math.min(40, Math.round(options.irVolume ?? 20)));
  const timeFlag = options.timeFlag === 1 ? 1 : 0;
  const bpm = Math.max(40, Math.min(240, Math.round(options.bpm ?? 120)));
  const patchVolume = Math.max(0, Math.min(100, Math.round(options.patchVolume ?? 50)));

  struct[0x43] = irCut;

  const safeName = sanitizeMg300PresetName(options.name ?? 'New Preset', 'New Preset');
  const encoded = encodeMg300PresetName(safeName);
  struct[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = encoded.length;
  struct.set(encoded.bytes, MG300_FILE_FORMAT.NAME_CHARS_OFFSET);

  // STM32 uses 0x10 (16) at +0x57 to indicate no custom User IR name attached
  struct[0x57] = 0x10;
  struct[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = irVolume;
  struct[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = timeFlag;
  struct[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] = bpm;
  struct[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] = patchVolume;

  return struct;
}

/** Internal ROM header/count byte offsets for blocks 1..8 refreshed by STM32 when models change. */
export const MG300_BLOCK_HEADER_OFFSETS: ReadonlySet<number> = new Set([
  0x0b, 0x12, 0x19, 0x20, 0x27, 0x2e, 0x35, 0x3c,
]);

/** Decodes custom User IR slot name stored at `+0x57..+0x61` when `CAB === 100`, if present. */
export function decodeMg300UserIrName(struct102: Uint8Array): string | null {
  if (struct102.length < MG300_FILE_FORMAT.PRESET_STRUCT_SIZE) {
    return null;
  }
  if (struct102[0x09] !== MG300_USER_IR_CAB_ID) {
    return null;
  }
  const rawLen = struct102[0x57] ?? 0;
  if (rawLen === 0 || rawLen > 10) {
    return null;
  }
  let name = '';
  for (let i = 0; i < rawLen; i++) {
    const code = struct102[0x58 + i];
    if (code === undefined || code >= MG300_CHAR_TABLE.length) {
      return null;
    }
    name += MG300_CHAR_TABLE[code]!;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeStruct102ByteForComparison(offset: number, value: number): number {
  void offset;
  return value & 0x7f;
}

/**
 * Normalizes an arbitrary or legacy 102-byte struct so every byte written via SysEx `0x0E`
 * is strictly 7-bit safe and within hardware limits while preserving valid preset fields.
 */
export function sanitizeStruct102ForSysEx(raw: Uint8Array): Uint8Array {
  if (raw.length < MG300_FILE_FORMAT.PRESET_STRUCT_SIZE) {
    throw new RangeError(`struct102 must have at least ${MG300_FILE_FORMAT.PRESET_STRUCT_SIZE} bytes`);
  }
  const out = Uint8Array.from(raw.subarray(0, MG300_FILE_FORMAT.PRESET_STRUCT_SIZE));

  // Chain blocks 0..10
  out[0x00] = (out[0x00] ?? 0) & 0x7f;
  for (let blockCc = 1; blockCc <= 10; blockCc++) {
    const model = out[blockCc] ?? 0;
    out[blockCc] = isValidMg300BlockModel(blockCc, model) ? model : 0;
  }

  // Block param regions 0x0b..0x42: STM32 masks bytes >= 0x80 with low nibble during 7-bit SysEx RX
  for (let i = 0x0b; i <= 0x42; i++) {
    const val = out[i] ?? 0;
    if (val >= 0x80) {
      out[i] = val & 0x0f;
    }
  }

  // IR cut 0..2
  out[0x43] = Math.max(0, Math.min(2, out[0x43] ?? 0));

  // Preset name (+0x44 len, +0x45..+0x56 chars): preserve valid glyph sequences, repair invalid ones
  const rawNameLen = out[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] ?? 0;
  let nameValid = rawNameLen >= 1 && rawNameLen <= MG300_FILE_FORMAT.MAX_NAME_LENGTH;
  if (nameValid) {
    for (let i = 0; i < rawNameLen; i++) {
      const ch = out[MG300_FILE_FORMAT.NAME_CHARS_OFFSET + i] ?? 0xff;
      if (ch >= MG300_CHAR_TABLE.length) {
        nameValid = false;
        break;
      }
    }
  }
  for (let i = rawNameLen; i < MG300_FILE_FORMAT.MAX_NAME_LENGTH; i++) {
    if ((out[MG300_FILE_FORMAT.NAME_CHARS_OFFSET + i] ?? 0) > 0x7f) {
      out[MG300_FILE_FORMAT.NAME_CHARS_OFFSET + i] = 0;
    }
  }
  if (!nameValid) {
    const fallbackEncoded = encodeMg300PresetName('Imported');
    out[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = fallbackEncoded.length;
    out.set(fallbackEncoded.bytes, MG300_FILE_FORMAT.NAME_CHARS_OFFSET);
  }

  // User IR name region (+0x57..+0x61)
  const rawIrLen = out[0x57] ?? 0x10;
  if (rawIrLen > 0x7f || (rawIrLen > 10 && rawIrLen !== 0x10)) {
    out[0x57] = 0x10;
  }
  for (let i = 0x58; i <= 0x61; i++) {
    const code = out[i] ?? 0;
    if (code >= MG300_CHAR_TABLE.length) {
      out[i] = code > 0x7f ? MG300_SPACE_CHAR_CODE : 0;
    }
  }

  out[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = Math.max(
    0,
    Math.min(40, out[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? 20),
  );
  out[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = (out[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] ?? 0) > 0 ? 1 : 0;
  out[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] = Math.max(
    40,
    Math.min(240, out[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] ?? 120),
  );
  out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] = Math.max(
    0,
    Math.min(100, out[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? 50),
  );

  return out;
}

export interface CompareStruct102ReadbackOptions {
  ignoreBlockHeaderOffsets?: boolean;
  ignoreInactiveAndUndeclaredParams?: boolean;
}

function collectIgnoredReadbackParamOffsets(expected: Uint8Array): Set<number> {
  const ignored = new Set<number>();
  for (const block of MG300_PARAM_BLOCKS) {
    if (block.structParamOffset === null) {
      continue;
    }
    const expectedModel = expected[block.cc] ?? 0;
    if (expectedModel === 0) {
      for (let slot = 0; slot < block.paramSlotCount; slot++) {
        ignored.add(block.structParamOffset + slot);
      }
      continue;
    }
    const spec = getMg300ModelSpec(block.id, expectedModel);
    if (!spec) {
      continue;
    }
    const declaredIndices = new Set(spec.params.map((p) => p.paramIndex));
    for (let slot = 0; slot < block.paramSlotCount; slot++) {
      if (!declaredIndices.has(slot)) {
        ignored.add(block.structParamOffset + slot);
      }
    }
  }

  // User IR name bytes (+0x58..+0x61) are inactive unless CAB === 100; marker +0x57 is always checked.
  if ((expected[0x09] ?? 0) !== MG300_USER_IR_CAB_ID) {
    for (let offset = 0x58; offset <= 0x61; offset++) {
      ignored.add(offset);
    }
  }

  return ignored;
}

/**
 * Compares written `struct102` against `0x07 -> 0x06` hardware readback, respecting
 * STM32's 7-bit low-nibble rule (`>= 0x80`), optional block ROM header reloads,
 * and optional filtering of bypassed/undeclared parameter slots.
 */
export function compareStruct102Readback(
  expected: Uint8Array,
  actual: Uint8Array,
  options: CompareStruct102ReadbackOptions = {},
): number[] {
  const ignoredParamOffsets = options.ignoreInactiveAndUndeclaredParams
    ? collectIgnoredReadbackParamOffsets(expected)
    : null;
  const mismatches: number[] = [];
  for (let i = 0; i < MG300_FILE_FORMAT.PRESET_STRUCT_SIZE; i++) {
    if (options.ignoreBlockHeaderOffsets && MG300_BLOCK_HEADER_OFFSETS.has(i)) {
      continue;
    }
    if (ignoredParamOffsets?.has(i)) {
      continue;
    }
    const exp = expected[i] ?? 0;
    const act = actual[i] ?? 0;
    if (exp === act) {
      continue;
    }
    if (i >= 0x0b && i <= 0x42 && exp >= 0x80 && (exp & 0x0f) === (act & 0x0f)) {
      continue;
    }
    mismatches.push(i);
  }
  return mismatches;
}

const WRITE_HEADER = [...MG300_SYSEX_PREFIX, 0x70, MG300_PRESET_WRITE_SUBCMD] as const;

/**
 * Builds the 113-byte `0x0E` frame:
 * F0 00 11 22 66 00 70 0E <slot> <struct[0..99]> <bpm>>4> <bpm&F> <struct[101]> F7
 * Strictly restricted to User slots (0..35 / 1A..9D). Factory slots (36..71) are never allowed.
 */
export function buildMg300PresetWriteSysEx(
  struct102: Uint8Array,
  slotIndex: number = MG300_EXPERIMENTAL_SLOT,
): number[] {
  if (struct102.length !== MG300_FILE_FORMAT.PRESET_STRUCT_SIZE) {
    throw new RangeError(`struct102 must have ${MG300_FILE_FORMAT.PRESET_STRUCT_SIZE} bytes`);
  }
  if (!isValidMg300UserSlot(slotIndex)) {
    throw new RangeError(
      `Preset write is restricted to User slots (${MG300_USER_SLOT_MIN}..${MG300_USER_SLOT_MAX}); got ${slotIndex}`,
    );
  }

  const payload: number[] = Array.from(struct102.subarray(0, 100));
  const bpm = struct102[100]!;
  payload.push(bpm >> 4, bpm & 0x0f, struct102[101]!);

  const bad = payload.findIndex((b) => b > 0x7f);
  if (bad !== -1) {
    throw new RangeError(`Payload byte ${bad} (0x${payload[bad]!.toString(16)}) is not 7-bit safe`);
  }

  return [...WRITE_HEADER, slotIndex, ...payload, 0xf7];
}

/** True only for a well-formed 0x0E write frame that targets a User slot (0..35). */
export function isExperimentalPresetWriteSysEx(bytes: readonly number[]): boolean {
  if (bytes.length !== MG300_PRESET_WRITE_FRAME_SIZE) {
    return false;
  }
  if (WRITE_HEADER.some((expected, i) => bytes[i] !== expected)) {
    return false;
  }
  const slot = bytes[8];
  if (slot === undefined || !isValidMg300UserSlot(slot) || bytes[bytes.length - 1] !== 0xf7) {
    return false;
  }
  return bytes
    .slice(9, bytes.length - 1)
    .every((b) => Number.isInteger(b) && b >= 0 && b <= 0x7f);
}

/** ACK from the pedal after a successful 0x0E: F0 00 11 22 66 00 70 0E <slot> F7. */
export function isPresetWriteAck(bytes: readonly number[], slotIndex: number): boolean {
  return (
    bytes.length === MG300_PRESET_WRITE_ACK_SIZE &&
    WRITE_HEADER.every((expected, i) => bytes[i] === expected) &&
    bytes[8] === slotIndex &&
    bytes[9] === 0xf7
  );
}

const EXPLICIT_SLOT_KEYWORD_REGEX =
  /(?:^|[^A-Za-z0-9_])((?:slot|banco|bank|preset|patch)\s*(?:#|n[º°o]?\.?\s*)?(?:F?[1-9][A-D]|\d{1,2}))(?![A-Za-z0-9_+])/i;
const BANK_CODE_CANDIDATE_REGEX =
  /(?:^|[^A-Za-z0-9_+.-])(F?[1-9][A-D])(?![A-Za-z0-9_+])/gi;
const SAFE_3D_BEFORE_REGEX =
  /(?:efeito|som|audio|áudio|reverb|delay|chorus|stereo|estéreo|palco|espaço|espaco|ambiência|ambiencia|spatial|espacial|depth|profundidade)(?:\s+em)?\s+$/i;
const SAFE_3D_AFTER_REGEX =
  /^\s+(?:sound|effect|efeito|audio|áudio|reverb|delay|chorus|stereo|estéreo|space|espacial|spatial|ambience|ambiência|depth|soundstage|stage|palco)\b/i;

/**
 * Detects explicit references to a target preset/slot (e.g., `4C`, `F1A`, `preset 4C`, `slot 10`, `no 3D`)
 * in a natural-language tone prompt while avoiding false positives on audio terms like `"efeito 3D"` / `"som 3D"`.
 */
export function containsForbiddenSlotMention(prompt: string): string | null {
  if (!prompt || !prompt.trim()) {
    return null;
  }

  const explicitMatch = EXPLICIT_SLOT_KEYWORD_REGEX.exec(prompt);
  if (explicitMatch?.[1]) {
    return explicitMatch[1].trim();
  }

  BANK_CODE_CANDIDATE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BANK_CODE_CANDIDATE_REGEX.exec(prompt)) !== null) {
    const token = match[1];
    if (!token) {
      continue;
    }
    if (token.toUpperCase() === '3D') {
      const tokenStart = match.index + match[0].length - token.length;
      const before = prompt.slice(0, tokenStart);
      const after = prompt.slice(tokenStart + token.length);
      if (SAFE_3D_BEFORE_REGEX.test(before) || SAFE_3D_AFTER_REGEX.test(after)) {
        continue;
      }
    }
    return token;
  }

  return null;
}
