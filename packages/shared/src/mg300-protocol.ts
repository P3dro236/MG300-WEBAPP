import type { Preset, PresetSignalChain } from './contracts.js';

/**
 * @quicktone/shared — Evidence-Backed NUX MG-300 Protocol & QuickTone File Format Constants
 *
 * Every constant in this module is backed by empirical evidence from:
 * 1. Real QuickTone files on the host machine:
 *    - `C:\Users\pedro\Documents\NUX\com.nux.quicktone.cfg` (30 B, magic "QuickTone Config")
 *    - `EaglesDF Crunch.nuxpreset` & `SCORPIONS.nuxpreset` (8,380 B = 0x20BC, magic "MG300 Preset Data")
 * 2. QuickTone executable (`QuickTone.exe` v2.4.12.27, PE32):
 *    - `0x004A6A80..0x004A7620` (`MG300 Preset Data` & `MG300AllPreset.nuxpreset` reader/writer)
 * 3. NUX MG-300 firmware V4.02.23 (`NUX NME-300`, VID=0x1FC9, PID=0x8260):
 *    - NXP MIMXRT106x USB-MIDI parser (`FUN_00010b86` @ `0x00010B86`)
 *    - STM32F103xC/D/E MIDI RX parser (`FUN_08039c3c` @ `0x08039C3C`)
 *    - STM32F103xC/D/E MIDI CC handler (`FUN_08038d04` @ `0x08038D04`)
 *    - STM32F103xC/D/E MIDI CC diff transmitter (`FUN_08017c34` @ `0x08017C34`)
 *    - STM32F103xC/D/E Factory Presets ROM (`0x0801917C` = `0x08018F80 + 0x1FC`)
 *    - STM32F103xC/D/E LCD RLE Font Table (`0x08035000` / `0x08020000`, `FUN_08010dfc` & `FUN_0800dbb2`)
 */

export const MG300_USB_IDENTITY = {
  vendorId: 0x1fc9,
  productId: 0x8260,
  productName: 'NUX NME-300',
  manufacturer: 'NUX',
  portNamePatterns: ['NUX NME-300', 'NME-300', 'NUX MG-300', 'MG-300'],
} as const;

export const MG300_FILE_FORMAT = {
  PRESET_MAGIC: 'MG300 Preset Data',
  CONFIG_MAGIC: 'QuickTone Config',
  HEADER_SIZE: 29, // u32 totalSize + u32 magicLen(17) + "MG300 Preset Data"(17) + u32 payloadSize
  EXPECTED_VERSION: 1,
  PRODUCT_ID: 0x66, // 102 — MG-300 product identifier in SysEx and .nuxpreset
  PRESET_STRUCT_SIZE: 0x66, // 102 bytes per preset in STM32 RAM/Flash and .nuxpreset
  SINGLE_PAYLOAD_V1_SIZE: 0x209f, // 8,351 B (12-byte header [ver=1, subver, prod=0x66] + 102 B preset + 8,237 B IR WAV)
  SINGLE_PAYLOAD_V2_SIZE: 0x20a0, // 8,352 B (8-byte header [ver=1, prod=0x66] + 1 B slot + 102 B preset + 8,241 B IR WAV)
  ALL_PAYLOAD_V1_SIZE: 0x49664, // 300,644 B (8-byte header [ver=1, prod=0x66] + 36 * 0x209F)
  ALL_PAYLOAD_V2_SIZE: 0x49688, // 300,680 B (8-byte header [ver=1, prod=0x66] + 36 * 0x20A0)
  NAME_LENGTH_OFFSET: 0x44, // Inside the 102-byte preset struct: 1..18
  NAME_CHARS_OFFSET: 0x45, // Inside the 102-byte preset struct: 18 bytes (0x45..0x56), next field starts at 0x57
  // Verified empirically on physical NUX MG-300: slot 10 (3C) has rawLen=17 at 0x44 ("Metallica Kirk H.")
  // and slot 14 (4C) has residual name bytes up to 0x56, with the next field consistently at 0x57 across all 36 slots.
  MAX_NAME_LENGTH: 18,
  IR_VOLUME_OFFSET: 0x62, // 0..40
  TIME_FLAG_OFFSET: 0x63,
  BPM_ENCODED_OFFSET: 0x64,
  PATCH_LEVEL_OFFSET: 0x65, // 0..100 (default 50 = 0x32)
} as const;

/**
 * Exact 72-character lookup table (indices 0x00..0x47) verified from:
 * - STM32F103 LCD font sprite table at `0x08035126` (`FUN_08010dfc` & `FUN_0800dbb2`)
 * - Real `.nuxpreset` files (`EaglesDF Crunch.nuxpreset`, `SCORPIONS.nuxpreset`)
 * - 36 Factory Presets in ROM at `0x0801917C` (`F2A` "SF BLUE-ME  ", `F5A` "RG J. Mayer", `F9C` "S.Vai Crying M")
 */
export const MG300_CHAR_TABLE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ?!-':&@,." as const;

export const MG300_SPACE_CHAR_CODE = 0x3e; // 62 (' ')

/**
 * Decodes an MG-300 preset name buffer (using length byte at +0x44 and chars at +0x45..+0x56, up to 18 bytes).
 * Note: glyph index 0x00 represents 'A' and is never a null terminator.
 */
export function decodeMg300PresetName(struct102: Uint8Array): string {
  if (struct102.length < MG300_FILE_FORMAT.PRESET_STRUCT_SIZE) {
    return '';
  }
  const rawLen = struct102[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] ?? 0;
  if (rawLen === 0 || rawLen > MG300_FILE_FORMAT.MAX_NAME_LENGTH) {
    return '';
  }
  const chars: string[] = [];
  for (let i = 0; i < rawLen; i++) {
    const code = struct102[MG300_FILE_FORMAT.NAME_CHARS_OFFSET + i];
    if (code === undefined || code >= MG300_CHAR_TABLE.length) {
      return '';
    }
    chars.push(MG300_CHAR_TABLE[code]!);
  }
  return chars.join('').trim();
}

/**
 * Encodes an ASCII string (up to 18 chars) into MG-300 character indices (0x00..0x47).
 * Useful for test fixtures and characterization tests.
 */
export function encodeMg300PresetName(name: string): { length: number; bytes: Uint8Array } {
  const trimmed = name.slice(0, MG300_FILE_FORMAT.MAX_NAME_LENGTH);
  const bytes = new Uint8Array(MG300_FILE_FORMAT.MAX_NAME_LENGTH);
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    const idx = MG300_CHAR_TABLE.indexOf(ch);
    bytes[i] = idx >= 0 ? idx : MG300_SPACE_CHAR_CODE;
  }
  return { length: trimmed.length, bytes };
}

/**
 * Evidence-backed MIDI Control Change numbers on the NUX MG-300 (`FUN_08038d04` @ `0x08038D04`).
 *
 * CRITICAL SAFETY NOTE:
 * On the NUX MG-300 original (`NUX NME-300`), `CC 1..10` (`0x01..0x0A`) select or bypass
 * the 10 effect blocks (`CC 7` = Delay block model/enable `state[0x411]`).
 * Sending standard MIDI `CC 7` (Channel Volume) to an MG-300 would overwrite the active preset's Delay model!
 */
export const MG300_MIDI_CC = {
  BANK_SELECT_MSB: 0x00, // Standard MIDI Bank Select MSB (0)
  BANK_SELECT_LSB: 0x20, // Standard MIDI Bank Select LSB (32)
  PRESET_SELECT: 0x3c, // CC 60 (value 0..71: 0..35 User 1A..9D, 36..71 Factory F1A..F9D)
  EXPRESSION_PEDAL: 0x3d, // CC 61 (value 0..100 -> state[0x12] physical expression pedal)
  PEDAL_BYPASS: 0x3e, // CC 62 (value 0..1 -> state[0x00] wah/pedal switch)
  MASTER_VOLUME: 0x40, // CC 64 (value 0..100 -> state[0x09] physical MASTER knob ADC0 / TI DSP tx[0x51])
  CURRENT_BLOCK: 0x42, // CC 66 (value 0..8 or 0x14=9 for P.LVL)
  USB_ROUTING_MODE: 0x43, // CC 67 (value 0..2 -> state[0x3FD])
  USB_RECORD_LEVEL: 0x44, // CC 68 (value 0..100 -> state[0x3FB])
  USB_PLAYBACK_LEVEL: 0x45, // CC 69 (value 0..100 -> state[0x3FC])
  IR_CAB_VOLUME: 0x47, // CC 71 (value 0..40 -> state[0x46C])
  TAP_TEMPO_FLAG: 0x49, // CC 73 (value 0..1 -> state[0x46D])
  PATCH_LEVEL: 0x4a, // CC 74 (value 0..100 -> state[0x46F] per-preset P.LVL output volume)
} as const;

/**
 * Effect block CCs (0x01..0x0A) that must NOT be used as volume CCs on MG-300.
 */
export const MG300_EFFECT_BLOCK_CCS = new Set<number>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

export type PatchLetter = 'A' | 'B' | 'C' | 'D';
export const PATCH_LETTERS: readonly PatchLetter[] = ['A', 'B', 'C', 'D'] as const;

export interface Mg300BankCoordinate {
  slotIndex: number; // 0..71
  bankType: 'user' | 'factory';
  bankNumber: number; // 1..9
  patchLetter: PatchLetter; // A..D
  displayBank: string; // "1A".."9D" or "F1A".."F9D"
}

/**
 * Converts an internal MG-300 slot index (0..71) to its QuickTone/LCD display label (`1A..9D` or `F1A..F9D`).
 * Verified in `FUN_08010dfc` (`bVar6 = slot / 4; uVar7 = slot % 4`) and `FUN_0800f338`.
 */
export function slotIndexToBankCoordinate(slotIndex: number): Mg300BankCoordinate {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 71) {
    throw new RangeError(`Invalid MG-300 slotIndex ${slotIndex}: expected integer in 0..71`);
  }
  const isFactory = slotIndex >= 36;
  const localIndex = isFactory ? slotIndex - 36 : slotIndex;
  const bankNumber = Math.floor(localIndex / 4) + 1;
  const patchLetter = PATCH_LETTERS[localIndex % 4]!;
  const prefix = isFactory ? 'F' : '';
  return {
    slotIndex,
    bankType: isFactory ? 'factory' : 'user',
    bankNumber,
    patchLetter,
    displayBank: `${prefix}${bankNumber}${patchLetter}`,
  };
}

/**
 * Parses a QuickTone/MG-300 bank label (`1A`..`9D` or `F1A`..`F9D`, case-insensitive) into its coordinate.
 */
export function parseBankLabel(label: string): Mg300BankCoordinate | null {
  const match = /^(F?)([1-9])([A-D])$/i.exec(label.trim());
  if (!match) {
    return null;
  }
  const isFactory = match[1]!.toUpperCase() === 'F';
  const bankNumber = Number.parseInt(match[2]!, 10);
  const patchLetter = match[3]!.toUpperCase() as PatchLetter;
  const letterIdx = PATCH_LETTERS.indexOf(patchLetter);
  const slotIndex = (isFactory ? 36 : 0) + (bankNumber - 1) * 4 + letterIdx;
  return {
    slotIndex,
    bankType: isFactory ? 'factory' : 'user',
    bankNumber,
    patchLetter,
    displayBank: `${isFactory ? 'F' : ''}${bankNumber}${patchLetter}`,
  };
}

/**
 * All 36 Factory Presets verified directly from `Stream 0x03` ROM (`0x0801917C` = `0x08018F80 + 0x1FC`).
 */
export const MG300_FACTORY_PRESETS: ReadonlyArray<{
  slotIndex: number;
  displayBank: string;
  name: string;
  patchVolume: number;
}> = [
  { slotIndex: 36, displayBank: 'F1A', name: 'CT 80JM Drive', patchVolume: 50 },
  { slotIndex: 37, displayBank: 'F1B', name: 'CT America80', patchVolume: 50 },
  { slotIndex: 38, displayBank: 'F1C', name: 'CT DLX Clean', patchVolume: 50 },
  { slotIndex: 39, displayBank: 'F1D', name: 'CT Mod Drive', patchVolume: 50 },
  { slotIndex: 40, displayBank: 'F2A', name: 'SF BLUE-ME', patchVolume: 50 },
  { slotIndex: 41, displayBank: 'F2B', name: 'SF METAL MO', patchVolume: 50 },
  { slotIndex: 42, displayBank: 'F2C', name: 'SF Shredy Ma', patchVolume: 50 },
  { slotIndex: 43, displayBank: 'F2D', name: 'SF SPACIALBa', patchVolume: 50 },
  { slotIndex: 44, displayBank: 'F3A', name: 'TMWAKA CLEA', patchVolume: 50 },
  { slotIndex: 45, displayBank: 'F3B', name: 'TMWAKA FUZZ', patchVolume: 50 },
  { slotIndex: 46, displayBank: 'F3C', name: 'TMWAKA LEAD', patchVolume: 50 },
  { slotIndex: 47, displayBank: 'F3D', name: 'TMWAKA PLEXI', patchVolume: 50 },
  { slotIndex: 48, displayBank: 'F4A', name: 'VT Blues lead', patchVolume: 50 },
  { slotIndex: 49, displayBank: 'F4B', name: 'VT Clean', patchVolume: 50 },
  { slotIndex: 50, displayBank: 'F4C', name: 'VTCleanChorus', patchVolume: 50 },
  { slotIndex: 51, displayBank: 'F4D', name: 'VT Dist lead', patchVolume: 50 },
  { slotIndex: 52, displayBank: 'F5A', name: 'RG J. Mayer', patchVolume: 50 },
  { slotIndex: 53, displayBank: 'F5B', name: 'RG Slash Rock', patchVolume: 50 },
  { slotIndex: 54, displayBank: 'F5C', name: 'RG SRV Gain', patchVolume: 50 },
  { slotIndex: 55, displayBank: 'F5D', name: 'RG SRV Clean', patchVolume: 50 },
  { slotIndex: 56, displayBank: 'F6A', name: 'GY 8th Floor', patchVolume: 50 },
  { slotIndex: 57, displayBank: 'F6B', name: 'GYBalladRotar', patchVolume: 50 },
  { slotIndex: 58, displayBank: 'F6C', name: 'JazzyInMyPant', patchVolume: 50 },
  { slotIndex: 59, displayBank: 'F6D', name: 'GY MS Solo', patchVolume: 50 },
  { slotIndex: 60, displayBank: 'F7A', name: 'RLDamageRect', patchVolume: 50 },
  { slotIndex: 61, displayBank: 'F7B', name: 'RL Titan Uber', patchVolume: 50 },
  { slotIndex: 62, displayBank: 'F7C', name: 'JL AC15 Plat', patchVolume: 50 },
  { slotIndex: 63, displayBank: 'F7D', name: 'JL BE Crunch', patchVolume: 50 },
  { slotIndex: 64, displayBank: 'F8A', name: 'JL JC120Clean', patchVolume: 50 },
  { slotIndex: 65, displayBank: 'F8B', name: 'JL Santana', patchVolume: 50 },
  { slotIndex: 66, displayBank: 'F8C', name: 'JL Slash', patchVolume: 50 },
  { slotIndex: 67, displayBank: 'F8D', name: 'JL Van Halen', patchVolume: 50 },
  { slotIndex: 68, displayBank: 'F9A', name: 'JL VH4 Crunch', patchVolume: 50 },
  { slotIndex: 69, displayBank: 'F9B', name: 'JL Vintage MS', patchVolume: 50 },
  { slotIndex: 70, displayBank: 'F9C', name: 'S.Vai Crying M', patchVolume: 50 },
  { slotIndex: 71, displayBank: 'F9D', name: 'EmotiveBallad', patchVolume: 50 },
] as const;

/**
 * Extracts active/bypassed states of the 9 signal chain blocks + Pedal block
 * from a 102-byte MG-300 preset struct (`state[0x40A..0x413]`).
 */
export function extractMg300SignalChain(struct102: Uint8Array): PresetSignalChain {
  return {
    pedalEnabled: (struct102[0x00] ?? 0) > 0,
    compEnabled: (struct102[0x01] ?? 0) > 0,
    efxEnabled: (struct102[0x02] ?? 0) > 0,
    ampEnabled: (struct102[0x03] ?? 0) > 0,
    eqEnabled: (struct102[0x04] ?? 0) > 0,
    nrEnabled: (struct102[0x05] ?? 0) > 0,
    modEnabled: (struct102[0x06] ?? 0) > 0,
    dlyEnabled: (struct102[0x07] ?? 0) > 0,
    rvbEnabled: (struct102[0x08] ?? 0) > 0,
    irEnabled: (struct102[0x09] ?? 0) > 0,
  };
}

export const MG300_SYSEX_PREFIX = [0xf0, 0x00, 0x11, 0x22, 0x66, 0x00] as const;

export const MG300_SYSEX_SUBCMD = {
  PRESET_DUMP: 0x06,
  QUERY_PRESET_SLOT: 0x07,
  PRESET_DUMP_ALT: 0x0e,
  PRESET_DUMP_ALL: 0x12,
  QUERY_ALL_PRESETS: 0x13,
  GLOBAL_STATUS_REPLY: 0x18,
  QUERY_GLOBAL_STATUS: 0x19,
} as const;

export function buildMg300IdentityQuerySysEx(): number[] {
  return [...MG300_SYSEX_PREFIX, 0x00, 0xf7];
}

export function buildMg300GlobalStatusQuerySysEx(): number[] {
  return [...MG300_SYSEX_PREFIX, 0x70, MG300_SYSEX_SUBCMD.QUERY_GLOBAL_STATUS, 0xf7];
}

export function buildMg300PresetQuerySysEx(slotIndex: number): number[] {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 71) {
    throw new RangeError(`Invalid MG-300 slotIndex ${slotIndex}: expected integer in 0..71`);
  }
  return [...MG300_SYSEX_PREFIX, 0x70, MG300_SYSEX_SUBCMD.QUERY_PRESET_SLOT, slotIndex, 0xf7];
}

export function buildMg300AllPresetsQuerySysEx(): number[] {
  return [...MG300_SYSEX_PREFIX, 0x70, MG300_SYSEX_SUBCMD.QUERY_ALL_PRESETS, 0xf7];
}

/**
 * Strictly validates that an outbound SysEx frame is one of the 4 verified read-only MG-300 queries.
 * Blocks all flash-write (`0x02`, `0x50`, `0x58`), preset-write, or unknown SysEx frames.
 */
export function isSafeReadOnlyMg300SysEx(bytes: readonly number[]): boolean {
  if (bytes.length < 8) {
    return false;
  }
  for (let i = 0; i < MG300_SYSEX_PREFIX.length; i++) {
    if (bytes[i] !== MG300_SYSEX_PREFIX[i]) {
      return false;
    }
  }
  if (bytes[bytes.length - 1] !== 0xf7) {
    return false;
  }

  // Identity query: F0 00 11 22 66 00 00 F7
  if (bytes.length === 8 && bytes[6] === 0x00) {
    return true;
  }

  if (bytes[6] !== 0x70) {
    return false;
  }

  const subcmd = bytes[7];
  if (
    bytes.length === 9 &&
    (subcmd === MG300_SYSEX_SUBCMD.QUERY_GLOBAL_STATUS ||
      subcmd === MG300_SYSEX_SUBCMD.QUERY_ALL_PRESETS)
  ) {
    return true;
  }

  if (
    bytes.length === 10 &&
    subcmd === MG300_SYSEX_SUBCMD.QUERY_PRESET_SLOT &&
    bytes[8] !== undefined &&
    Number.isInteger(bytes[8]) &&
    bytes[8] >= 0 &&
    bytes[8] <= 71
  ) {
    return true;
  }

  return false;
}

export type ParsedMg300SysExMessage =
  | {
      kind: 'identity';
      firmwareVersion: string;
      deviceName: string;
    }
  | {
      kind: 'global_status';
      slotIndex: number;
      pedalBypass: number;
      masterVolume: number;
      currentBlock: number;
      usbRoutingMode: number;
      usbRecordLevel: number;
      usbPlaybackLevel: number;
    }
  | {
      kind: 'preset_dump';
      subcmd: number;
      slotIndex: number;
      struct102: Uint8Array;
    };

function decodePrintableAsciiSlice(
  bytes: readonly number[],
  start: number,
  end: number,
): string {
  const chars: string[] = [];
  for (let i = start; i < end && i < bytes.length; i++) {
    const code = bytes[i]!;
    if (code === 0) {
      break;
    }
    if (code >= 0x20 && code <= 0x7e) {
      chars.push(String.fromCharCode(code));
    }
  }
  return chars.join('').trim();
}

/**
 * Parses an inbound NUX MG-300 SysEx response (`0x10` identity, `0x18` global status, `0x06`/`0x0E`/`0x12` 113B preset dump).
 */
export function parseMg300SysExMessage(
  bytes: readonly number[],
): ParsedMg300SysExMessage | null {
  if (bytes.length < 9 || bytes[bytes.length - 1] !== 0xf7) {
    return null;
  }
  for (let i = 0; i < MG300_SYSEX_PREFIX.length; i++) {
    if (bytes[i] !== MG300_SYSEX_PREFIX[i]) {
      return null;
    }
  }

  // 48-byte firmware identity reply (`FUN_00011d0e`): subcmd byte [6] === 0x10
  if (bytes[6] === 0x10 && bytes.length >= 48) {
    return {
      kind: 'identity',
      firmwareVersion: decodePrintableAsciiSlice(bytes, 7, 39),
      deviceName: decodePrintableAsciiSlice(bytes, 39, 47),
    };
  }

  if (bytes[6] !== 0x70) {
    return null;
  }

  const subcmd = bytes[7]!;

  // 17-byte global status reply (`FUN_08017608`): subcmd 0x18
  if (subcmd === MG300_SYSEX_SUBCMD.GLOBAL_STATUS_REPLY && bytes.length >= 17) {
    return {
      kind: 'global_status',
      slotIndex: bytes[9]!,
      pedalBypass: bytes[10]!,
      masterVolume: bytes[11]!,
      currentBlock: bytes[12]!,
      usbRoutingMode: bytes[13]!,
      usbRecordLevel: bytes[14]!,
      usbPlaybackLevel: bytes[15]!,
    };
  }

  // 113-byte (0x71) preset dump (`FUN_080174d6` / `0x06`, `0x0E`, `0x12`)
  if (
    (subcmd === MG300_SYSEX_SUBCMD.PRESET_DUMP ||
      subcmd === MG300_SYSEX_SUBCMD.PRESET_DUMP_ALT ||
      subcmd === MG300_SYSEX_SUBCMD.PRESET_DUMP_ALL) &&
    bytes.length >= 113
  ) {
    const slotIndex = bytes[8]!;
    if (slotIndex < 0 || slotIndex > 71) {
      return null;
    }
    const struct102 = new Uint8Array(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
    for (let i = 0; i < 100; i++) {
      struct102[i] = bytes[9 + i]!;
    }
    // FUN_080174d6 splits struct102[100] (BPM byte) into high/low 4-bit MIDI-safe nibbles
    struct102[100] = ((bytes[109]! & 0x0f) << 4) | (bytes[110]! & 0x0f);
    struct102[101] = bytes[111]!;
    return {
      kind: 'preset_dump',
      subcmd,
      slotIndex,
      struct102,
    };
  }

  return null;
}

export type PresetCategory = 'user' | 'factory';

/**
 * Normalizes a preset name for consistent comparison across ROM catalog, hardware dumps, and localStorage.
 */
export function normalizePresetName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const MG300_FACTORY_PRESET_NAME_SET: ReadonlySet<string> = new Set(
  MG300_FACTORY_PRESETS.map((p) => normalizePresetName(p.name)),
);

/**
 * Identifies synthetic placeholder/demo presets (e.g., "User 1A".."User 9D") that must not appear in the library.
 */
export function isPlaceholderPreset(
  preset: Pick<Preset, 'name' | 'origin' | 'displayBank'>,
): boolean {
  if (preset.origin === 'placeholder') {
    return true;
  }
  const normalized = preset.name.trim();
  if (/^user\s+f?[1-9][a-d]$/i.test(normalized)) {
    return true;
  }
  return false;
}

/** Slot 4D (user slot 15) — single canonical experimental edit slot and always-visible user slot. */
export const MG300_EXPERIMENTAL_SLOT = 15;
export const MG300_EXPERIMENTAL_SLOT_LABEL = '4D' as const;

/** User slots that must always remain visible in the User tab even if they still hold a factory copy name. */
const ALWAYS_VISIBLE_USER_SLOT_INDICES: ReadonlySet<number> = new Set([MG300_EXPERIMENTAL_SLOT]);

/**
 * Classifies a preset consistently into 'user' or 'factory' using origin, slot metadata, and normalized name,
 * avoiding misclassifying unmodified factory copies stored in user slots (5A..9D) solely by slot position.
 * Slot 4D (index 15) is always kept in 'user' so the experimental edit slot remains directly accessible.
 */
export function classifyPresetCategory(
  preset: Pick<Preset, 'slotIndex' | 'bankType' | 'name' | 'origin'>,
): PresetCategory {
  if (preset.origin === 'factory' || preset.slotIndex >= 36) {
    return 'factory';
  }
  if (ALWAYS_VISIBLE_USER_SLOT_INDICES.has(preset.slotIndex)) {
    return 'user';
  }
  if (MG300_FACTORY_PRESET_NAME_SET.has(normalizePresetName(preset.name))) {
    return 'factory';
  }
  return 'user';
}

/**
 * Filters out placeholder/demo presets and deduplicates unmodified factory copies residing in user slots
 * when canonical ROM factory presets (F1A..F9D) are already present.
 */
export function filterVisibleLibraryPresets<
  T extends Pick<Preset, 'slotIndex' | 'bankType' | 'name' | 'origin' | 'displayBank'>,
>(presets: readonly T[]): T[] {
  const nonPlaceholders = presets.filter((p) => !isPlaceholderPreset(p));
  const romFactoryNames = new Set<string>();
  for (const preset of nonPlaceholders) {
    if (preset.slotIndex >= 36 || preset.origin === 'factory') {
      romFactoryNames.add(normalizePresetName(preset.name));
    }
  }

  return nonPlaceholders.filter((preset) => {
    if (
      preset.slotIndex < 36 &&
      classifyPresetCategory(preset) === 'factory' &&
      romFactoryNames.has(normalizePresetName(preset.name))
    ) {
      return false;
    }
    return true;
  });
}
