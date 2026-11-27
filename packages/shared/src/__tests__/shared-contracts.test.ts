import { describe, it, expect } from 'vitest';
import {
  MG300_BLOCK_CATALOG,
  MG300_CHAR_TABLE,
  MG300_EXPERIMENTAL_SLOT,
  MG300_EXPERIMENTAL_SLOT_LABEL,
  MG300_FACTORY_PRESETS,
  MG300_FILE_FORMAT,
  MG300_MIDI_CC,
  MG300_USER_IR_CAB_ID,
  buildMg300PresetWriteSysEx,
  compareStruct102Readback,
  createBlankMg300Struct102,
  decodeMg300PresetName,
  decodeMg300UserIrName,
  encodeMg300PresetName,
  getMg300ModelDefaultParams,
  getMg300ModelSpec,
  isExperimentalPresetWriteSysEx,
  isValidMg300BlockModel,
  isValidMg300ExperimentalCcValue,
  isValidMg300UserSlot,
  parseBankLabel,
  sanitizeMg300PresetName,
  sanitizeStruct102ForSysEx,
  slotIndexToBankCoordinate,
  SelectPresetRequestSchema,
  UpdateVolumeRequestSchema,
  UpdateVolumeTargetRequestSchema,
  ControllerStateSchema,
  ExperimentalEditStateSchema,
  buildMg300IdentityQuerySysEx,
  buildMg300GlobalStatusQuerySysEx,
  buildMg300PresetQuerySysEx,
  buildMg300AllPresetsQuerySysEx,
  isSafeReadOnlyMg300SysEx,
  parseMg300SysExMessage,
  extractMg300SignalChain,
  classifyPresetCategory,
  isPlaceholderPreset,
  filterVisibleLibraryPresets,
  containsForbiddenSlotMention,
  AiGearConfigSchema,
  UpdateAiGearRequestSchema,
  AiGearStateResponseSchema,
  AiToneApplyRequestSchema,
  AiToneApplyResponseSchema,
  WsServerMessageSchema,
} from '../index.js';

describe('@quicktone/shared — MG-300 Protocol & Contracts', () => {
  it('verifies the 72-character MG-300 LCD alphabet (0x00..0x47)', () => {
    expect(MG300_CHAR_TABLE.length).toBe(72);
    expect(MG300_CHAR_TABLE[0x00]).toBe('A');
    expect(MG300_CHAR_TABLE[0x19]).toBe('Z');
    expect(MG300_CHAR_TABLE[0x1a]).toBe('a');
    expect(MG300_CHAR_TABLE[0x33]).toBe('z');
    expect(MG300_CHAR_TABLE[0x34]).toBe('0');
    expect(MG300_CHAR_TABLE[0x3d]).toBe('9');
    expect(MG300_CHAR_TABLE[0x3e]).toBe(' ');
    expect(MG300_CHAR_TABLE[0x41]).toBe('-');
    expect(MG300_CHAR_TABLE[0x47]).toBe('.');
  });

  it('decodes real MG-300 preset names from byte sequences (EaglesDF Crunch & SCORPIONS)', () => {
    const struct1 = new Uint8Array(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
    const eaglesBytes = [
      0x0f, // length = 15
      0x04, 0x1a, 0x20, 0x25, 0x1e, 0x2c, 0x03, 0x05, 0x3e, 0x02, 0x2b, 0x2e, 0x27, 0x1c, 0x21,
    ];
    struct1.set(eaglesBytes, MG300_FILE_FORMAT.NAME_LENGTH_OFFSET);
    expect(decodeMg300PresetName(struct1)).toBe('EaglesDF Crunch');

    const struct2 = new Uint8Array(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
    const scorpionsBytes = [0x09, 0x12, 0x02, 0x0e, 0x11, 0x0f, 0x08, 0x0e, 0x0d, 0x12];
    struct2.set(scorpionsBytes, MG300_FILE_FORMAT.NAME_LENGTH_OFFSET);
    expect(decodeMg300PresetName(struct2)).toBe('SCORPIONS');
  });

  it('round-trips encodeMg300PresetName and decodeMg300PresetName', () => {
    const encoded = encodeMg300PresetName('RG J. Mayer');
    const struct = new Uint8Array(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
    struct[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET] = encoded.length;
    struct.set(encoded.bytes, MG300_FILE_FORMAT.NAME_CHARS_OFFSET);
    expect(decodeMg300PresetName(struct)).toBe('RG J. Mayer');
  });

  it('maps MG-300 slot indices (0..71) to User (1A..9D) and Factory (F1A..F9D) coordinates', () => {
    expect(slotIndexToBankCoordinate(0)).toEqual({
      slotIndex: 0,
      bankType: 'user',
      bankNumber: 1,
      patchLetter: 'A',
      displayBank: '1A',
    });
    expect(slotIndexToBankCoordinate(35)).toEqual({
      slotIndex: 35,
      bankType: 'user',
      bankNumber: 9,
      patchLetter: 'D',
      displayBank: '9D',
    });
    expect(slotIndexToBankCoordinate(36)).toEqual({
      slotIndex: 36,
      bankType: 'factory',
      bankNumber: 1,
      patchLetter: 'A',
      displayBank: 'F1A',
    });
    expect(slotIndexToBankCoordinate(71)).toEqual({
      slotIndex: 71,
      bankType: 'factory',
      bankNumber: 9,
      patchLetter: 'D',
      displayBank: 'F9D',
    });
    expect(() => slotIndexToBankCoordinate(-1)).toThrow(RangeError);
    expect(() => slotIndexToBankCoordinate(72)).toThrow(RangeError);
  });

  it('parses bank labels back to slot indices and validates factory preset table', () => {
    expect(parseBankLabel('1A')?.slotIndex).toBe(0);
    expect(parseBankLabel('9D')?.slotIndex).toBe(35);
    expect(parseBankLabel('F1A')?.slotIndex).toBe(36);
    expect(parseBankLabel('f9d')?.slotIndex).toBe(71);
    expect(parseBankLabel('10A')).toBeNull();
    expect(MG300_FACTORY_PRESETS).toHaveLength(36);
  });

  it('validates Zod schemas for API requests and tri-state controller state', () => {
    expect(SelectPresetRequestSchema.safeParse({ presetId: '1A' }).success).toBe(true);
    expect(SelectPresetRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateVolumeRequestSchema.safeParse({ volume: 80 }).success).toBe(true);
    expect(
      UpdateVolumeRequestSchema.safeParse({ volume: 80, target: 'master_cc64' }).success,
    ).toBe(true);
    expect(
      UpdateVolumeRequestSchema.safeParse({ volume: 80, target: 'patch_cc74' }).success,
    ).toBe(false);
    expect(
      UpdateVolumeRequestSchema.safeParse({ volume: 80, target: 'expression_cc61' })
        .success,
    ).toBe(false);
    expect(UpdateVolumeTargetRequestSchema.safeParse({ target: 'master_cc64' }).success).toBe(
      true,
    );
    expect(UpdateVolumeTargetRequestSchema.safeParse({ target: 'patch_cc74' }).success).toBe(
      false,
    );
    expect(UpdateVolumeRequestSchema.safeParse({ volume: 105 }).success).toBe(false);
    expect(MG300_MIDI_CC.PRESET_SELECT).toBe(0x3c);
    expect(MG300_MIDI_CC.MASTER_VOLUME).toBe(0x40);
    expect(MG300_MIDI_CC.PATCH_LEVEL).toBe(0x4a);

    const sampleState = ControllerStateSchema.safeParse({
      connectionState: 'connected',
      connectedPortName: 'NUX NME-300',
      availablePorts: [],
      syncStatus: 'command_sent_unconfirmed',
      confirmedState: {
        presetId: null,
        slotIndex: null,
        volume: null,
        volumeTarget: null,
        confirmedAt: null,
      },
      lastSentCommand: {
        commandId: 'cmd-1',
        type: 'preset_select',
        presetId: '1A',
        slotIndex: 0,
        midiBytes: [0xb0, 0x3c, 0x00],
        sentAt: new Date().toISOString(),
        confirmedByDevice: false,
      },
      volumeTarget: 'master_cc64',
      presetsDirectory: null,
      presetsDirectoryStatus: 'ok',
      presetCount: 36,
      warnings: [],
      authRequired: false,
      lastError: null,
    });
    expect(sampleState.success).toBe(true);
  });

  it('builds/validates read-only SysEx frames and parses identity, status and preset dumps', () => {
    const idQuery = buildMg300IdentityQuerySysEx();
    const statusQuery = buildMg300GlobalStatusQuerySysEx();
    const presetQuery = buildMg300PresetQuerySysEx(5);
    const allQuery = buildMg300AllPresetsQuerySysEx();

    expect(isSafeReadOnlyMg300SysEx(idQuery)).toBe(true);
    expect(isSafeReadOnlyMg300SysEx(statusQuery)).toBe(true);
    expect(isSafeReadOnlyMg300SysEx(presetQuery)).toBe(true);
    expect(isSafeReadOnlyMg300SysEx(allQuery)).toBe(true);
    // Blocks write subcmds (`0x02`, `0x58`, `0x50`)
    expect(isSafeReadOnlyMg300SysEx([0xf0, 0x00, 0x11, 0x22, 0x66, 0x00, 0x70, 0x02, 0xf7])).toBe(
      false,
    );
    expect(isSafeReadOnlyMg300SysEx([0xf0, 0x00, 0x11, 0x22, 0x66, 0x00, 0x70, 0x58, 0xf7])).toBe(
      false,
    );

    const statusReply = [
      0xf0, 0x00, 0x11, 0x22, 0x66, 0x00, 0x70, 0x18, 0x00, 12, 1, 75, 3, 0, 50, 50, 0xf7,
    ];
    expect(parseMg300SysExMessage(statusReply)).toEqual({
      kind: 'global_status',
      slotIndex: 12,
      pedalBypass: 1,
      masterVolume: 75,
      currentBlock: 3,
      usbRoutingMode: 0,
      usbRecordLevel: 50,
      usbPlaybackLevel: 50,
    });

    const dump = new Array<number>(113).fill(0);
    dump[0] = 0xf0;
    dump[1] = 0x00;
    dump[2] = 0x11;
    dump[3] = 0x22;
    dump[4] = 0x66;
    dump[5] = 0x00;
    dump[6] = 0x70;
    dump[7] = 0x06;
    dump[8] = 3; // 1D
    dump[9 + 0x01] = 1; // COMP on
    dump[9 + 0x03] = 4; // AMP on
    dump[9 + 0x07] = 2; // DLY on
    dump[9 + 0x44] = 3; // name len = 3
    dump[9 + 0x45] = 0x00; // A
    dump[9 + 0x46] = 0x01; // B
    dump[9 + 0x47] = 0x02; // C
    dump[109] = 0x07; // BPM high nibble
    dump[110] = 0x08; // BPM low nibble -> 0x78 = 120
    dump[111] = 66; // patchVolume
    dump[112] = 0xf7;

    const parsedDump = parseMg300SysExMessage(dump);
    expect(parsedDump?.kind).toBe('preset_dump');
    if (parsedDump?.kind === 'preset_dump') {
      expect(parsedDump.slotIndex).toBe(3);
      expect(parsedDump.struct102[100]).toBe(0x78);
      expect(parsedDump.struct102[101]).toBe(66);
      expect(decodeMg300PresetName(parsedDump.struct102)).toBe('ABC');
      const chain = extractMg300SignalChain(parsedDump.struct102);
      expect(chain.compEnabled).toBe(true);
      expect(chain.ampEnabled).toBe(true);
      expect(chain.dlyEnabled).toBe(true);
      expect(chain.rvbEnabled).toBe(false);
    }
  });

  it('decodes real captured 113-byte SysEx dump for slot 3C ("Metallica Kirk H.", 17 chars) without altering unknown bytes', () => {
    // Exact 113-byte SysEx frame captured directly from physical NUX MG-300 slot 10 (3C)
    const realSlot3CDump = [
      240, 0, 17, 34, 102, 0, 112, 6, 10, 0, 0, 5, 16, 0, 1, 0, 0, 0, 16, 2, 2, 81, 20, 0,
      0, 0, 0, 51, 99, 70, 79, 0, 0, 0, 22, 73, 71, 27, 43, 49, 79, 6, 50, 50, 50, 50, 50,
      50, 2, 46, 23, 0, 0, 0, 0, 36, 50, 50, 20, 0, 0, 0, 53, 50, 50, 50, 7, 1, 0, 18, 50,
      50, 0, 0, 0, 0, 2, 17, 12, 30, 45, 26, 37, 37, 34, 28, 26, 62, 10, 34, 43, 36, 62, 7,
      71, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 7, 12, 50, 247,
    ];

    const parsed = parseMg300SysExMessage(realSlot3CDump);
    expect(parsed?.kind).toBe('preset_dump');
    if (parsed?.kind === 'preset_dump') {
      expect(parsed.slotIndex).toBe(10);
      expect(parsed.struct102[MG300_FILE_FORMAT.NAME_LENGTH_OFFSET]).toBe(17);
      expect(decodeMg300PresetName(parsed.struct102)).toBe('Metallica Kirk H.');
      // Byte 0x57 (16) and Patch Level 0x65 (50) preserved untouched
      expect(parsed.struct102[0x57]).toBe(16);
      expect(parsed.struct102[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET]).toBe(50);
    }
  });

  it('classifies User vs Factory presets by metadata/name and filters out placeholders and factory copies', () => {
    const sample = [
      {
        slotIndex: 0,
        bankType: 'user' as const,
        displayBank: '1A',
        name: 'SYSTEM IR',
        origin: 'hardware' as const,
      },
      {
        slotIndex: 10,
        bankType: 'user' as const,
        displayBank: '3C',
        name: 'Metallica Kirk H.',
        origin: 'hardware' as const,
      },
      {
        slotIndex: 15,
        bankType: 'user' as const,
        displayBank: '4D',
        name: 'VT Dist lead',
        origin: 'hardware' as const,
      },
      {
        slotIndex: 16,
        bankType: 'user' as const,
        displayBank: '5A',
        name: 'RG J. Mayer',
        origin: 'hardware' as const,
      },
      {
        slotIndex: 20,
        bankType: 'user' as const,
        displayBank: '6A',
        name: 'User 6A',
        origin: 'placeholder' as const,
      },
      {
        slotIndex: 51,
        bankType: 'factory' as const,
        displayBank: 'F4D',
        name: 'VT Dist lead',
        origin: 'factory' as const,
      },
      {
        slotIndex: 52,
        bankType: 'factory' as const,
        displayBank: 'F5A',
        name: 'RG J. Mayer',
        origin: 'factory' as const,
      },
    ];

    expect(MG300_EXPERIMENTAL_SLOT).toBe(15);
    expect(MG300_EXPERIMENTAL_SLOT_LABEL).toBe('4D');

    expect(isPlaceholderPreset(sample[4]!)).toBe(true);
    expect(isPlaceholderPreset(sample[0]!)).toBe(false);

    // Slot 4D (index 15) stays in 'user' even when it holds a factory name; slot 5A is classified as 'factory'
    expect(classifyPresetCategory(sample[0]!)).toBe('user');
    expect(classifyPresetCategory(sample[1]!)).toBe('user');
    expect(classifyPresetCategory(sample[2]!)).toBe('user');
    expect(classifyPresetCategory(sample[3]!)).toBe('factory');
    expect(classifyPresetCategory(sample[5]!)).toBe('factory');
    expect(classifyPresetCategory(sample[6]!)).toBe('factory');

    // filterVisibleLibraryPresets keeps 4D, removes placeholder (6A) and deduplicates 5A against F5A
    const visible = filterVisibleLibraryPresets(sample);
    expect(visible.map((p) => p.displayBank)).toEqual(['1A', '3C', '4D', 'F4D', 'F5A']);
  });

  it('exposes complete 10-block NUX MG-300 model catalog with dynamic param labels and User IR id 100', () => {
    expect(MG300_BLOCK_CATALOG).toHaveLength(10);
    expect(MG300_BLOCK_CATALOG.map((b) => b.code)).toEqual([
      'COMP',
      'EFX',
      'AMP',
      'EQ',
      'NR',
      'MOD',
      'DLY',
      'RVB',
      'CAB',
      'MIC',
    ]);

    expect(getMg300ModelSpec('EFX', 12)?.name).toBe('Pitch Bender');
    expect(getMg300ModelSpec('DLY', 2)?.name).toBe('Digi Delay');
    expect(getMg300ModelSpec('AMP', 27)?.name).toBe('MLD');
    expect(getMg300ModelSpec('AMP', 27)?.params.map((p) => p.label)).toEqual([
      'Gain',
      'M.Freq',
      'Level',
      'Bass',
      'Middle',
      'Treble',
    ]);
    expect(getMg300ModelSpec('AMP', 28)).toBeUndefined();
    expect(getMg300ModelSpec('AMP', 18)?.params.find((p) => p.cc === 24)?.controlType).toBe('toggle');
    expect(getMg300ModelSpec('MOD', 13)?.params.find((p) => p.cc === 42)?.options).toHaveLength(12);
    expect(getMg300ModelSpec('RVB', 2)?.params.map((p) => p.label)).toEqual([
      'Mix',
      'Decay',
      'Pre.D',
      'Liveliness',
    ]);

    expect(isValidMg300BlockModel(9, 0)).toBe(true);
    expect(isValidMg300BlockModel(9, 30)).toBe(true);
    expect(isValidMg300BlockModel(9, MG300_USER_IR_CAB_ID)).toBe(true);
    expect(isValidMg300BlockModel(9, 31)).toBe(false);
    expect(isValidMg300BlockModel(3, 28)).toBe(false);

    expect(isValidMg300ExperimentalCcValue(3, 27)).toBe(true);
    expect(isValidMg300ExperimentalCcValue(3, 28)).toBe(false);
    expect(isValidMg300ExperimentalCcValue(9, 100)).toBe(true);
    expect(isValidMg300ExperimentalCcValue(9, 55)).toBe(false);

    expect(getMg300ModelDefaultParams(4, 1)).toEqual([50, 50, 50, 50, 50, 50]);
  });

  it('creates clean blank drafts, sanitizes MG-300 names, and restricts 0x0E writes strictly to User slots 0..35', () => {
    expect(sanitizeMg300PresetName('Solo Limpô @1!')).toBe('Solo Limpo @1!');
    expect(sanitizeMg300PresetName('Very Long Preset Name Exceeding 18', 'Fallback')).toBe(
      'Very Long Preset N',
    );
    expect(sanitizeMg300PresetName('   ', 'Default Tone')).toBe('Default Tone');

    const blank = createBlankMg300Struct102({ name: 'Stage Clean', bpm: 128, patchVolume: 65 });
    expect(blank).toHaveLength(MG300_FILE_FORMAT.PRESET_STRUCT_SIZE);
    expect(decodeMg300PresetName(blank)).toBe('Stage Clean');
    expect(blank[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET]).toBe(128);
    expect(blank[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET]).toBe(65);
    expect(blank[0x57]).toBe(0x10);
    expect(decodeMg300UserIrName(blank)).toBeNull();

    const dirtyStruct = Uint8Array.from(blank);
    dirtyStruct[0x2f] = 0x85; // bit-7 set inside MOD params -> masked to low nibble 0x05
    dirtyStruct[0x43] = 9;
    dirtyStruct[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = 77;
    const sanitized = sanitizeStruct102ForSysEx(dirtyStruct);
    expect(sanitized[0x2f]).toBe(0x05);
    expect(sanitized[0x43]).toBe(2);
    expect(sanitized[MG300_FILE_FORMAT.IR_VOLUME_OFFSET]).toBe(40);
    expect(compareStruct102Readback(dirtyStruct, sanitized)).toEqual([0x43, 0x62]);
    const headerChanged = Uint8Array.from(blank);
    headerChanged[0x19] = 99;
    expect(compareStruct102Readback(blank, headerChanged, { ignoreBlockHeaderOffsets: true })).toEqual(
      [],
    );

    // User slots 0..35 allowed; Factory slots 36..71 blocked
    expect(isValidMg300UserSlot(0)).toBe(true);
    expect(isValidMg300UserSlot(35)).toBe(true);
    expect(isValidMg300UserSlot(36)).toBe(false);
    expect(isValidMg300UserSlot(71)).toBe(false);

    const frame0 = buildMg300PresetWriteSysEx(blank, 0);
    const frame35 = buildMg300PresetWriteSysEx(blank, 35);
    expect(isExperimentalPresetWriteSysEx(frame0)).toBe(true);
    expect(isExperimentalPresetWriteSysEx(frame35)).toBe(true);

    // Mutate slot byte to Factory slot 36 -> guard rejects
    const tamperedFactoryFrame = [...frame0];
    tamperedFactoryFrame[8] = 36;
    expect(isExperimentalPresetWriteSysEx(tamperedFactoryFrame)).toBe(false);

    // Reject negative and non-integer payload bytes in 7-bit SysEx guard
    const negativeByteFrame = [...frame0];
    negativeByteFrame[10] = -1;
    expect(isExperimentalPresetWriteSysEx(negativeByteFrame)).toBe(false);
    const floatByteFrame = [...frame0];
    floatByteFrame[10] = 12.5;
    expect(isExperimentalPresetWriteSysEx(floatByteFrame)).toBe(false);

    expect(() => buildMg300PresetWriteSysEx(blank, 36)).toThrow();
    expect(() => buildMg300PresetWriteSysEx(blank, 71)).toThrow();
    expect(() => buildMg300PresetWriteSysEx(blank, -1)).toThrow();

    const parsedSchema = ExperimentalEditStateSchema.parse({
      slot: 15,
      loaded: true,
      busy: false,
      dirty: false,
      sourceMode: 'draft',
      sourceFileName: null,
      presetName: 'Stage Clean',
      bpm: 128,
      timeFlag: 0,
      ampParams: [50, 0, 50, 50, 50, 50],
      blocksEnabled: [false, false, true, false, true, false, false, false],
      blockModels: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1, '6': 0, '7': 0, '8': 0, '9': 1, '10': 2 },
      blockParams: {
        '1': [50, 50, 0, 0, 0, 0],
        '2': [50, 50, 50, 50, 0, 0],
        '3': [50, 0, 50, 50, 50, 50],
        '4': [50, 50, 50, 50, 50, 50],
        '5': [40, 30, 0, 0, 0, 0],
        '6': [50, 50, 50, 0, 0, 0],
        '7': [50, 35, 35, 0, 0, 0],
        '8': [35, 50, 50, 0, 0, 0],
      },
      cabEnabled: true,
      cabModel: 1,
      micModel: 2,
      irCut: 0,
      irVolume: 20,
      patchVolume: 65,
      hasUserIr: false,
      userIrName: null,
      userIrWarning: null,
      lastSave: null,
    });
    expect(parsedSchema.bpm).toBe(128);
  });

  it('detects forbidden slot/preset mentions in AI prompts without false positives on 3D audio terms', () => {
    expect(containsForbiddenSlotMention('Crie um timbre no slot 4C')).toBe('slot 4C');
    expect(containsForbiddenSlotMention('Use o preset 5C como base')).toBe('preset 5C');
    expect(containsForbiddenSlotMention('Coloca em 4C com delay')).toBe('4C');
    expect(containsForbiddenSlotMention('Copia do F1A com mais ganho')).toBe('F1A');
    expect(containsForbiddenSlotMention('Gravar no slot 10 por favor')).toBe('slot 10');
    expect(containsForbiddenSlotMention('Ajustar no 3D com mais reverb')).toBe('3D');

    expect(containsForbiddenSlotMention('Quero um timbre com efeito 3D e chorus aberto')).toBeNull();
    expect(containsForbiddenSlotMention('Timbre espacial com som 3D e reverb hall')).toBeNull();
    expect(containsForbiddenSlotMention('Som em 3D estilo ambient worship')).toBeNull();
    expect(containsForbiddenSlotMention('Mesa Mark 2C+ lead com delay estereo')).toBeNull();
    expect(containsForbiddenSlotMention('Clean estilo John Mayer com spring reverb')).toBeNull();
  });

  it('validates AI gear, tone apply, and gear_updated WebSocket contracts', () => {
    const validGearReq = UpdateAiGearRequestSchema.parse({
      guitarModel: '  Fender Stratocaster HSS  ',
    });
    expect(validGearReq).toEqual({
      guitarModel: 'Fender Stratocaster HSS',
      outputTarget: '',
    });
    expect(UpdateAiGearRequestSchema.safeParse({ guitarModel: 'A' }).success).toBe(false);

    const sampleGear = AiGearConfigSchema.parse({
      guitarModel: 'Fender Stratocaster HSS',
      outputTarget: 'FRFR Headrush 108',
      pickupSummary: 'HSS (ponte humbucker, meio e braco single-coil)',
      recommendations: ['Use IR/CAB ativo para saida FRFR.'],
      updatedAt: new Date().toISOString(),
    });
    expect(AiGearStateResponseSchema.parse({ gear: sampleGear }).gear?.guitarModel).toBe(
      'Fender Stratocaster HSS',
    );
    expect(AiGearStateResponseSchema.parse({ gear: null }).gear).toBeNull();

    expect(
      AiToneApplyRequestSchema.safeParse({ slotIndex: 0, prompt: 'Blues quente' }).success,
    ).toBe(true);
    expect(
      AiToneApplyRequestSchema.safeParse({ slotIndex: 35, prompt: 'Metal moderno' }).success,
    ).toBe(true);
    expect(
      AiToneApplyRequestSchema.safeParse({ slotIndex: 36, prompt: 'Nao pode factory' }).success,
    ).toBe(false);
    expect(
      AiToneApplyRequestSchema.safeParse({ slotIndex: 5, prompt: 'ok' }).success,
    ).toBe(false);

    const wsMsg = WsServerMessageSchema.parse({
      type: 'gear_updated',
      gear: sampleGear,
      timestamp: new Date().toISOString(),
    });
    expect(wsMsg.type).toBe('gear_updated');

    const applyResp = AiToneApplyResponseSchema.parse({
      slotIndex: 15,
      displayBank: '4D',
      intent: 'create_new',
      presetName: 'SRV Warm Blues',
      bpm: 112,
      timeFlag: 0,
      summary: 'Timbre blues com Twin Rvb e T Screamer.',
      tips: ['Use o captador do braco para base limpa.'],
      appliedBlocks: [
        {
          blockCode: 'AMP',
          enabled: true,
          modelName: 'Twin Rvb',
          params: [{ label: 'Gain', value: 42 }],
          changed: true,
        },
      ],
      calibration: {
        source: 'hardware_user',
        sampleCount: 4,
        avgPatchVolume: 50,
        avgIrVolume: 20,
        avgAmpLevel: 70,
        appliedPatchVolume: 50,
        appliedIrVolume: 20,
        appliedAmpLevel: 68,
      },
      saveResult: {
        targetSlot: 15,
        displayBank: '4D',
        ackReceived: true,
        verified: true,
        mismatchedOffsets: [],
        backupPath: 'slot-15-backup.json',
        savedAt: new Date().toISOString(),
      },
      experimentalState: {
        slot: 15,
        loaded: true,
        busy: false,
        dirty: false,
        sourceMode: 'hardware',
        sourceFileName: null,
        presetName: 'SRV Warm Blues',
        bpm: 112,
        timeFlag: 0,
        ampParams: [42, 1, 68, 55, 58, 60],
        blocksEnabled: [false, true, true, false, true, false, false, true],
        blockModels: { '1': 0, '2': 5, '3': 5, '4': 0, '5': 1, '6': 0, '7': 0, '8': 4, '9': 5, '10': 2 },
        blockParams: {
          '1': [50, 50, 0, 0, 0, 0],
          '2': [55, 58, 45, 0, 0, 0],
          '3': [42, 1, 68, 55, 58, 60],
          '4': [50, 50, 50, 50, 50, 50],
          '5': [40, 30, 0, 0, 0, 0],
          '6': [50, 50, 50, 0, 0, 0],
          '7': [50, 35, 35, 0, 0, 0],
          '8': [32, 42, 0, 0, 0, 0],
        },
        cabEnabled: true,
        cabModel: 5,
        micModel: 2,
        irCut: 0,
        irVolume: 20,
        patchVolume: 50,
        hasUserIr: false,
        userIrName: null,
        userIrWarning: null,
        lastSave: null,
      },
    });
    expect(applyResp.displayBank).toBe('4D');
  });

  it('ignores inactive/bypassed and undeclared param slots in compareStruct102Readback when enabled while keeping active fields strict', () => {
    const expected = createBlankMg300Struct102({
      name: 'Solo Readback',
      bpm: 124,
      timeFlag: 1,
      patchVolume: 56,
      irVolume: 20,
      irCut: 1,
    });
    // COMP=1 (p0..p1 declared, p2..p5 undeclared), AMP=2 (p1 undeclared), MOD=0 (bypass), DLY=4 (p0..p2 declared, p3..p5 undeclared)
    expected[0x01] = 1;
    expected.set([55, 45, 0, 0, 0, 0], 0x0c);
    expected[0x03] = 2;
    expected.set([48, 0, 66, 52, 54, 60], 0x1a);
    expected[0x06] = 0; // MOD bypassed
    expected.set([50, 50, 50, 0, 0, 0], 0x2f);
    expected[0x07] = 4; // Tape Echo
    expected.set([42, 20, 22, 0, 0, 0], 0x36);

    const readbackWithRomNoise = Uint8Array.from(expected);
    readbackWithRomNoise[48] = 77; // 0x30 = MOD param 1 (block is bypassed)
    readbackWithRomNoise[0x0e] = 9; // COMP undeclared slot p2
    readbackWithRomNoise[0x1b] = 1; // AMP 2 Deluxe Rvb undeclared slot p1
    readbackWithRomNoise[0x39] = 7; // DLY Tape Echo undeclared slot p3 (STM32 ROM metadata)
    readbackWithRomNoise[0x3a] = 1; // DLY Tape Echo undeclared slot p4
    readbackWithRomNoise[0x3b] = 2; // DLY Tape Echo undeclared slot p5
    readbackWithRomNoise[0x59] = 12; // Unused User IR name byte while CAB !== 100

    // Backwards compatibility: default strict mode still flags all differing offsets
    expect(compareStruct102Readback(expected, readbackWithRomNoise)).toEqual([
      0x0e, 0x1b, 48, 0x39, 0x3a, 0x3b, 0x59,
    ]);
    // With ignoreInactiveAndUndeclaredParams: true, all benign STM32 ROM bytes are ignored
    expect(
      compareStruct102Readback(expected, readbackWithRomNoise, {
        ignoreInactiveAndUndeclaredParams: true,
      }),
    ).toEqual([]);

    // Also verify AMP 4 Tweedy (p3..p5 undeclared) and AMP 8 Class A15 (p4 Middle undeclared)
    const tweedyExp = createBlankMg300Struct102({ name: 'Tweedy Test' });
    tweedyExp[0x03] = 4;
    tweedyExp.set([55, 60, 68, 0, 0, 0], 0x1a);
    const tweedyAct = Uint8Array.from(tweedyExp);
    tweedyAct[0x1d] = 50;
    tweedyAct[0x1e] = 50;
    tweedyAct[0x1f] = 50;
    expect(
      compareStruct102Readback(tweedyExp, tweedyAct, { ignoreInactiveAndUndeclaredParams: true }),
    ).toEqual([]);

    const ac15Exp = createBlankMg300Struct102({ name: 'AC15 Test' });
    ac15Exp[0x03] = 8;
    ac15Exp.set([45, 30, 68, 52, 0, 64], 0x1a);
    const ac15Act = Uint8Array.from(ac15Exp);
    ac15Act[0x1e] = 50; // Middle is undeclared on Class A15
    expect(
      compareStruct102Readback(ac15Exp, ac15Act, { ignoreInactiveAndUndeclaredParams: true }),
    ).toEqual([]);

    // Active block/declared params/metadata divergences MUST still be detected
    const realDrift = Uint8Array.from(readbackWithRomNoise);
    realDrift[0x06] = 2; // Bypassed MOD model byte drifted from 0 -> 2
    realDrift[0x37] = 31; // Declared DLY F.Back drifted
    realDrift[0x43] = 2; // irCut drifted
    realDrift[0x45] = 0x05; // Preset name char drifted
    realDrift[0x57] = 0x04; // User IR marker byte drifted (always strict)
    realDrift[MG300_FILE_FORMAT.IR_VOLUME_OFFSET] = 24;
    realDrift[MG300_FILE_FORMAT.TIME_FLAG_OFFSET] = 0;
    realDrift[MG300_FILE_FORMAT.BPM_ENCODED_OFFSET] = 130;
    realDrift[MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET] = 60;

    expect(
      compareStruct102Readback(expected, realDrift, { ignoreInactiveAndUndeclaredParams: true }),
    ).toEqual([
      0x06,
      0x37,
      0x43,
      0x45,
      0x57,
      MG300_FILE_FORMAT.IR_VOLUME_OFFSET,
      MG300_FILE_FORMAT.TIME_FLAG_OFFSET,
      MG300_FILE_FORMAT.BPM_ENCODED_OFFSET,
      MG300_FILE_FORMAT.PATCH_LEVEL_OFFSET,
    ]);

    // When CAB=100 (User IR), bytes 0x57..0x61 remain strictly compared
    const userIrExp = createBlankMg300Struct102({ name: 'User IR Test' });
    userIrExp[0x09] = MG300_USER_IR_CAB_ID;
    userIrExp[0x57] = 3;
    userIrExp.set([0, 1, 2], 0x58);
    const userIrAct = Uint8Array.from(userIrExp);
    userIrAct[0x59] = 9;
    expect(
      compareStruct102Readback(userIrExp, userIrAct, { ignoreInactiveAndUndeclaredParams: true }),
    ).toEqual([0x59]);
  });
});
