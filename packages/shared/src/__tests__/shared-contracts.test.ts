import { describe, it, expect } from 'vitest';
import {
  MG300_CHAR_TABLE,
  MG300_FACTORY_PRESETS,
  MG300_FILE_FORMAT,
  MG300_MIDI_CC,
  decodeMg300PresetName,
  encodeMg300PresetName,
  parseBankLabel,
  slotIndexToBankCoordinate,
  SelectPresetRequestSchema,
  UpdateVolumeRequestSchema,
  ControllerStateSchema,
  buildMg300IdentityQuerySysEx,
  buildMg300GlobalStatusQuerySysEx,
  buildMg300PresetQuerySysEx,
  buildMg300AllPresetsQuerySysEx,
  isSafeReadOnlyMg300SysEx,
  parseMg300SysExMessage,
  extractMg300SignalChain,
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
});
