import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AiToneApplyResponse,
  MG300_SYSEX_PREFIX,
  buildMg300PresetWriteSysEx,
  isExperimentalPresetWriteSysEx,
  sanitizeStruct102ForSysEx,
} from '@quicktone/shared';
import { MidiDiagnosticsLogger, MockMidiAdapter } from '@quicktone/midi';
import {
  buildMg300Struct102,
  buildPresetFromStruct102,
} from '@quicktone/reader';
import { createBackendApp, type QuickToneBackendApp } from '../app.js';
import {
  DELAY_MODEL_LAYOUTS,
  getDelayModelProfileLimits,
  resolveAmbiencePolicy,
} from '../ai/ambience-policy.js';
import type { GeminiClientLike, GeminiGenerateJsonOptions } from '../ai/gemini-client.js';
import { buildAndCalibrateStruct102, resolveCalibrationBaseline } from '../ai/tone-calibrator.js';
import { AiToneObservabilityRecorder } from '../ai/tone-observability.js';

class FakePedalAdapter extends MockMidiAdapter {
  public readonly flashSlots = new Map<number, Uint8Array>();

  public constructor() {
    super();
    this.flashSlots.set(4, buildMg300Struct102({ name: 'User 2A', patchVolume: 50, irVolume: 20 }));
  }

  public getSlotStruct(slotIndex: number): Uint8Array {
    return this.flashSlots.get(slotIndex) ?? buildMg300Struct102({ name: `Slot ${slotIndex}` });
  }

  public override async sendBytes(bytes: number[]): Promise<void> {
    await super.sendBytes(bytes);
    if (bytes[0] !== 0xf0) return;

    if (bytes[6] === 0x00) {
      const reply = [
        ...MG300_SYSEX_PREFIX,
        0x10,
        ...Buffer.from('V04_20230101'.padEnd(32, '\0')),
        ...Buffer.from('NUX_MG1X'),
        0xf7,
      ];
      queueMicrotask(() => this.simulateHardwareIncoming(reply));
    } else if (bytes[7] === 0x07) {
      const slotIndex = bytes[8] ?? 0;
      const s = this.getSlotStruct(slotIndex);
      queueMicrotask(() =>
        this.simulateHardwareIncoming([
          ...MG300_SYSEX_PREFIX,
          0x70,
          0x06,
          slotIndex,
          ...s.subarray(0, 100),
          s[100]! >> 4,
          s[100]! & 0x0f,
          s[101]!,
          0xf7,
        ]),
      );
    } else if (bytes[7] === 0x0e) {
      const slotIndex = bytes[8]!;
      const out = new Uint8Array(102);
      out.set(bytes.slice(9, 109));
      out[100] = ((bytes[109]! & 0x0f) << 4) | (bytes[110]! & 0x0f);
      out[101] = bytes[111]!;
      this.flashSlots.set(slotIndex, out);
      queueMicrotask(() =>
        this.simulateHardwareIncoming([...MG300_SYSEX_PREFIX, 0x70, 0x0e, slotIndex, 0xf7]),
      );
    }
  }
}

function assertValidMg300BinaryCompatibility(struct102: Uint8Array, expectedSlot: number): void {
  expect(struct102.length).toBe(102);
  const reSanitized = sanitizeStruct102ForSysEx(struct102);
  expect(Array.from(reSanitized)).toEqual(Array.from(struct102));

  const sysEx = buildMg300PresetWriteSysEx(struct102, expectedSlot);
  expect(isExperimentalPresetWriteSysEx(sysEx)).toBe(true);

  const preset = buildPresetFromStruct102(struct102, expectedSlot);
  expect(preset.slotIndex).toBe(expectedSlot);
  expect(preset.signalChain?.dlyEnabled).toBe((struct102[0x07] ?? 0) > 0);
  expect(preset.signalChain?.rvbEnabled).toBe((struct102[0x08] ?? 0) > 0);
}

describe('Structural Delay & Ambience Policy — MG Control AI', () => {
  let tempDir: string;
  let backupDir: string;
  let gearPath: string;
  let calibrationDir: string;
  let logFilePath: string;
  let adapter: FakePedalAdapter;
  let app: QuickToneBackendApp | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-ambience-policy-'));
    backupDir = path.join(tempDir, 'backups');
    gearPath = path.join(tempDir, 'data', 'user-gear.json');
    calibrationDir = path.join(tempDir, 'nuxpresets');
    logFilePath = path.join(tempDir, 'logs', 'midi-diagnostics.log');
    adapter = new FakePedalAdapter();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mandatoryScenarios: Array<{
    id: number;
    title: string;
    prompt: string;
    aiPayload: Record<string, unknown>;
    expectedProfile: 'NONE' | 'RHYTHM' | 'LEAD' | 'AMBIENT' | 'SLAPBACK';
    expectedDelayDecision: 'included' | 'excluded';
    expectedDlyModel: number;
    verify: (res: AiToneApplyResponse, struct102: Uint8Array) => void;
  }> = [
    {
      id: 1,
      title: '1. Metallica — riffs pesados',
      prompt: 'Metallica riffs pesados estilo Master of Puppets',
      aiPayload: {
        intent: 0,
        name: 'Metallica Riff',
        mp: 'heavy_rhythm',
        dp: 'RHYTHM',
        b: {
          '2': { m: 5, p: [70, 60, 15] },
          '3': { m: 16, p: [76, 52, 68, 62, 38, 64] },
          '7': { m: 4, p: [50, 45, 40] }, // AI tried to sneak delay into heavy rhythm
          '8': { m: 1, p: [42, 50, 58] },
          '9': { m: 16 },
          '10': { m: 2 },
        },
      },
      expectedProfile: 'RHYTHM',
      expectedDelayDecision: 'excluded',
      expectedDlyModel: 0,
      verify: (res, struct102) => {
        expect(struct102[0x03]).toBe(16);
        expect(struct102[0x09]).toBe(16);
        expect(struct102[0x3d]).toBeLessThanOrEqual(14); // Tight Room Mix <= 14
        expect(struct102[0x3e]).toBe(50); // Room Tone preserved
        expect(struct102[0x3f]).toBeLessThanOrEqual(28); // Short decay
        expect(res.diagnostics?.corrections.some((c) => c.rule === 'unjustified_delay_removed')).toBe(
          true,
        );
      },
    },
    {
      id: 2,
      title: '2. Metallica — solos',
      prompt: 'Solo do Metallica estilo Kirk Hammett com sustain',
      aiPayload: {
        intent: 0,
        name: 'Kirk Solo',
        mp: 'lead_solo',
        dp: 'LEAD',
        b: {
          '2': { m: 5, p: [72, 58, 20] },
          '3': { m: 16, p: [74, 55, 68, 56, 52, 62] },
          '7': { m: 2, p: [68, 48, 45] }, // Excessive Digi Delay
          '8': { m: 2, p: [45, 70, 10, 75] }, // Excessive Hall
          '9': { m: 16 },
          '10': { m: 2 },
        },
      },
      expectedProfile: 'LEAD',
      expectedDelayDecision: 'included',
      expectedDlyModel: 2,
      verify: (res, struct102) => {
        expect(struct102[0x36]).toBeLessThanOrEqual(58);
        expect(struct102[0x37]).toBeLessThanOrEqual(20); // Digi F.Back <= 20
        expect(struct102[0x38]).toBeLessThanOrEqual(22); // Digi Level <= 22
        expect(struct102[0x3d]).toBeLessThanOrEqual(22); // Hall Mix <= 22
        expect(struct102[0x3e]).toBeLessThanOrEqual(42); // Hall Decay <= 42
        expect(struct102[0x3f]).toBeGreaterThanOrEqual(20); // Hall Pre.D >= 20
        expect(struct102[0x40]).toBeLessThanOrEqual(45); // Hall Liveliness <= 45
        expect(struct102[0x38]! + struct102[0x3d]!).toBeLessThanOrEqual(42);
        expect(res.diagnostics?.finalAmbience.gainStage).toBe('high_gain');
      },
    },
    {
      id: 3,
      title: '3. Pink Floyd — solos melódicos com delay',
      prompt: 'Solo melódico estilo Pink Floyd Comfortably Numb com delay',
      aiPayload: {
        intent: 0,
        name: 'Gilmour Lead',
        mp: 'melodic_lead',
        dp: 'LEAD',
        b: {
          '1': { m: 1, p: [55, 58] },
          '2': { m: 11, p: [60, 52, 54] }, // Muf Dist
          '3': { m: 6, p: [48, 52, 68, 54, 58, 56] }, // Hiwire
          '7': { m: 4, p: [72, 62, 54] }, // Excessive Tape Echo
          '8': { m: 2, p: [52, 76, 12, 68] }, // Excessive Hall
          '9': { m: 6 },
          '10': { m: 3 },
        },
      },
      expectedProfile: 'LEAD',
      expectedDelayDecision: 'included',
      expectedDlyModel: 4,
      verify: (_res, struct102) => {
        expect(struct102[0x03]).toBe(6);
        expect(struct102[0x36]).toBeLessThanOrEqual(64); // Time controlled
        expect(struct102[0x37]).toBeLessThanOrEqual(34); // Tape Echo F.Back melodic ceiling
        expect(struct102[0x38]).toBeLessThanOrEqual(30); // Tape Echo Level melodic ceiling
        expect(struct102[0x3d]).toBeLessThanOrEqual(24); // Hall Mix controlled
        expect(struct102[0x38]! + struct102[0x3d]!).toBeLessThanOrEqual(52);
      },
    },
    {
      id: 4,
      title: '4. Pink Floyd — ambiência atmosférica',
      prompt: 'Pink Floyd ambiência atmosférica espacial estilo Shine On',
      aiPayload: {
        intent: 0,
        name: 'Shine Atmos',
        mp: 'ambient',
        dp: 'AMBIENT',
        b: {
          '3': { m: 6, p: [34, 50, 68, 52, 54, 56] },
          '6': { m: 2, p: [45, 38] }, // Classic Chorus
          '7': { m: 2, p: [58, 54, 48] }, // Digi Delay
          '8': { m: 2, p: [52, 74, 28, 55] }, // Hall
          '9': { m: 6 },
          '10': { m: 3 },
        },
      },
      expectedProfile: 'AMBIENT',
      expectedDelayDecision: 'included',
      expectedDlyModel: 2,
      verify: (res, struct102) => {
        expect(struct102[0x06]).toBe(2);
        expect(struct102[0x37]).toBeGreaterThanOrEqual(24); // Ambient allows expressive repeats
        expect(struct102[0x37]).toBeLessThanOrEqual(68);
        expect(struct102[0x38]).toBeGreaterThanOrEqual(20);
        expect(struct102[0x3d]).toBeGreaterThanOrEqual(30);
        expect(struct102[0x38]! + struct102[0x3d]!).toBeLessThanOrEqual(110); // 115 - 5 MOD penalty
        expect(res.diagnostics?.finalAmbience.modEnabled).toBe(true);
      },
    },
    {
      id: 5,
      title: '5. Rock clássico — solo com repetição moderada',
      prompt: 'Solo de rock clássico com repetição moderada estilo Slash',
      aiPayload: {
        intent: 0,
        name: 'Classic Solo',
        mp: 'lead_solo',
        dp: 'LEAD',
        b: {
          '3': { m: 12, p: [66, 52, 68, 58, 60, 58] },
          '7': { m: 4, p: [48, 44, 40] },
          '8': { m: 3, p: [42, 65] }, // Plate
          '9': { m: 10 },
          '10': { m: 2 },
        },
      },
      expectedProfile: 'LEAD',
      expectedDelayDecision: 'included',
      expectedDlyModel: 4,
      verify: (_res, struct102) => {
        expect(struct102[0x36]).toBe(48);
        expect(struct102[0x37]).toBeLessThanOrEqual(22);
        expect(struct102[0x38]).toBeLessThanOrEqual(24);
        expect(struct102[0x3d]).toBeLessThanOrEqual(22);
        expect(struct102[0x3e]).toBeLessThanOrEqual(42);
      },
    },
    {
      id: 6,
      title: '6. Slapback para rockabilly',
      prompt: 'Timbre rockabilly com slapback vintage estilo Brian Setzer',
      aiPayload: {
        intent: 0,
        name: 'Rockabilly Slap',
        mp: 'slapback',
        dp: 'SLAPBACK',
        tf: 1, // AI mistakenly enabled BPM sync
        b: {
          '3': { m: 2, p: [44, 68, 52, 48, 60] }, // Deluxe Rvb
          '7': { m: 4, p: [65, 45, 50] }, // Too long & too many repeats for slapback
          '8': { m: 4, p: [38, 55] }, // Spring
          '9': { m: 5 },
          '10': { m: 2 },
        },
      },
      expectedProfile: 'SLAPBACK',
      expectedDelayDecision: 'included',
      expectedDlyModel: 4,
      verify: (res, struct102) => {
        expect(struct102[0x63]).toBe(0); // timeFlag forced to 0 (ms)
        expect(struct102[0x36]).toBeGreaterThanOrEqual(8);
        expect(struct102[0x36]).toBeLessThanOrEqual(24); // Short slapback time
        expect(struct102[0x37]).toBeLessThanOrEqual(12); // Minimal feedback (single slap)
        expect(struct102[0x38]).toBeGreaterThanOrEqual(18);
        expect(struct102[0x38]).toBeLessThanOrEqual(34);
        expect(struct102[0x3d]).toBeLessThanOrEqual(18); // Short spring mix
        expect(struct102[0x3e]).toBeLessThanOrEqual(30); // Short spring decay
        expect(res.diagnostics?.corrections.some((c) => c.rule === 'incompatible_delay_time')).toBe(
          true,
        );
      },
    },
    {
      id: 7,
      title: '7. Som limpo sem delay',
      prompt: 'Som limpo cristalino sem delay para funk',
      aiPayload: {
        intent: 0,
        name: 'Clean Funk',
        mp: 'clean_dry',
        dp: 'NONE',
        b: {
          '1': { m: 1, p: [56, 48] },
          '3': { m: 5, p: [34, 1, 68, 52, 50, 58] },
          '7': { m: 2, p: [42, 35, 30] }, // AI mistakenly included delay despite "sem delay"
          '8': { m: 1, p: [18, 55, 28] },
          '9': { m: 5 },
          '10': { m: 4 },
        },
      },
      expectedProfile: 'NONE',
      expectedDelayDecision: 'excluded',
      expectedDlyModel: 0,
      verify: (res, struct102) => {
        expect(struct102[0x01]).toBe(1);
        expect(struct102[0x03]).toBe(5);
        expect(struct102[0x3d]).toBeLessThanOrEqual(24);
        expect(res.diagnostics?.corrections.some((c) => c.rule === 'unjustified_delay_removed')).toBe(
          true,
        );
      },
    },
    {
      id: 8,
      title: '8. Som limpo com chorus e reverb',
      prompt: 'Som limpo com chorus e reverb estilo anos 80',
      aiPayload: {
        intent: 0,
        name: 'Clean Chorus 80',
        mp: 'clean_modulated',
        dp: 'NONE',
        b: {
          '3': { m: 1, p: [28, 1, 68, 50, 52, 58] }, // JC-120
          '6': { m: 1, p: [48, 36, 52] }, // CE-1 Chorus
          '7': { m: 4, p: [45, 30, 28] }, // AI tried adding delay on top of chorus + reverb
          '8': { m: 3, p: [36, 62] }, // Plate
          '9': { m: 1 },
          '10': { m: 3 },
        },
      },
      expectedProfile: 'NONE',
      expectedDelayDecision: 'excluded',
      expectedDlyModel: 0,
      verify: (res, struct102) => {
        expect(struct102[0x06]).toBe(1); // Chorus active
        expect(struct102[0x08]).toBe(3); // Plate active
        expect(struct102[0x3d]).toBeLessThanOrEqual(28); // Controlled reverb mix
        expect(struct102[0x3e]).toBeLessThanOrEqual(48); // Controlled reverb decay
        expect(res.diagnostics?.finalAmbience.modEnabled).toBe(true);
      },
    },
    {
      id: 9,
      title: '9. Timbre ambient com delay e reverb',
      prompt: 'Timbre ambient moderno com delay e reverb longo e envolvente',
      aiPayload: {
        intent: 0,
        name: 'Ambient Pad',
        mp: 'ambient',
        dp: 'AMBIENT',
        b: {
          '3': { m: 1, p: [30, 1, 68, 52, 50, 56] },
          '7': { m: 3, p: [56, 52, 48, 34] }, // Modulate Delay
          '8': { m: 2, p: [54, 76, 25, 58] }, // Hall
          '9': { m: 1 },
          '10': { m: 3 },
        },
      },
      expectedProfile: 'AMBIENT',
      expectedDelayDecision: 'included',
      expectedDlyModel: 3,
      verify: (_res, struct102) => {
        expect(struct102[0x37]).toBe(52);
        expect(struct102[0x38]).toBe(48);
        expect(struct102[0x39]).toBe(34);
        expect(struct102[0x3d]).toBe(54);
        expect(struct102[0x3e]).toBe(76);
      },
    },
    {
      id: 10,
      title: '10. Solicitação genérica sem referência a delay',
      prompt: 'Quero um timbre versátil para tocar na igreja domingo',
      aiPayload: {
        intent: 0,
        name: 'Worship Versatil',
        mp: 'generic',
        dp: 'LEAD', // AI tried to force LEAD delay on generic request
        b: {
          '3': { m: 9, p: [46, 35, 68, 54, 58] }, // Class A30
          '7': { m: 4, p: [50, 42, 38] }, // Unrequested delay
          '8': { m: 2, p: [38, 60, 20, 55] },
          '9': { m: 9 },
          '10': { m: 1 },
        },
      },
      expectedProfile: 'NONE',
      expectedDelayDecision: 'excluded',
      expectedDlyModel: 0,
      verify: (res, struct102) => {
        expect(struct102[0x03]).toBe(9);
        expect(struct102[0x3d]).toBeLessThanOrEqual(22); // Generic crunch budget
        expect(struct102[0x3e]).toBeLessThanOrEqual(36);
        expect(res.diagnostics?.corrections.some((c) => c.rule === 'unjustified_delay_removed')).toBe(
          true,
        );
      },
    },
  ];

  it.each(mandatoryScenarios)(
    'validates scenario $title end-to-end through AiToneService, policy, validator, struct102 & observability',
    async (scenario) => {
      let currentSecret = 'AIzaSyFakeTestSecretKeyForSanitizationCheck123456';
      process.env.GEMINI_API_KEY = currentSecret;
      const diagnosticsLogger = new MidiDiagnosticsLogger({
        logFilePath,
        enabled: true,
      });

      const mockGemini: GeminiClientLike = {
        async generateJson<T>(opts: GeminiGenerateJsonOptions): Promise<T> {
          const parsed = JSON.parse(opts.userPrompt) as { task?: string };
          if (parsed.task === 'validate_musician_gear') {
            return {
              recognized: true,
              pickupSummary: 'HSS (humbucker ponte + single-coils meio/braço)',
              recommendations: [],
            } as T;
          }
          return scenario.aiPayload as T;
        },
      };

      try {
        app = createBackendApp({
          midiAdapter: adapter,
          experimentalEdit: true,
          experimentalBackupDir: backupDir,
          staticDir: null,
          includeFactoryPresets: false,
          geminiClient: mockGemini,
          aiGearPath: gearPath,
          aiCalibrationDir: calibrationDir,
          aiDiagnosticsLogger: diagnosticsLogger,
        });
        await app.ready();
        await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
        await app.inject({
          method: 'PUT',
          url: '/api/ai/gear',
          payload: { guitarModel: 'Fender Stratocaster HSS', outputTarget: 'FRFR' },
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/ai/tone/apply',
          payload: { slotIndex: 4, prompt: scenario.prompt },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as AiToneApplyResponse;
        const storedStruct = adapter.getSlotStruct(4);

        expect(body.diagnostics).toBeDefined();
        expect(body.diagnostics?.delayProfile).toBe(scenario.expectedProfile);
        expect(body.diagnostics?.delayDecision).toBe(scenario.expectedDelayDecision);
        expect(body.diagnostics?.selectedDelayModel.id).toBe(scenario.expectedDlyModel);
        expect(storedStruct[0x07]).toBe(scenario.expectedDlyModel);

        // Per-model delay limits check when delay is active
        if (scenario.expectedDlyModel > 0) {
          const layout = DELAY_MODEL_LAYOUTS[scenario.expectedDlyModel]!;
          const limits = getDelayModelProfileLimits(
            scenario.expectedDlyModel,
            scenario.expectedProfile,
            body.diagnostics!.musicalPurpose,
            body.diagnostics!.finalAmbience.gainStage,
          )!;
          const timeVal = storedStruct[0x36 + layout.timeIndex]!;
          const fbVal = storedStruct[0x36 + layout.feedbackIndex]!;
          const mixVal = storedStruct[0x36 + layout.mixIndex]!;
          expect(timeVal).toBeGreaterThanOrEqual(limits.time[0]);
          expect(timeVal).toBeLessThanOrEqual(limits.time[1]);
          expect(fbVal).toBeGreaterThanOrEqual(limits.feedback[0]);
          expect(fbVal).toBeLessThanOrEqual(limits.feedback[1]);
          expect(mixVal).toBeGreaterThanOrEqual(limits.mix[0]);
          expect(mixVal).toBeLessThanOrEqual(limits.mix[1]);
        }

        scenario.verify(body, storedStruct);
        assertValidMg300BinaryCompatibility(storedStruct, 4);

        // Verify observability log wrote structured entry and NEVER leaked API keys
        const logContent = fs.readFileSync(logFilePath, 'utf8');
        expect(logContent).toContain('[ai-tone]');
        expect(logContent).toContain(scenario.expectedProfile);
        expect(logContent).not.toContain(currentSecret);
      } finally {
        delete process.env.GEMINI_API_KEY;
      }
    },
  );

  it('enforces per-model layouts/limits, blocks incompatible models (Reverse/Pan/Modulate), prevents AI bypass, and applies joint MOD+DLY+RVB+HighGain budget', () => {
    const baseline = resolveCalibrationBaseline({});
    const blank = buildMg300Struct102({ name: 'Blank' });

    // 1. Reverse Delay (id=5) in a LEAD solo without explicit "reverse" is remapped to Tape Echo (4)
    const reverseInLead = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Solo de rock clássico',
      plan: {
        intent: 'create_new',
        presetName: 'Solo Reverse',
        delayProfile: 'AMBIENT', // AI tries to force AMBIENT
        blocks: {
          AMP: { modelId: 12, params: [68, 52, 68, 56, 60, 58] },
          DLY: { modelId: 5, params: [75, 60, 58] },
          CAB: { modelId: 13 },
        },
      },
    });
    expect(reverseInLead.struct102[0x07]).toBe(4); // Remapped to Tape Echo
    expect(reverseInLead.diagnostics.delayProfile).toBe('LEAD');
    expect(
      reverseInLead.diagnostics.corrections.some((c) => c.rule === 'incompatible_delay_model'),
    ).toBe(true);

    // 2. Modulate Delay (id=3) in SLAPBACK is remapped to Tape Echo (4) with short time & low feedback
    const modInSlapback = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Rockabilly slapback vintage',
      plan: {
        intent: 'create_new',
        presetName: 'Slap Mod',
        blocks: {
          AMP: { modelId: 5, params: [36, 1, 68, 50, 52, 58] },
          DLY: { modelId: 3, params: [60, 40, 35, 50] },
          CAB: { modelId: 5 },
        },
      },
    });
    expect(modInSlapback.struct102[0x07]).toBe(4);
    expect(modInSlapback.struct102[0x36]).toBeLessThanOrEqual(24);
    expect(modInSlapback.struct102[0x37]).toBeLessThanOrEqual(12);

    // 3. Different limits per model: Analog Delay (1) vs Digi Delay (2) in high-gain LEAD solo
    const analogLead = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Solo metal pesado',
      plan: {
        intent: 'create_new',
        presetName: 'Analog Lead',
        blocks: {
          AMP: { modelId: 15, params: [70, 50, 68, 55, 60, 58] },
          DLY: { modelId: 1, params: [44, 50, 50] }, // Analog: Echo=p1, Intensity=p2
        },
      },
    });
    const digiLead = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Solo metal pesado',
      plan: {
        intent: 'create_new',
        presetName: 'Digi Lead',
        blocks: {
          AMP: { modelId: 15, params: [70, 50, 68, 55, 60, 58] },
          DLY: { modelId: 2, params: [44, 50, 50] }, // Digi: F.Back=p1, Level=p2
        },
      },
    });
    // Analog allows Echo up to 24 and Intensity up to 20; Digi allows F.Back up to 20 and Level up to 22
    expect(analogLead.struct102[0x37]).toBe(24); // Echo (mix)
    expect(analogLead.struct102[0x38]).toBe(20); // Intensity (feedback)
    expect(digiLead.struct102[0x37]).toBe(20); // F.Back (feedback)
    expect(digiLead.struct102[0x38]).toBe(22); // Level (mix)

    // 4. Joint ambience control: MOD + DLY + RVB + High-Gain triggers excessive_combined_ambience
    const stackedHighGain = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Solo rock com chorus e delay',
      plan: {
        intent: 'create_new',
        presetName: 'Stacked Solo',
        duplicateDelayDirectives: 1,
        blocks: {
          AMP: { modelId: 14, params: [72, 55, 68, 56, 58, 60] },
          MOD: { modelId: 2, params: [40, 35] },
          DLY: { modelId: 4, params: [56, 22, 24] }, // Tape Echo at upper solo bounds
          RVB: { modelId: 3, params: [22, 42] }, // Plate 22 + 24 = 46 > 42 - 4(MOD) = 38
        },
      },
    });
    expect(stackedHighGain.struct102[0x38]! + stackedHighGain.struct102[0x3d]!).toBeLessThanOrEqual(
      38,
    );
    expect(stackedHighGain.struct102[0x3e]).toBeLessThanOrEqual(38); // Plate Decay reduced with MOD+DLY+HighGain
    expect(
      stackedHighGain.diagnostics.corrections.some((c) => c.rule === 'excessive_combined_ambience'),
    ).toBe(true);
    expect(
      stackedHighGain.diagnostics.corrections.some((c) => c.rule === 'multiple_delay_blocks'),
    ).toBe(true);
    expect(
      stackedHighGain.diagnostics.corrections.some((c) => c.rule === 'excessive_repeats'),
    ).toBe(true);

    // 5. Policy cannot be overridden by AI on generic request
    const genericPolicy = resolveAmbiencePolicy({
      userPrompt: 'Timbre bom para tocar pop rock',
      intent: 'create_new',
      aiSuggestedProfile: 'AMBIENT',
      aiSuggestedPurpose: 'ambient',
      gainStage: 'crunch',
    });
    expect(genericPolicy.delayProfile).toBe('NONE');
    expect(genericPolicy.delayAllowed).toBe(false);

    // 6. Observability recorder redacts secrets from prompt & diagnostic strings
    const recorder = new AiToneObservabilityRecorder({
      logger: new MidiDiagnosticsLogger({ logFilePath: null }),
    });
    const recorded = recorder.record({
      ...stackedHighGain.diagnostics,
      originalPrompt: 'Use key AIzaSySecretToken1234567890abcd in prompt',
    });
    expect(recorded.originalPrompt).not.toContain('AIzaSySecretToken1234567890abcd');
    expect(recorded.originalPrompt).toContain('[REDACTED]');

    // 7. Portuguese "no delay" / "no eco" contractions must NOT disable delay, while English "no delay" does
    const ptNoDelayPolicy = resolveAmbiencePolicy({
      userPrompt: 'Ajustar feedback no delay e deixar menos repetições no eco',
      intent: 'edit_existing',
      gainStage: 'crunch',
    });
    expect(ptNoDelayPolicy.explicitNoDelay).toBe(false);
    expect(ptNoDelayPolicy.delayAllowed).toBe(true);

    const enNoDelayPolicy = resolveAmbiencePolicy({
      userPrompt: 'Tight rhythm tone with no delay',
      intent: 'create_new',
      gainStage: 'high_gain',
    });
    expect(enNoDelayPolicy.explicitNoDelay).toBe(true);
    expect(enNoDelayPolicy.delayAllowed).toBe(false);
    expect(enNoDelayPolicy.delayProfile).toBe('NONE');

    // 8. Adversarial edit_existing without delay mention: AI cannot smuggle mp=ambient or new DLY
    const existingDry = buildMg300Struct102({ name: 'Dry Crunch' });
    existingDry[0x07] = 0; // DLY off originally
    const adversarialEdit = buildAndCalibrateStruct102({
      existingStruct: existingDry,
      baseline,
      userPrompt: 'Aumentar médios do amplificador',
      plan: {
        intent: 'edit_existing',
        presetName: 'Dry Crunch',
        musicalPurpose: 'ambient',
        delayProfile: 'AMBIENT',
        blocks: {
          DLY: { modelId: 5, params: [78, 65, 60] },
          RVB: { modelId: 2, params: [58, 80, 10, 75] },
        },
      },
    });
    expect(adversarialEdit.diagnostics.musicalPurpose).toBe('generic');
    expect(adversarialEdit.diagnostics.delayProfile).toBe('NONE');
    expect(adversarialEdit.struct102[0x07]).toBe(0); // New DLY blocked!
    expect(adversarialEdit.struct102[0x3d]).toBeLessThanOrEqual(24); // RVB NOT unlocked to AMBIENT (65)!

    // 9. edit_existing with "aumentar delay" + Modulate still validates Time & Mod ceilings (does not skip pipeline)
    const editIncreaseModulate = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Quero aumentar o delay com Modulate mais longo',
      plan: {
        intent: 'edit_existing',
        presetName: 'Edit Mod Delay',
        blocks: {
          DLY: { modelId: 3, params: [100, 62, 58, 100] },
        },
      },
    });
    expect(editIncreaseModulate.struct102[0x36]).toBeLessThanOrEqual(80); // Time clamped to AMBIENT max
    expect(editIncreaseModulate.struct102[0x39]).toBeLessThanOrEqual(55); // Mod clamped <= 55
    expect(
      editIncreaseModulate.diagnostics.corrections.some(
        (c) => c.rule === 'excessive_delay_modulation',
      ),
    ).toBe(true);

    // 10. Heavy riff + "mais reverb" must NOT turn on AMBIENT delay
    const heavyRiffMoreReverb = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Riff pesado do Metallica com mais reverb',
      plan: {
        intent: 'create_new',
        presetName: 'Heavy Reverb',
        delayProfile: 'AMBIENT',
        blocks: {
          AMP: { modelId: 16, params: [76, 52, 68, 60, 42, 62] },
          DLY: { modelId: 5, params: [65, 50, 45] },
          RVB: { modelId: 2, params: [32, 48, 22, 40] },
        },
      },
    });
    expect(heavyRiffMoreReverb.diagnostics.musicalPurpose).toBe('heavy_rhythm');
    expect(heavyRiffMoreReverb.diagnostics.delayProfile).toBe('RHYTHM');
    expect(heavyRiffMoreReverb.struct102[0x07]).toBe(0); // Delay stays OFF!
  });
});
