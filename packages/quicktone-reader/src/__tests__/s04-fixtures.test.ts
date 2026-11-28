import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MG300_USER_IR_CAB_ID, encodeMg300PresetName } from '@quicktone/shared';
import {
  QuickToneDiscoveryService,
  QuickTonePresetParseError,
  buildNuxAllPresetsBinary,
  buildNuxPresetBinary,
  parseNuxPresetBuffer,
  parseNuxPresetWithStruct102,
} from '../index.js';

describe('S04 — QuickTone binary fixtures (V1/V2, AllPreset 36-slot, User IR & corruption resilience)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 's04-qt-fixtures-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('1. Parses V1 (8380 B) and V2 (8381 B) presets preserving User IR metadata and Patch Volume', () => {
    const v1Buf = buildNuxPresetBinary({
      name: 'S04 Studio V1',
      slotIndex: 0,
      formatVersion: 'v1',
      patchVolume: 64,
      irVolume: 28,
    });
    expect(v1Buf.byteLength).toBe(8380);
    // Patch CAB model + User IR name at V1 struct offset (29-byte header + 12-byte metadata = 41)
    const structOffset = 41;
    v1Buf[structOffset + 0x09] = MG300_USER_IR_CAB_ID;
    const irEncoded = encodeMg300PresetName('Mesa4x12');
    v1Buf[structOffset + 0x57] = Math.min(10, irEncoded.length);
    for (let i = 0; i < 10; i += 1) {
      v1Buf[structOffset + 0x58 + i] = irEncoded.bytes[i] ?? 0;
    }

    const parsedV1 = parseNuxPresetWithStruct102(v1Buf, { sourceFile: 'v1.nuxpreset' });
    expect(parsedV1.entries).toHaveLength(1);
    expect(parsedV1.entries[0]?.preset.name).toBe('S04 Studio V1');
    expect(parsedV1.entries[0]?.usesUserIr).toBe(true);
    expect(parsedV1.entries[0]?.userIrName).toBe('Mesa4x12');

    const v2Buf = buildNuxPresetBinary({
      name: 'S04 Stage V2',
      slotIndex: 5,
      formatVersion: 'v2',
      patchVolume: 77,
    });
    expect(v2Buf.byteLength).toBe(8381);
    const parsedV2 = parseNuxPresetBuffer(v2Buf, 'v2.nuxpreset');
    expect(parsedV2.presets).toHaveLength(1);
    expect(parsedV2.presets[0]?.name).toBe('S04 Stage V2');
    expect(parsedV2.presets[0]?.slotIndex).toBe(5);
    expect(parsedV2.presets[0]?.patchVolume).toBe(77);
  });

  it('2. Parses full 36-slot MG300AllPreset.nuxpreset bundles in V1 and V2 formats without corruption', () => {
    for (const formatVersion of ['v1', 'v2'] as const) {
      const slots = Array.from({ length: 36 }, (_, slotIndex) => ({
        slotIndex,
        name: `Slot-${slotIndex + 1}`,
        patchVolume: 40 + (slotIndex % 40),
      }));
      const bundle = buildNuxAllPresetsBinary(slots, formatVersion);
      const result = parseNuxPresetBuffer(bundle, `MG300AllPreset-${formatVersion}.nuxpreset`);
      expect(result.warnings).toEqual([]);
      expect(result.presets).toHaveLength(36);
      expect(result.presets[0]?.name).toBe('Slot-1');
      expect(result.presets[35]?.slotIndex).toBe(35);
      expect(result.presets[35]?.name).toBe('Slot-36');
    }
  });

  it('3. Discovers mixed valid/corrupt fixtures without crashing and updates cleanly on live reload', async () => {
    const validOne = buildNuxPresetBinary({
      name: 'AlphaClean',
      slotIndex: 0,
      patchVolume: 55,
      formatVersion: 'v1',
    });
    const badMagic = Buffer.from('NOT_A_NUX_FILE_0123456789abcdef', 'utf8');
    const truncated = validOne.subarray(0, 64);

    await fs.promises.writeFile(path.join(tempDir, '01_AlphaClean.nuxpreset'), validOne);
    await fs.promises.writeFile(path.join(tempDir, '02_Empty.nuxpreset'), new Uint8Array(0));
    await fs.promises.writeFile(path.join(tempDir, '03_WrongMagic.nuxpreset'), badMagic);
    await fs.promises.writeFile(path.join(tempDir, '04_Truncated.nuxpreset'), truncated);
    await fs.promises.writeFile(path.join(tempDir, '05_BadJson.json'), '{not:json', 'utf8');

    expect(() => parseNuxPresetBuffer(badMagic)).toThrow(QuickTonePresetParseError);

    const discovery = new QuickToneDiscoveryService({
      directoryPath: tempDir,
      includeFactoryPresets: true,
    });
    const firstScan = await discovery.discover();
    expect(firstScan.directoryStatus).toBe('ok');
    expect(firstScan.presets.filter((p) => p.bankType === 'user')).toHaveLength(1);
    expect(firstScan.presets.filter((p) => p.bankType === 'factory')).toHaveLength(36);
    expect(firstScan.warnings.length).toBeGreaterThanOrEqual(4);

    // Add a second valid preset dynamically and reload
    await fs.promises.writeFile(
      path.join(tempDir, '06_LeadLead.nuxpreset'),
      buildNuxPresetBinary({ name: 'LeadLead', slotIndex: 1, patchVolume: 72, formatVersion: 'v2' }),
    );
    const reloaded = await discovery.reload();
    const userPresets = reloaded.presets.filter((p) => p.bankType === 'user');
    expect(userPresets.map((p) => p.name)).toEqual(['AlphaClean', 'LeadLead']);
  });
});
