import fs from 'node:fs';
import path from 'node:path';
import {
  MG300_FACTORY_PRESETS,
  MG300_FILE_FORMAT,
  MG300_MIDI_CC,
  MG300_SPACE_CHAR_CODE,
  MG300_USER_IR_CAB_ID,
  Preset,
  type PresetOrigin,
  PresetSchema,
  decodeMg300PresetName,
  decodeMg300UserIrName,
  encodeMg300PresetName,
  extractMg300SignalChain,
  parseBankLabel,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';

export interface ParsePresetResult {
  presets: Preset[];
  warnings: string[];
}

export interface ParsedBinaryPresetEntry {
  preset: Preset;
  struct102: Uint8Array;
  usesUserIr: boolean;
  userIrName: string | null;
  hasEmbeddedIrWav: boolean;
}

export interface ParseBinaryPresetResult {
  entries: ParsedBinaryPresetEntry[];
  warnings: string[];
}

export class QuickTonePresetParseError extends Error {
  constructor(detail: string) {
    super(`Invalid QuickTone preset file: ${detail}`);
    this.name = 'QuickTonePresetParseError';
  }
}

export interface BuildNuxPresetOptions {
  name?: string;
  rawNameLength?: number;
  rawNameBytes?: Uint8Array | readonly number[];
  patchVolume?: number;
  irVolume?: number;
  slotIndex?: number;
  formatVersion?: 'v1' | 'v2';
  fullIrPayload?: boolean;
}

export interface BuildNuxAllPresetSlotInput {
  name?: string;
  rawNameLength?: number;
  rawNameBytes?: Uint8Array | readonly number[];
  patchVolume?: number;
  irVolume?: number;
  slotIndex?: number;
}

function clampSlotIndex(slotIndex: number): number {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) {
    return 0;
  }
  if (slotIndex > 71) {
    return slotIndex % 72;
  }
  return slotIndex;
}

function deriveFallbackPresetName(displayBank: string, sourceFile?: string): string {
  if (sourceFile) {
    const baseName = path
      .basename(sourceFile)
      .replace(/\.nuxpreset$/i, '')
      .replace(/\.presets\.json$/i, '')
      .replace(/\.json$/i, '')
      .trim();

    if (
      baseName.length > 0 &&
      baseName.toLowerCase() !== 'mg300allpreset' &&
      !/^(unnamed|untitled|empty|blank|noname|missing[-_]?name)$/i.test(baseName)
    ) {
      return baseName.slice(0, MG300_FILE_FORMAT.MAX_NAME_LENGTH);
    }
  }
  return `Preset ${displayBank}`;
}

export function buildPresetFromStruct102(
  struct102: Uint8Array,
  slotIndex: number,
  options: {
    sourceFile?: string;
    origin?: PresetOrigin;
    updatedAt?: string;
    warnings?: string[];
  } = {},
): Preset {
  if (struct102.byteLength < MG300_FILE_FORMAT.PRESET_STRUCT_SIZE) {
    throw new QuickTonePresetParseError(
      `preset struct truncated (${struct102.byteLength} < ${MG300_FILE_FORMAT.PRESET_STRUCT_SIZE} bytes)`,
    );
  }

  const safeSlot = clampSlotIndex(slotIndex);
  const coordinate = slotIndexToBankCoordinate(safeSlot);
  const decodedName = decodeMg300PresetName(struct102);

  let finalName = decodedName;
  if (finalName.length === 0) {
    finalName = deriveFallbackPresetName(coordinate.displayBank, options.sourceFile);
    options.warnings?.push(
      `Preset name missing or blank in binary at slot ${coordinate.displayBank}${
        options.sourceFile ? ` (${path.basename(options.sourceFile)})` : ''
      }; using fallback name "${finalName}".`,
    );
  }

  const rawPatchVolume = struct102[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] ?? 50;
  const patchVolume = rawPatchVolume >= 0 && rawPatchVolume <= 100 ? rawPatchVolume : 50;

  const rawIrVolume = struct102[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] ?? 20;
  const irVolume = rawIrVolume >= 0 && rawIrVolume <= 100 ? rawIrVolume : 20;

  return {
    id: coordinate.displayBank,
    slotIndex: coordinate.slotIndex,
    bankType: coordinate.bankType,
    bankNumber: coordinate.bankNumber,
    patchLetter: coordinate.patchLetter,
    displayBank: coordinate.displayBank,
    name: finalName,
    patchVolume,
    irVolume,
    ...(options.sourceFile ? { sourceFile: options.sourceFile } : {}),
    origin: options.origin ?? 'file',
    signalChain: extractMg300SignalChain(struct102),
    isDuplicate: false,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: MG300_MIDI_CC.PRESET_SELECT,
      ccValue: coordinate.slotIndex,
      programNumber: coordinate.slotIndex,
      bankMsb: 0,
      bankLsb: coordinate.bankType === 'factory' ? 1 : 0,
    },
  };
}

function tryParseJsonPresetFallback(
  buffer: Uint8Array,
  sourceFile: string | undefined,
  fallbackSlotIndex: number,
  updatedAt: string,
): ParsePresetResult | null {
  let startIdx = 0;
  // Skip UTF-8 BOM and leading ASCII whitespace
  if (
    buffer.byteLength >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    startIdx = 3;
  }
  while (
    startIdx < buffer.byteLength &&
    (buffer[startIdx] === 0x20 ||
      buffer[startIdx] === 0x09 ||
      buffer[startIdx] === 0x0a ||
      buffer[startIdx] === 0x0d)
  ) {
    startIdx++;
  }

  const firstByte = buffer[startIdx];
  if (firstByte !== 0x7b && firstByte !== 0x5b) {
    return null;
  }

  let parsed: unknown;
  try {
    const text = Buffer.from(buffer.subarray(startIdx)).toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    throw new QuickTonePresetParseError('malformed JSON preset file');
  }

  const warnings: string[] = [];
  const rawItems: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { presets?: unknown }).presets)
      ? (parsed as { presets: unknown[] }).presets
      : typeof parsed === 'object' && parsed !== null
        ? [parsed]
        : [];

  if (rawItems.length === 0) {
    throw new QuickTonePresetParseError('JSON file does not contain any preset records');
  }

  const presets: Preset[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (typeof item !== 'object' || item === null) {
      throw new QuickTonePresetParseError(`invalid JSON preset item at index ${i}`);
    }

    const record = item as Record<string, unknown>;
    const fullValidation = PresetSchema.safeParse(record);
    if (fullValidation.success) {
      presets.push({
        ...fullValidation.data,
        ...(sourceFile ? { sourceFile } : {}),
      });
      continue;
    }

    let resolvedSlot = fallbackSlotIndex + i;
    if (typeof record.slotIndex === 'number' && Number.isInteger(record.slotIndex)) {
      resolvedSlot = clampSlotIndex(record.slotIndex);
    } else if (typeof record.displayBank === 'string' || typeof record.id === 'string') {
      const bankLabel = (
        typeof record.displayBank === 'string' ? record.displayBank : (record.id as string)
      ).trim();
      const coord = parseBankLabel(bankLabel);
      if (coord) {
        resolvedSlot = coord.slotIndex;
      }
    }

    const coordinate = slotIndexToBankCoordinate(clampSlotIndex(resolvedSlot));
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    let finalName = rawName;
    if (finalName.length === 0) {
      finalName = deriveFallbackPresetName(coordinate.displayBank, sourceFile);
      warnings.push(
        `Preset name missing in JSON at slot ${coordinate.displayBank}; using fallback name "${finalName}".`,
      );
    }

    const rawPatchVol =
      typeof record.patchVolume === 'number'
        ? record.patchVolume
        : typeof record.volume === 'number'
          ? record.volume
          : 50;
    const patchVolume =
      Number.isFinite(rawPatchVol) && rawPatchVol >= 0 && rawPatchVol <= 100
        ? Math.round(rawPatchVol)
        : 50;

    const rawIrVol = typeof record.irVolume === 'number' ? record.irVolume : 20;
    const irVolume =
      Number.isFinite(rawIrVol) && rawIrVol >= 0 && rawIrVol <= 100 ? Math.round(rawIrVol) : 20;

    presets.push({
      id: coordinate.displayBank,
      slotIndex: coordinate.slotIndex,
      bankType: coordinate.bankType,
      bankNumber: coordinate.bankNumber,
      patchLetter: coordinate.patchLetter,
      displayBank: coordinate.displayBank,
      name: finalName,
      patchVolume,
      irVolume,
      ...(sourceFile ? { sourceFile } : {}),
      isDuplicate: false,
      updatedAt,
      midiMapping: {
        protocol: 'mg300-cc60',
        channel: 0,
        ccNumber: MG300_MIDI_CC.PRESET_SELECT,
        ccValue: coordinate.slotIndex,
        programNumber: coordinate.slotIndex,
        bankMsb: 0,
        bankLsb: coordinate.bankType === 'factory' ? 1 : 0,
      },
    });
  }

  return { presets, warnings };
}

function extractBinaryEntriesFromMg300Buffer(
  buffer: Uint8Array,
  options: {
    sourceFile?: string;
    fallbackSlotIndex: number;
    updatedAt: string;
  },
): ParseBinaryPresetResult {
  const { sourceFile, fallbackSlotIndex, updatedAt } = options;

  if (!buffer || buffer.byteLength === 0) {
    throw new QuickTonePresetParseError('empty file (0 bytes)');
  }

  if (buffer.byteLength < MG300_FILE_FORMAT.HEADER_SIZE) {
    throw new QuickTonePresetParseError(
      `file too small (${buffer.byteLength} bytes < ${MG300_FILE_FORMAT.HEADER_SIZE} header bytes)`,
    );
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const totalSize = view.getUint32(0, true);
  const magicLen = view.getUint32(4, true);
  const magic = Buffer.from(buffer.subarray(8, 25)).toString('ascii');

  if (magic.startsWith(MG300_FILE_FORMAT.CONFIG_MAGIC)) {
    throw new QuickTonePresetParseError(
      'file is a "QuickTone Config" file (com.nux.quicktone.cfg), not an MG-300 preset',
    );
  }

  if (magicLen !== MG300_FILE_FORMAT.PRESET_MAGIC.length || magic !== MG300_FILE_FORMAT.PRESET_MAGIC) {
    throw new QuickTonePresetParseError(
      `unexpected magic header "${magic}" (len=${magicLen}); expected "${MG300_FILE_FORMAT.PRESET_MAGIC}"`,
    );
  }

  const payloadSize = view.getUint32(25, true);
  if (payloadSize === 0 || buffer.byteLength < MG300_FILE_FORMAT.HEADER_SIZE + payloadSize) {
    throw new QuickTonePresetParseError(
      `truncated payload (expected ${payloadSize} payload bytes, buffer has ${
        buffer.byteLength - MG300_FILE_FORMAT.HEADER_SIZE
      })`,
    );
  }

  // In QuickTone.exe, totalSize at offset 0 is either (25 + payloadSize) or (29 + payloadSize)
  if (totalSize !== 25 + payloadSize && totalSize !== 29 + payloadSize) {
    throw new QuickTonePresetParseError(
      `header totalSize mismatch (totalSize=${totalSize}, payloadSize=${payloadSize})`,
    );
  }

  const warnings: string[] = [];
  const toEntry = (
    struct102Slice: Uint8Array,
    resolvedSlot: number,
    hasEmbeddedIrWav: boolean,
  ): ParsedBinaryPresetEntry => {
    const struct102 = Uint8Array.from(struct102Slice);
    const preset = buildPresetFromStruct102(struct102, resolvedSlot, {
      sourceFile,
      updatedAt,
      warnings,
    });
    return {
      preset,
      struct102,
      usesUserIr: struct102[0x09] === MG300_USER_IR_CAB_ID,
      userIrName: decodeMg300UserIrName(struct102),
      hasEmbeddedIrWav,
    };
  };

  // Format C: 36-Preset Bundle (MG300AllPreset.nuxpreset)
  const isAllPresetsBundle =
    payloadSize === MG300_FILE_FORMAT.ALL_PAYLOAD_V1_SIZE ||
    payloadSize === MG300_FILE_FORMAT.ALL_PAYLOAD_V2_SIZE ||
    (payloadSize >= 8 + 36 * MG300_FILE_FORMAT.PRESET_STRUCT_SIZE && (payloadSize - 8) % 36 === 0);

  if (isAllPresetsBundle) {
    const version = view.getUint32(0x1d, true);
    const productId = view.getUint32(0x21, true);
    if (
      version !== MG300_FILE_FORMAT.EXPECTED_VERSION ||
      productId !== MG300_FILE_FORMAT.PRODUCT_ID
    ) {
      throw new QuickTonePresetParseError(
        `invalid MG300AllPreset bundle header (version=${version}, productId=0x${productId.toString(16)})`,
      );
    }

    const recordStep = (payloadSize - 8) / 36;
    const entries: ParsedBinaryPresetEntry[] = [];

    for (let slot = 0; slot < 36; slot++) {
      const recordOffset = 0x25 + slot * recordStep;
      let resolvedSlot = slot;
      let structOffset = recordOffset;

      if (recordStep === MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE || recordStep === 0x67) {
        const slotByte = buffer[recordOffset] ?? slot;
        resolvedSlot = slotByte >= 0 && slotByte < 36 ? slotByte : slot;
        structOffset = recordOffset + 1;
      } else if (
        recordStep >= 12 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE &&
        view.getUint32(recordOffset, true) === MG300_FILE_FORMAT.EXPECTED_VERSION &&
        view.getUint32(recordOffset + 8, true) === MG300_FILE_FORMAT.PRODUCT_ID
      ) {
        structOffset = recordOffset + 12;
      }

      const struct102 = buffer.subarray(
        structOffset,
        structOffset + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE,
      );
      entries.push(toEntry(struct102, resolvedSlot, recordStep > 200));
    }

    return { entries, warnings };
  }

  // Format A: Single Preset V1 / V4
  if (payloadSize >= 12 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE) {
    const version = view.getUint32(0x1d, true);
    const subver = view.getUint32(0x21, true);
    const productIdV1 = view.getUint32(0x25, true);
    if (
      version === MG300_FILE_FORMAT.EXPECTED_VERSION &&
      productIdV1 === MG300_FILE_FORMAT.PRODUCT_ID
    ) {
      let struct102: Uint8Array;
      if (payloadSize === MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE || subver >= 10) {
        if (buffer.byteLength < 0x2a + 103) {
          throw new QuickTonePresetParseError('truncated V4 preset payload');
        }
        // QuickTone >= v2.4 / MG-300 V4 format (subver=10, payloadSize=0x20A0):
        // 1 flag/slot byte at 0x29 followed by 103-byte SysEx-safe struct (split BPM nibbles at +100/+101)
        struct102 = new Uint8Array(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
        struct102.set(buffer.subarray(0x2a, 0x2a + 100), 0);
        struct102[100] = ((buffer[0x2a + 100]! & 0x0f) << 4) | (buffer[0x2a + 101]! & 0x0f);
        struct102[101] = buffer[0x2a + 102]!;
      } else {
        struct102 = buffer.subarray(0x29, 0x29 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
      }
      return {
        entries: [toEntry(struct102, fallbackSlotIndex, payloadSize > 500)],
        warnings,
      };
    }
  }

  // Format B: Single Preset V2 (8-byte payload header: [version=1, productId=0x66] + 1B slot + 102B struct)
  if (payloadSize >= 9 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE) {
    const version = view.getUint32(0x1d, true);
    const productIdV2 = view.getUint32(0x21, true);
    if (
      version === MG300_FILE_FORMAT.EXPECTED_VERSION &&
      productIdV2 === MG300_FILE_FORMAT.PRODUCT_ID
    ) {
      const slotByte = buffer[0x25] ?? fallbackSlotIndex;
      const resolvedSlot = slotByte >= 0 && slotByte <= 71 ? slotByte : fallbackSlotIndex;
      const struct102 = buffer.subarray(0x26, 0x26 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
      return {
        entries: [toEntry(struct102, resolvedSlot, payloadSize > 500)],
        warnings,
      };
    }
  }

  throw new QuickTonePresetParseError(
    `unrecognized MG300 payload structure (payloadSize=${payloadSize})`,
  );
}

/**
 * Pure read-only binary parser for `.nuxpreset` buffers that preserves raw `struct102`
 * bytes and User IR metadata. Strictly rejects non-binary / JSON payloads.
 */
export function parseNuxPresetWithStruct102(
  buffer: Uint8Array,
  options: {
    sourceFile?: string;
    fallbackSlotIndex?: number;
    updatedAt?: string;
  } = {},
): ParseBinaryPresetResult {
  return extractBinaryEntriesFromMg300Buffer(buffer, {
    sourceFile: options.sourceFile,
    fallbackSlotIndex: options.fallbackSlotIndex ?? 0,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  });
}

/**
 * Pure read-only binary/JSON parser for NUX MG-300 QuickTone preset buffers (`.nuxpreset`).
 *
 * Supported binary layouts (all prefixed by 29-byte header with magic `"MG300 Preset Data"`):
 * 1. Single Preset V1 (`payloadSize === 0x209F` = 8,351 B, or compact >= 114 B):
 *    `u32 version(1) + u32 subver + u32 productId(0x66) + 102B struct + IR WAV`
 * 1b. Single Preset V4 (`subver >= 10` / `payloadSize === 0x20A0` = 8,352 B):
 *    `u32 version(1) + u32 subver(10) + u32 productId(0x66) + u8 flag + 103B SysEx-safe struct (split BPM nibbles) + IR WAV`
 * 2. Single Preset V2 (`payloadSize === 0x20A0` = 8,352 B, or compact >= 111 B):
 *    `u32 version(1) + u32 productId(0x66) + u8 slotIndex(0..35) + 102B struct + IR WAV`
 * 3. 36-Preset Bundle `MG300AllPreset.nuxpreset` (`payloadSize === 0x49664` = 300,644 B or `0x49688` = 300,680 B):
 *    `u32 version(1) + u32 productId(0x66) + 36 * record`
 */
export function parseNuxPresetBuffer(
  buffer: Uint8Array,
  sourceFile?: string,
  fallbackSlotIndex = 0,
  updatedAt = new Date().toISOString(),
): ParsePresetResult {
  if (!buffer || buffer.byteLength === 0) {
    throw new QuickTonePresetParseError('empty file (0 bytes)');
  }

  // Check if the buffer lacks the binary magic and starts with JSON '{' or '['
  const looksLikeBinaryPreset =
    buffer.byteLength >= MG300_FILE_FORMAT.HEADER_SIZE &&
    Buffer.from(buffer.subarray(8, 25)).toString('ascii') === MG300_FILE_FORMAT.PRESET_MAGIC;

  if (!looksLikeBinaryPreset) {
    const jsonFallback = tryParseJsonPresetFallback(
      buffer,
      sourceFile,
      fallbackSlotIndex,
      updatedAt,
    );
    if (jsonFallback) {
      return jsonFallback;
    }
  }

  const parsed = extractBinaryEntriesFromMg300Buffer(buffer, {
    sourceFile,
    fallbackSlotIndex,
    updatedAt,
  });
  return {
    presets: parsed.entries.map((entry) => entry.preset),
    warnings: parsed.warnings,
  };
}

/**
 * Reads and parses a `.nuxpreset` or `.json` file from disk in strict read-only mode.
 */
export async function parseNuxPresetFile(
  filePath: string,
  fallbackSlotIndex = 0,
): Promise<ParsePresetResult> {
  const [fileBuffer, stats] = await Promise.all([
    fs.promises.readFile(filePath),
    fs.promises.stat(filePath),
  ]);
  const uint8 = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
  return parseNuxPresetBuffer(uint8, filePath, fallbackSlotIndex, stats.mtime.toISOString());
}

/**
 * Builds a 102-byte MG-300 preset struct (`0x66` bytes) for testing and characterization fixtures.
 */
export function buildMg300Struct102(options: BuildNuxPresetOptions = {}): Uint8Array {
  const struct = new Uint8Array(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);

  // Populate realistic DSP block defaults matching STM32 RAM state[0x40A..0x414] & real .nuxpreset files
  struct[0x00] = 0x00; // Pedal/Wah bypass
  struct[0x01] = 0x01; // COMP enable
  struct[0x02] = 0x02; // EFX enable
  struct[0x03] = 0x01; // AMP enable
  struct[0x04] = 0x01; // EQ enable
  struct[0x05] = 0x01; // NR enable
  struct[0x06] = 0x01; // MOD enable
  struct[0x07] = 0x01; // DLY enable
  struct[0x08] = 0x01; // RVB enable
  struct[0x09] = 0x01; // IR/CAB enable
  struct[0x0a] = 0x01; // MIC ID

  if (options.rawNameBytes !== undefined || options.rawNameLength !== undefined) {
    struct[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = options.rawNameLength ?? 0;
    if (options.rawNameBytes) {
      for (
        let i = 0;
        i < Math.min(options.rawNameBytes.length, MG300_FILE_FORMAT.MAX_NAME_LENGTH);
        i++
      ) {
        struct[MG300_FILE_FORMAT.NAME_CHARS_OFFSET + i] = options.rawNameBytes[i]!;
      }
    }
  } else {
    const nameToEncode = options.name ?? 'Preset 1A';
    const encoded = encodeMg300PresetName(nameToEncode);
    struct[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = encoded.length;
    struct.set(encoded.bytes, MG300_FILE_FORMAT.NAME_CHARS_OFFSET);
  }

  struct[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] =
    options.irVolume !== undefined ? Math.max(0, Math.min(100, options.irVolume)) : 20;
  struct[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = 0x01;
  struct[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] = 0x2c;
  struct[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] =
    options.patchVolume !== undefined ? Math.max(0, Math.min(100, options.patchVolume)) : 50;

  return struct;
}

/**
 * Builds a complete binary `.nuxpreset` buffer (`"MG300 Preset Data"`) in V1 (8,380 B) or V2 (8,381 B) format.
 */
export function buildNuxPresetBinary(options: BuildNuxPresetOptions = {}): Uint8Array {
  const formatVersion = options.formatVersion ?? 'v1';
  const fullIrPayload = options.fullIrPayload ?? true;
  const struct102 = buildMg300Struct102(options);

  const payloadSize =
    formatVersion === 'v1'
      ? fullIrPayload
        ? MG300_FILE_FORMAT.SINGLE_PAYLOAD_V1_SIZE
        : 12 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE
      : fullIrPayload
        ? MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE
        : 9 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE;

  const totalFileBytes = MG300_FILE_FORMAT.HEADER_SIZE + payloadSize;
  const buffer = new Uint8Array(totalFileBytes);
  const view = new DataView(buffer.buffer);

  // 29-byte header
  view.setUint32(0, 25 + payloadSize, true); // totalSize = 0x20B8 for V1
  view.setUint32(4, MG300_FILE_FORMAT.PRESET_MAGIC.length, true); // 17
  Buffer.from(MG300_FILE_FORMAT.PRESET_MAGIC, 'ascii').copy(buffer, 8);
  view.setUint32(25, payloadSize, true);

  if (formatVersion === 'v1') {
    view.setUint32(0x1d, MG300_FILE_FORMAT.EXPECTED_VERSION, true);
    view.setUint32(0x21, 1, true); // subver = 1
    view.setUint32(0x25, MG300_FILE_FORMAT.PRODUCT_ID, true); // 0x66
    buffer.set(struct102, 0x29);
  } else {
    view.setUint32(0x1d, MG300_FILE_FORMAT.EXPECTED_VERSION, true);
    view.setUint32(0x21, MG300_FILE_FORMAT.PRODUCT_ID, true); // 0x66
    buffer[0x25] = clampSlotIndex(options.slotIndex ?? 0);
    buffer.set(struct102, 0x26);
  }

  return buffer;
}

/**
 * Builds a 36-preset `MG300AllPreset.nuxpreset` binary bundle (`0x49664` V1 or `0x49688` V2 payload).
 */
export function buildNuxAllPresetsBinary(
  slots: ReadonlyArray<BuildNuxAllPresetSlotInput> = [],
  formatVersion: 'v1' | 'v2' = 'v2',
  fullIrPayload = true,
): Uint8Array {
  const recordStep =
    formatVersion === 'v1'
      ? fullIrPayload
        ? MG300_FILE_FORMAT.SINGLE_PAYLOAD_V1_SIZE
        : MG300_FILE_FORMAT.PRESET_STRUCT_SIZE
      : fullIrPayload
        ? MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE
        : 1 + MG300_FILE_FORMAT.PRESET_STRUCT_SIZE;

  const payloadSize = 8 + 36 * recordStep;
  const buffer = new Uint8Array(MG300_FILE_FORMAT.HEADER_SIZE + payloadSize);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, 25 + payloadSize, true);
  view.setUint32(4, MG300_FILE_FORMAT.PRESET_MAGIC.length, true);
  Buffer.from(MG300_FILE_FORMAT.PRESET_MAGIC, 'ascii').copy(buffer, 8);
  view.setUint32(25, payloadSize, true);

  // Bundle 8-byte header: version=1, productId=0x66
  view.setUint32(0x1d, MG300_FILE_FORMAT.EXPECTED_VERSION, true);
  view.setUint32(0x21, MG300_FILE_FORMAT.PRODUCT_ID, true);

  for (let slot = 0; slot < 36; slot++) {
    const coord = slotIndexToBankCoordinate(slot);
    const input = slots[slot];
    const struct102 = buildMg300Struct102({
      name: input?.name ?? `User ${coord.displayBank}`,
      rawNameLength: input?.rawNameLength,
      rawNameBytes: input?.rawNameBytes,
      patchVolume: input?.patchVolume ?? 50,
      irVolume: input?.irVolume ?? 20,
      slotIndex: input?.slotIndex ?? slot,
    });

    const recordOffset = 0x25 + slot * recordStep;
    if (formatVersion === 'v2') {
      buffer[recordOffset] = clampSlotIndex(input?.slotIndex ?? slot);
      buffer.set(struct102, recordOffset + 1);
    } else {
      buffer.set(struct102, recordOffset);
    }
  }

  return buffer;
}

/**
 * Generates the 36 immutable Factory Presets (`F1A..F9D`, slots `36..71`) backed by STM32 ROM (`0x0801917C`).
 */
export function createFactoryPresets(updatedAt = new Date().toISOString()): Preset[] {
  return MG300_FACTORY_PRESETS.map((factoryPreset) => {
    const coordinate = slotIndexToBankCoordinate(factoryPreset.slotIndex);
    return {
      id: coordinate.displayBank,
      slotIndex: coordinate.slotIndex,
      bankType: 'factory',
      bankNumber: coordinate.bankNumber,
      patchLetter: coordinate.patchLetter,
      displayBank: coordinate.displayBank,
      name: factoryPreset.name,
      patchVolume: factoryPreset.patchVolume,
      irVolume: 20,
      origin: 'factory',
      isDuplicate: false,
      updatedAt,
      midiMapping: {
        protocol: 'mg300-cc60',
        channel: 0,
        ccNumber: MG300_MIDI_CC.PRESET_SELECT,
        ccValue: coordinate.slotIndex,
        programNumber: coordinate.slotIndex,
        bankMsb: 0,
        bankLsb: 1,
      },
    };
  });
}

/**
 * Generates baseline addressable User Slots (`1A..9D`, slots `0..35`) when hardware dumps or `.nuxpreset` files are unavailable.
 */
export function createUserPlaceholderPresets(
  updatedAt = new Date().toISOString(),
): Preset[] {
  const placeholders: Preset[] = [];
  for (let slotIndex = 0; slotIndex < 36; slotIndex++) {
    const coordinate = slotIndexToBankCoordinate(slotIndex);
    placeholders.push({
      id: coordinate.displayBank,
      slotIndex: coordinate.slotIndex,
      bankType: 'user',
      bankNumber: coordinate.bankNumber,
      patchLetter: coordinate.patchLetter,
      displayBank: coordinate.displayBank,
      name: `User ${coordinate.displayBank}`,
      patchVolume: 50,
      irVolume: 20,
      origin: 'placeholder',
      isDuplicate: false,
      updatedAt,
      midiMapping: {
        protocol: 'mg300-cc60',
        channel: 0,
        ccNumber: MG300_MIDI_CC.PRESET_SELECT,
        ccValue: coordinate.slotIndex,
        programNumber: coordinate.slotIndex,
        bankMsb: 0,
        bankLsb: 0,
      },
    });
  }
  return placeholders;
}

export { MG300_SPACE_CHAR_CODE };
