import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MG300_FILE_FORMAT,
  MG300_MIDI_CC,
  MG300_USER_IR_CAB_ID,
  PresetSchema,
  PresetsResponseSchema,
  encodeMg300PresetName,
} from '@quicktone/shared';
import {
  MG300_SPACE_CHAR_CODE,
  QuickToneDiscoveryService,
  QuickTonePresetParseError,
  buildNuxAllPresetsBinary,
  buildNuxPresetBinary,
  parseNuxPresetBuffer,
  parseNuxPresetWithStruct102,
} from '../index.js';

describe('@quicktone/reader — QuickTone Binary Parser & Discovery Service', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'quicktone-reader-test-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures on Windows file locks
    }
  });

  it('1. Pasta inexistente: returns directory_not_found with clear warning and supports manual fallback via setDirectory', async () => {
    const missingDir = path.join(tempDir, 'non-existent-nux-folder');
    const discovery = new QuickToneDiscoveryService({
      directoryPath: missingDir,
      includeFactoryPresets: false,
    });

    const initialResult = await discovery.discover();
    expect(PresetsResponseSchema.safeParse(initialResult).success).toBe(true);
    expect(initialResult.directoryStatus).toBe('directory_not_found');
    expect(initialResult.directory).toBe(missingDir);
    expect(initialResult.presets).toHaveLength(0);
    expect(initialResult.warnings.length).toBeGreaterThan(0);
    expect(initialResult.warnings[0]).toContain(missingDir);

    // Fallback configuration to a valid directory
    const validPreset = buildNuxPresetBinary({
      name: 'Clean Studio',
      patchVolume: 64,
    });
    await fs.promises.writeFile(path.join(tempDir, 'Clean Studio.nuxpreset'), validPreset);

    const recoveredResult = await discovery.setDirectory(tempDir);
    expect(recoveredResult.directoryStatus).toBe('ok');
    expect(recoveredResult.directory).toBe(tempDir);
    expect(recoveredResult.presets).toHaveLength(1);
    expect(recoveredResult.presets[0]?.name).toBe('Clean Studio');
  });

  it('2. Arquivo inválido: rejects 0-byte, wrong-magic ("QuickTone Config"), and truncated buffers, and skips invalid files during directory scan', async () => {
    // 2a. Empty 0-byte file (identical to real C:\Users\pedro\Downloads\t.nuxpreset)
    expect(() => parseNuxPresetBuffer(new Uint8Array(0))).toThrow(QuickTonePresetParseError);
    expect(() => parseNuxPresetBuffer(new Uint8Array(0))).toThrow(/Invalid QuickTone preset file/);

    // 2b. Truncated header (< 29 bytes)
    expect(() => parseNuxPresetBuffer(new Uint8Array(16))).toThrow(QuickTonePresetParseError);

    // 2c. "QuickTone Config" file (identical to real C:\Users\pedro\Documents\NUX\com.nux.quicktone.cfg)
    const quickToneCfg = new Uint8Array(30);
    const cfgView = new DataView(quickToneCfg.buffer);
    cfgView.setUint32(0, 0x1a, true);
    cfgView.setUint32(4, 0x10, true);
    Buffer.from('QuickTone Config\0', 'ascii').copy(quickToneCfg, 8);
    expect(() => parseNuxPresetBuffer(quickToneCfg)).toThrow(/QuickTone Config/);

    // 2d. Valid magic "MG300 Preset Data" but truncated payload
    const truncatedPreset = buildNuxPresetBinary({ name: 'Truncated' }).subarray(0, 60);
    expect(() => parseNuxPresetBuffer(truncatedPreset)).toThrow(/truncated payload/);

    // 2e. Directory scan skips invalid files, records warnings, and loads valid presets
    await fs.promises.writeFile(path.join(tempDir, 't.nuxpreset'), new Uint8Array(0));
    await fs.promises.writeFile(path.join(tempDir, 'corrupt.nuxpreset'), truncatedPreset);
    await fs.promises.writeFile(
      path.join(tempDir, 'broken.json'),
      Buffer.from('{ invalid json', 'utf8'),
    );
    await fs.promises.writeFile(
      path.join(tempDir, 'ValidRock.nuxpreset'),
      buildNuxPresetBinary({ name: 'ValidRock', patchVolume: 72 }),
    );

    const discovery = new QuickToneDiscoveryService({ directoryPath: tempDir });
    const scanResult = await discovery.discover();

    expect(scanResult.directoryStatus).toBe('ok');
    expect(scanResult.presets).toHaveLength(1);
    expect(scanResult.presets[0]?.name).toBe('ValidRock');
    expect(scanResult.warnings.some((w) => w.includes('t.nuxpreset'))).toBe(true);
    expect(scanResult.warnings.some((w) => w.includes('corrupt.nuxpreset'))).toBe(true);
    expect(scanResult.warnings.some((w) => w.includes('broken.json'))).toBe(true);
  });

  it('3. Preset válido: parses real EaglesDF Crunch.nuxpreset and SCORPIONS.nuxpreset binary bytes in 100% read-only mode', async () => {
    // Exact byte indices from real EaglesDF Crunch.nuxpreset (0x20BC = 8,380 B)
    const eaglesRawNameBytes = [
      0x04, 0x1a, 0x20, 0x25, 0x1e, 0x2c, 0x03, 0x05, 0x3e, 0x02, 0x2b, 0x2e, 0x27, 0x1c, 0x21,
      0x00,
    ];
    const eaglesBinary = buildNuxPresetBinary({
      rawNameLength: 15,
      rawNameBytes: eaglesRawNameBytes,
      patchVolume: 0x32, // 50
      irVolume: 0x14, // 20
      formatVersion: 'v1',
      fullIrPayload: true,
    });

    expect(eaglesBinary.byteLength).toBe(8380); // 0x20BC
    const eaglesView = new DataView(eaglesBinary.buffer);
    expect(eaglesView.getUint32(0, true)).toBe(0x20b8);
    expect(eaglesView.getUint32(25, true)).toBe(MG300_FILE_FORMAT.SINGLE_PAYLOAD_V1_SIZE);

    const parsedEagles = parseNuxPresetBuffer(eaglesBinary, 'EaglesDF Crunch.nuxpreset', 0);
    expect(parsedEagles.warnings).toHaveLength(0);
    expect(parsedEagles.presets).toHaveLength(1);
    const eaglesPreset = parsedEagles.presets[0]!;
    expect(PresetSchema.safeParse(eaglesPreset).success).toBe(true);
    expect(eaglesPreset.name).toBe('EaglesDF Crunch');
    expect(eaglesPreset.displayBank).toBe('1A');
    expect(eaglesPreset.slotIndex).toBe(0);
    expect(eaglesPreset.patchVolume).toBe(50);
    expect(eaglesPreset.irVolume).toBe(20);
    expect(eaglesPreset.midiMapping).toEqual({
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: MG300_MIDI_CC.PRESET_SELECT,
      ccValue: 0,
      programNumber: 0,
      bankMsb: 0,
      bankLsb: 0,
    });

    // Exact byte indices from real SCORPIONS.nuxpreset (9 chars + 7 spaces 0x3E)
    const scorpionsRawNameBytes = [
      0x12, 0x02, 0x0e, 0x11, 0x0f, 0x08, 0x0e, 0x0d, 0x12, 0x3e, 0x3e, 0x3e, 0x3e, 0x3e, 0x3e,
      0x3e,
    ];
    const scorpionsBinary = buildNuxPresetBinary({
      rawNameLength: 9,
      rawNameBytes: scorpionsRawNameBytes,
      patchVolume: 50,
      irVolume: 20,
      formatVersion: 'v1',
      fullIrPayload: true,
    });

    const filePath = path.join(tempDir, 'SCORPIONS.nuxpreset');
    await fs.promises.writeFile(filePath, scorpionsBinary);
    const beforeBytes = await fs.promises.readFile(filePath);

    const discovery = new QuickToneDiscoveryService({ directoryPath: tempDir });
    const discovered = await discovery.discover();
    const afterBytes = await fs.promises.readFile(filePath);

    // Guarantee 100% read-only operation (original bytes untouched)
    expect(Buffer.compare(beforeBytes, afterBytes)).toBe(0);
    expect(discovered.presets).toHaveLength(1);
    expect(discovered.presets[0]?.name).toBe('SCORPIONS');

    // Also test V2 single preset format (payloadSize = 0x20A0 = 8,352 B, total = 8,381 B)
    const v2Binary = buildNuxPresetBinary({
      name: 'S.Vai Lead',
      slotIndex: 7, // 2D
      patchVolume: 82,
      formatVersion: 'v2',
      fullIrPayload: true,
    });
    expect(v2Binary.byteLength).toBe(8381);
    const parsedV2 = parseNuxPresetBuffer(v2Binary);
    expect(parsedV2.presets[0]?.name).toBe('S.Vai Lead');
    expect(parsedV2.presets[0]?.slotIndex).toBe(7);
    expect(parsedV2.presets[0]?.displayBank).toBe('2D');
    expect(parsedV2.presets[0]?.patchVolume).toBe(82);

    // Also test real QuickTone V4 subver=10 / payloadSize=0x20A0 format (1 flag byte @0x29 + 103B SysEx-safe struct @0x2A)
    const v4Buf = new Uint8Array(MG300_FILE_FORMAT.HEADER_SIZE + MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE);
    const v4View = new DataView(v4Buf.buffer);
    v4View.setUint32(0, 25 + MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE, true);
    v4View.setUint32(4, MG300_FILE_FORMAT.PRESET_MAGIC.length, true);
    Buffer.from(MG300_FILE_FORMAT.PRESET_MAGIC, 'ascii').copy(v4Buf, 8);
    v4View.setUint32(25, MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE, true);
    v4View.setUint32(0x1d, 1, true);
    v4View.setUint32(0x21, 10, true); // subver = 10
    v4View.setUint32(0x25, MG300_FILE_FORMAT.PRODUCT_ID, true);
    v4Buf[0x29] = 1;
    // Shin on Crazy (13 chars) + chain + irVol=20 + bpm=120 (0x07, 0x08) + patchVolume=70
    const shinBlocks = [0, 0, 5, 15, 1, 1, 7, 2, 3, 100, 3];
    v4Buf.set(shinBlocks, 0x2a);
    const shinNameBytes = [18, 33, 34, 39, 62, 40, 39, 62, 2, 43, 26, 51, 50];
    v4Buf[0x2a + MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = shinNameBytes.length;
    v4Buf.set(shinNameBytes, 0x2a + MG300_FILE_FORMAT.NAME_CHARS_OFFSET);
    v4Buf[0x2a + MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = 20;
    v4Buf[0x2a + 100] = 0x07;
    v4Buf[0x2a + 101] = 0x08;
    v4Buf[0x2a + 102] = 70;

    const parsedV4 = parseNuxPresetBuffer(v4Buf, 'Shin on Crazy.nuxpreset', 0);
    expect(parsedV4.warnings).toHaveLength(0);
    expect(parsedV4.presets[0]?.name).toBe('Shin on Crazy');
    expect(parsedV4.presets[0]?.patchVolume).toBe(70);
    expect(parsedV4.presets[0]?.irVolume).toBe(20);
    expect(parsedV4.presets[0]?.signalChain).toEqual({
      pedalEnabled: false,
      compEnabled: false,
      efxEnabled: true,
      ampEnabled: true,
      eqEnabled: true,
      nrEnabled: true,
      modEnabled: true,
      dlyEnabled: true,
      rvbEnabled: true,
      irEnabled: true,
    });

    // Compact V4 buffer with subver=10 and payloadSize=115 (144 bytes total, 1 byte short of 0x2a+103)
    // must throw truncated V4 error instead of silently falling back to V1 offset 0x29
    const truncatedV4 = new Uint8Array(0x2a + 102);
    truncatedV4.set(v4Buf.subarray(0, 0x2a + 102));
    const truncView = new DataView(truncatedV4.buffer);
    truncView.setUint32(0, truncatedV4.byteLength, true);
    truncView.setUint32(0x19, truncatedV4.byteLength - MG300_FILE_FORMAT.HEADER_SIZE, true);
    expect(() => parseNuxPresetBuffer(truncatedV4, 'truncated-v4.nuxpreset', 0)).toThrow(
      /truncated V4/i,
    );
  });

  it('4. Nome ausente: applies deterministic fallback ("Preset 1A" or filename) and emits warning when binary name is empty or all spaces', () => {
    // 4a. Name length = 0 without sourceFile -> "Preset 1A" + warning
    const zeroLenBinary = buildNuxPresetBinary({
      rawNameLength: 0,
      rawNameBytes: new Uint8Array(16),
    });
    const zeroLenResult = parseNuxPresetBuffer(zeroLenBinary, undefined, 0);
    expect(zeroLenResult.presets[0]?.name).toBe('Preset 1A');
    expect(zeroLenResult.warnings).toHaveLength(1);
    expect(zeroLenResult.warnings[0]).toContain('Preset 1A');

    // 4b. Name length = 16 filled only with MG-300 space code (0x3E) at slot 5 (2B) -> "Preset 2B" + warning
    const blankSpacesBinary = buildNuxPresetBinary({
      rawNameLength: 16,
      rawNameBytes: new Uint8Array(16).fill(MG300_SPACE_CHAR_CODE),
    });
    const blankSpacesResult = parseNuxPresetBuffer(blankSpacesBinary, 'unnamed.nuxpreset', 5);
    expect(blankSpacesResult.presets[0]?.displayBank).toBe('2B');
    expect(blankSpacesResult.presets[0]?.name).toBe('Preset 2B');
    expect(blankSpacesResult.warnings).toHaveLength(1);

    // 4c. Name length = 0 with meaningful sourceFile -> uses filename without .nuxpreset + warning
    const namedFileResult = parseNuxPresetBuffer(
      zeroLenBinary,
      'C:\\Users\\pedro\\Downloads\\Ambient Delay.nuxpreset',
      2,
    );
    expect(namedFileResult.presets[0]?.name).toBe('Ambient Delay');
    expect(namedFileResult.warnings).toHaveLength(1);
    expect(namedFileResult.warnings[0]).toContain('Ambient Delay');
  });

  it('5. Presets duplicados: detects duplicate preset names/files, assigns distinct user slots, marks isDuplicate=true, and logs warning', async () => {
    const scorpionsBytes = buildNuxPresetBinary({
      name: 'SCORPIONS',
      patchVolume: 50,
    });

    await fs.promises.writeFile(path.join(tempDir, 'SCORPIONS.nuxpreset'), scorpionsBytes);
    await fs.promises.writeFile(path.join(tempDir, 'SCORPIONS (1).nuxpreset'), scorpionsBytes);

    const discovery = new QuickToneDiscoveryService({ directoryPath: tempDir });
    const result = await discovery.discover();

    expect(result.directoryStatus).toBe('ok');
    expect(result.presets).toHaveLength(2);

    const first = result.presets[0]!;
    const second = result.presets[1]!;

    expect(first.name).toBe('SCORPIONS');
    expect(first.displayBank).toBe('1A');
    expect(first.slotIndex).toBe(0);
    expect(first.isDuplicate).toBe(false);

    expect(second.name).toBe('SCORPIONS');
    expect(second.displayBank).toBe('1B');
    expect(second.slotIndex).toBe(1);
    expect(second.isDuplicate).toBe(true);

    expect(result.warnings.some((w) => w.includes('Duplicate preset name "SCORPIONS"'))).toBe(true);
  });

  it('6. Múltiplos bancos: loads all 36 User Presets (1A..9D) from MG300AllPreset.nuxpreset plus 36 Factory Presets (F1A..F9D) across banks 1..9 A..D', async () => {
    const customSlots = Array.from({ length: 36 }, (_, idx) => ({
      name: `Stage Patch ${idx + 1}`,
      patchVolume: 40 + (idx % 50),
      slotIndex: idx,
    }));

    const bundleBinary = buildNuxAllPresetsBinary(customSlots, 'v2', true);
    // Exact V2 MG300AllPreset.nuxpreset size: 29 header + 300,680 (0x49688) payload = 300,709 B
    expect(bundleBinary.byteLength).toBe(
      MG300_FILE_FORMAT.HEADER_SIZE + MG300_FILE_FORMAT.ALL_PAYLOAD_V2_SIZE,
    );

    await fs.promises.writeFile(path.join(tempDir, 'MG300AllPreset.nuxpreset'), bundleBinary);

    const discovery = new QuickToneDiscoveryService({
      directoryPath: tempDir,
      includeFactoryPresets: true,
    });
    const result = await discovery.discover();

    expect(result.directoryStatus).toBe('ok');
    expect(result.presets).toHaveLength(72);

    const userPresets = result.presets.filter((p) => p.bankType === 'user');
    const factoryPresets = result.presets.filter((p) => p.bankType === 'factory');
    expect(userPresets).toHaveLength(36);
    expect(factoryPresets).toHaveLength(36);

    // Check User bank extremes (1A .. 9D)
    expect(userPresets[0]?.displayBank).toBe('1A');
    expect(userPresets[0]?.bankNumber).toBe(1);
    expect(userPresets[0]?.patchLetter).toBe('A');
    expect(userPresets[0]?.name).toBe('Stage Patch 1');
    expect(userPresets[0]?.midiMapping.ccValue).toBe(0);

    expect(userPresets[35]?.displayBank).toBe('9D');
    expect(userPresets[35]?.bankNumber).toBe(9);
    expect(userPresets[35]?.patchLetter).toBe('D');
    expect(userPresets[35]?.name).toBe('Stage Patch 36');
    expect(userPresets[35]?.midiMapping.ccValue).toBe(35);

    // Check Factory bank extremes (F1A .. F9D) verified from STM32 ROM 0x0801917C
    expect(factoryPresets[0]?.displayBank).toBe('F1A');
    expect(factoryPresets[0]?.slotIndex).toBe(36);
    expect(factoryPresets[0]?.name).toBe('CT 80JM Drive');
    expect(factoryPresets[0]?.midiMapping.ccValue).toBe(36);

    expect(factoryPresets[16]?.displayBank).toBe('F5A');
    expect(factoryPresets[16]?.name).toBe('RG J. Mayer');

    expect(factoryPresets[34]?.displayBank).toBe('F9C');
    expect(factoryPresets[34]?.name).toBe('S.Vai Crying M');

    expect(factoryPresets[35]?.displayBank).toBe('F9D');
    expect(factoryPresets[35]?.slotIndex).toBe(71);
    expect(factoryPresets[35]?.name).toBe('EmotiveBallad');
    expect(factoryPresets[35]?.midiMapping.ccValue).toBe(71);
  });

  it('7. Atualização de arquivos: detects added and modified .nuxpreset files via watchDirectory and reload()', async () => {
    const fileA = path.join(tempDir, 'Alpha.nuxpreset');
    await fs.promises.writeFile(
      fileA,
      buildNuxPresetBinary({ name: 'Alpha Clean', patchVolume: 45 }),
    );

    const discovery = new QuickToneDiscoveryService({
      directoryPath: tempDir,
      debounceMs: 25,
    });

    const initial = await discovery.discover();
    expect(initial.presets).toHaveLength(1);
    expect(initial.presets[0]?.name).toBe('Alpha Clean');
    expect(initial.presets[0]?.patchVolume).toBe(45);

    const updates: number[] = [];
    const unsubscribe = discovery.watchDirectory((updated) => {
      updates.push(updated.presets.length);
    });

    try {
      // Add a second preset file and modify the first preset file
      const fileB = path.join(tempDir, 'Beta.nuxpreset');
      await fs.promises.writeFile(
        fileB,
        buildNuxPresetBinary({ name: 'Beta Crunch', patchVolume: 80 }),
      );
      await fs.promises.writeFile(
        fileA,
        buildNuxPresetBinary({ name: 'Alpha Boosted', patchVolume: 90 }),
      );

      // Wait briefly for fs.watch debounce or trigger reload
      await new Promise((resolve) => setTimeout(resolve, 120));
      const refreshed = await discovery.reload();

      expect(refreshed.presets).toHaveLength(2);
      expect(refreshed.presets[0]?.name).toBe('Alpha Boosted');
      expect(refreshed.presets[0]?.patchVolume).toBe(90);
      expect(refreshed.presets[1]?.name).toBe('Beta Crunch');
      expect(refreshed.presets[1]?.patchVolume).toBe(80);
      expect(updates.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it('8. Extração binária para edição (parseNuxPresetWithStruct102): preserves struct102 & User IR metadata for V1/V2/V4/bundles and rejects JSON', () => {
    const v1 = buildNuxPresetBinary({ name: 'Crunch V1', patchVolume: 62, formatVersion: 'v1' });
    const parsedV1 = parseNuxPresetWithStruct102(v1);
    expect(parsedV1.entries).toHaveLength(1);
    expect(parsedV1.entries[0]?.struct102).toHaveLength(102);
    expect(parsedV1.entries[0]?.usesUserIr).toBe(false);
    expect(parsedV1.entries[0]?.userIrName).toBeNull();
    expect(parsedV1.entries[0]?.hasEmbeddedIrWav).toBe(true);

    const v2 = buildNuxPresetBinary({
      name: 'Lead V2',
      slotIndex: 9,
      patchVolume: 74,
      formatVersion: 'v2',
    });
    const parsedV2 = parseNuxPresetWithStruct102(v2);
    expect(parsedV2.entries[0]?.preset.displayBank).toBe('3B');
    expect(parsedV2.entries[0]?.struct102[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET]).toBe(74);

    // Build V4 binary (subver=10) with CAB=100 (User IR) and User IR name at +0x57..+0x61
    const v4Buf = new Uint8Array(
      MG300_FILE_FORMAT.HEADER_SIZE + MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE,
    );
    const v4View = new DataView(v4Buf.buffer);
    v4View.setUint32(0, 25 + MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE, true);
    v4View.setUint32(4, MG300_FILE_FORMAT.PRESET_MAGIC.length, true);
    Buffer.from(MG300_FILE_FORMAT.PRESET_MAGIC, 'ascii').copy(v4Buf, 8);
    v4View.setUint32(25, MG300_FILE_FORMAT.SINGLE_PAYLOAD_V2_SIZE, true);
    v4View.setUint32(0x1d, 1, true);
    v4View.setUint32(0x21, 10, true);
    v4View.setUint32(0x25, MG300_FILE_FORMAT.PRODUCT_ID, true);
    v4Buf[0x29] = 1;
    v4Buf.set([0, 0, 5, 15, 1, 1, 7, 2, 3, MG300_USER_IR_CAB_ID, 3], 0x2a);
    const encodedName = encodeMg300PresetName('V4 User IR');
    v4Buf[0x2a + MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = encodedName.length;
    v4Buf.set(encodedName.bytes, 0x2a + MG300_FILE_FORMAT.NAME_CHARS_OFFSET);
    const encodedIr = encodeMg300PresetName('CustomV30');
    v4Buf[0x2a + 0x57] = encodedIr.length;
    v4Buf.set(encodedIr.bytes.subarray(0, 10), 0x2a + 0x58);
    v4Buf[0x2a + 100] = 0x07; // 120 BPM high nibble
    v4Buf[0x2a + 101] = 0x08; // 120 BPM low nibble
    v4Buf[0x2a + 102] = 68;

    const parsedV4 = parseNuxPresetWithStruct102(v4Buf, { sourceFile: 'custom.nuxpreset' });
    expect(parsedV4.entries).toHaveLength(1);
    expect(parsedV4.entries[0]?.preset.name).toBe('V4 User IR');
    expect(parsedV4.entries[0]?.usesUserIr).toBe(true);
    expect(parsedV4.entries[0]?.userIrName).toBe('CustomV30');
    expect(parsedV4.entries[0]?.struct102[100]).toBe(120);
    expect(parsedV4.entries[0]?.struct102[101]).toBe(68);

    // 36-preset bundle extraction
    const bundle = buildNuxAllPresetsBinary([{ name: 'Slot One' }, { name: 'Slot Two' }], 'v2');
    const parsedBundle = parseNuxPresetWithStruct102(bundle);
    expect(parsedBundle.entries).toHaveLength(36);
    expect(parsedBundle.entries[0]?.preset.name).toBe('Slot One');
    expect(parsedBundle.entries[1]?.preset.name).toBe('Slot Two');

    // Strictly rejects JSON disguise when parsing binary upload
    const jsonBytes = new TextEncoder().encode(JSON.stringify({ name: 'Not binary' }));
    expect(() => parseNuxPresetWithStruct102(jsonBytes)).toThrow(QuickTonePresetParseError);
  });
});
