import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  MG300_SYSEX_PREFIX,
  MG300_USER_IR_CAB_ID,
  WsServerMessageSchema,
  decodeMg300PresetName,
  decodeMg300UserIrName,
  encodeMg300PresetName,
} from '@quicktone/shared';
import { MockMidiAdapter } from '@quicktone/midi';
import { buildMg300Struct102, buildNuxPresetBinary } from '@quicktone/reader';
import { createBackendApp, type QuickToneBackendApp } from '../app.js';
import { loadEnvFiles, parseEnvContent } from '../env.js';
import {
  AiServiceError,
  GeminiClient,
  type FetchLike,
  type GeminiClientLike,
  selectAndRankGeminiModels,
} from '../ai/gemini-client.js';
import {
  buildAndCalibrateStruct102,
  computeStruct102OutputScore,
  resolveCalibrationBaseline,
} from '../ai/tone-calibrator.js';

class FakePedalAdapter extends MockMidiAdapter {
  public readonly flashSlots = new Map<number, Uint8Array>();
  public ackWrites = true;
  public answerIdentity = true;

  public constructor() {
    super();
    this.flashSlots.set(4, buildMg300Struct102({ name: 'User 2A Clean', patchVolume: 50, irVolume: 20 }));
    this.flashSlots.set(15, buildMg300Struct102({ name: 'Original 4D', patchVolume: 52, irVolume: 20 }));
  }

  public getSlotStruct(slotIndex: number): Uint8Array {
    return this.flashSlots.get(slotIndex) ?? buildMg300Struct102({ name: `Slot ${slotIndex}` });
  }

  public override async sendBytes(bytes: number[]): Promise<void> {
    await super.sendBytes(bytes);
    if (bytes[0] !== 0xf0) return;

    if (bytes[6] === 0x00) {
      if (!this.answerIdentity) return;
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
      queueMicrotask(() => this.simulateHardwareIncoming(this.dumpFrame(slotIndex)));
    } else if (bytes[7] === 0x0e && this.ackWrites) {
      const slotIndex = bytes[8]!;
      this.flashSlots.set(slotIndex, this.decodeWrite(bytes));
      queueMicrotask(() =>
        this.simulateHardwareIncoming([...MG300_SYSEX_PREFIX, 0x70, 0x0e, slotIndex, 0xf7]),
      );
    }
  }

  public emitSlotDump(slotIndex: number, struct102: Uint8Array): void {
    this.flashSlots.set(slotIndex, Uint8Array.from(struct102));
    this.simulateHardwareIncoming(this.dumpFrame(slotIndex));
  }

  private dumpFrame(slotIndex: number): number[] {
    const s = this.getSlotStruct(slotIndex);
    return [
      ...MG300_SYSEX_PREFIX,
      0x70,
      0x06,
      slotIndex,
      ...s.subarray(0, 100),
      s[100]! >> 4,
      s[100]! & 0x0f,
      s[101]!,
      0xf7,
    ];
  }

  private decodeWrite(frame: number[]): Uint8Array {
    const out = new Uint8Array(102);
    out.set(frame.slice(9, 109));
    out[100] = ((frame[109]! & 0x0f) << 4) | (frame[110]! & 0x0f);
    out[101] = frame[111]!;
    return out;
  }
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AI Tone Assistant — Backend Phase 2A', () => {
  let tempDir: string;
  let backupDir: string;
  let gearPath: string;
  let calibrationDir: string;
  let adapter: FakePedalAdapter;
  let app: QuickToneBackendApp | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-ai-test-'));
    backupDir = path.join(tempDir, 'backups');
    gearPath = path.join(tempDir, 'data', 'user-gear.json');
    calibrationDir = path.join(tempDir, 'nuxpresets');
    adapter = new FakePedalAdapter();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses and loads .env without overwriting existing process.env variables', () => {
    const parsed = parseEnvContent(
      [
        '# comment line',
        '',
        'FOO="bar baz"',
        "SINGLE='qux'",
        'INLINE=hello # trailing comment',
        'EMPTY=',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      FOO: 'bar baz',
      SINGLE: 'qux',
      INLINE: 'hello',
      EMPTY: '',
    });

    const envFileA = path.join(tempDir, '.env.a');
    const envFileB = path.join(tempDir, '.env.b');
    fs.writeFileSync(envFileA, 'QT_TEST_ENV_A="from-a"\nQT_TEST_ENV_EXISTING="from-a"\n');
    fs.writeFileSync(envFileB, 'QT_TEST_ENV_A="from-b"\nQT_TEST_ENV_B="from-b"\n');

    const prevExisting = process.env.QT_TEST_ENV_EXISTING;
    const prevA = process.env.QT_TEST_ENV_A;
    const prevB = process.env.QT_TEST_ENV_B;
    process.env.QT_TEST_ENV_EXISTING = 'already-set';
    delete process.env.QT_TEST_ENV_A;
    delete process.env.QT_TEST_ENV_B;

    try {
      loadEnvFiles([envFileA, envFileB]);
      expect(process.env.QT_TEST_ENV_EXISTING).toBe('already-set');
      expect(process.env.QT_TEST_ENV_A).toBe('from-a');
      expect(process.env.QT_TEST_ENV_B).toBe('from-b');
    } finally {
      if (prevExisting === undefined) delete process.env.QT_TEST_ENV_EXISTING;
      else process.env.QT_TEST_ENV_EXISTING = prevExisting;
      if (prevA === undefined) delete process.env.QT_TEST_ENV_A;
      else process.env.QT_TEST_ENV_A = prevA;
      if (prevB === undefined) delete process.env.QT_TEST_ENV_B;
      else process.env.QT_TEST_ENV_B = prevB;
    }
  });

  it('discovers, filters, ranks, caches models via x-goog-api-key and fails over across models and keys without leaking secrets', async () => {
    const ranked = selectAndRankGeminiModels([
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/imagen-3.0-generate-002', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemma-3-27b-it', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro-preview-05-06', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    ]);
    expect(ranked).toEqual([
      'models/gemini-2.5-pro',
      'models/gemini-2.5-pro-preview-05-06',
      'models/gemini-2.5-flash',
      'models/gemini-2.5-flash-lite',
      'models/gemini-2.0-flash',
    ]);

    const key1 = 'SECRET_KEY_1_XYZ';
    const key2 = 'SECRET_KEY_2_ABC';
    const calls: Array<{ url: string; apiKey: string | null }> = [];
    let nowMs = 1_000_000;

    const fetchMock: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const apiKey = headers.get('x-goog-api-key');
      calls.push({ url, apiKey });

      // Ensure keys are NEVER passed in URL query string
      expect(url).not.toContain('key=');
      expect(url).not.toContain(key1);
      expect(url).not.toContain(key2);

      if (url.endsWith('/models')) {
        if (apiKey === key1) {
          return makeJsonResponse({
            models: [
              { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            ],
          });
        }
        return makeJsonResponse({
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        });
      }

      // Key 1 pro -> 429 RESOURCE_EXHAUSTED
      if (apiKey === key1 && url.includes('gemini-2.5-pro')) {
        return makeJsonResponse(
          { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for ${key1}` } },
          429,
        );
      }
      // Key 1 flash -> 503
      if (apiKey === key1 && url.includes('gemini-2.5-flash')) {
        return makeJsonResponse({ error: { code: 503, message: 'Service unavailable' } }, 503);
      }
      // Key 2 flash -> valid JSON
      if (apiKey === key2 && url.includes('gemini-2.5-flash')) {
        return makeJsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: '```json\n{"ok":true,"source":"key2"}\n```' }],
              },
            },
          ],
        });
      }
      return makeJsonResponse({}, 500);
    };

    const client = new GeminiClient({
      apiKeys: [key1, key2],
      fetchFn: fetchMock,
      modelCacheTtlMs: 600_000,
      nowFn: () => nowMs,
    });

    const result = await client.generateJson<{ ok: boolean; source: string }>({
      systemInstruction: 'sys',
      userPrompt: 'usr',
    });
    expect(result).toEqual({ ok: true, source: 'key2' });
    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(2);

    // Second call within TTL uses cached ListModels (0 new /models calls)
    await client.generateJson({ systemInstruction: 'sys', userPrompt: 'usr' });
    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(2);

    // Advance past TTL -> refreshes /models
    nowMs += 600_001;
    await client.generateJson({ systemInstruction: 'sys', userPrompt: 'usr' });
    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(4);

    // When all models/keys fail with quota -> 429 AI_QUOTA_EXHAUSTED and NO key leakage
    const quotaFailClient = new GeminiClient({
      apiKeys: [key1],
      fetchFn: async () =>
        makeJsonResponse(
          { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Key ${key1} exhausted` } },
          429,
        ),
    });
    await expect(
      quotaFailClient.generateJson({ systemInstruction: 's', userPrompt: 'u' }),
    ).rejects.toMatchObject({
      code: 'AI_QUOTA_EXHAUSTED',
      statusCode: 429,
    });
    try {
      await quotaFailClient.generateJson({ systemInstruction: 's', userPrompt: 'u' });
    } catch (err) {
      expect((err as Error).message).not.toContain(key1);
    }

    // Missing keys -> 503 AI_KEYS_MISSING
    const noKeysClient = new GeminiClient({ apiKeys: [] });
    await expect(
      noKeysClient.generateJson({ systemInstruction: 's', userPrompt: 'u' }),
    ).rejects.toMatchObject({
      code: 'AI_KEYS_MISSING',
      statusCode: 503,
    });
  });

  it('validates guitar models via Gemini, persists atomically in user-gear.json, broadcasts WS gear_updated, and enforces auth', async () => {
    const mockGemini: GeminiClientLike = {
      async generateJson<T>(opts: { userPrompt: string }): Promise<T> {
        const parsed = JSON.parse(opts.userPrompt) as { guitarModel: string };
        if (parsed.guitarModel.toLowerCase().includes('geladeira')) {
          return {
            recognized: false,
            reason: '"Geladeira Brastemp" não é um modelo de guitarra válido.',
          } as T;
        }
        return {
          recognized: true,
          normalizedModel: parsed.guitarModel,
          pickupSummary: 'HSS (ponte humbucker Alnico V, meio e braço single-coil)',
          recommendations: ['Use CAB/IR ativo para saída FRFR.'],
        } as T;
      },
    };

    app = createBackendApp({
      midiAdapter: adapter,
      experimentalEdit: true,
      experimentalBackupDir: backupDir,
      staticDir: null,
      includeFactoryPresets: false,
      geminiClient: mockGemini,
      aiGearPath: gearPath,
      aiCalibrationDir: calibrationDir,
    });
    await app.ready();

    // Initially null
    const emptyGear = await app.inject({ method: 'GET', url: '/api/ai/gear' });
    expect(emptyGear.statusCode).toBe(200);
    expect(emptyGear.json().gear).toBeNull();

    // Invalid guitar -> 422 INVALID_GUITAR_MODEL without saving
    const invalidRes = await app.inject({
      method: 'PUT',
      url: '/api/ai/gear',
      payload: { guitarModel: 'Geladeira Brastemp' },
    });
    expect(invalidRes.statusCode).toBe(422);
    expect(invalidRes.json().code).toBe('INVALID_GUITAR_MODEL');
    expect(fs.existsSync(gearPath)).toBe(false);

    // Valid guitar -> saves atomically and broadcasts WS gear_updated
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const bound = app.server.address();
    const port = typeof bound === 'object' && bound !== null ? bound.port : 0;
    let ws: WebSocket | null = null;
    try {
      const wsMessages: Array<ReturnType<typeof WsServerMessageSchema.parse>> = [];
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws!.once('open', () => resolve());
        ws!.once('error', reject);
      });
      ws.on('message', (raw) => {
        wsMessages.push(WsServerMessageSchema.parse(JSON.parse(raw.toString())));
      });

      const saveRes = await app.inject({
        method: 'PUT',
        url: '/api/ai/gear',
        payload: {
          guitarModel: 'Fender Stratocaster HSS',
          outputTarget: 'FRFR Headrush 108',
        },
      });
      expect(saveRes.statusCode).toBe(200);
      expect(saveRes.json().gear.guitarModel).toBe('Fender Stratocaster HSS');
      expect(saveRes.json().gear.pickupSummary).toContain('HSS');
      expect(fs.existsSync(gearPath)).toBe(true);

      await new Promise((r) => setTimeout(r, 40));
      const gearWsEvent = wsMessages.find((m) => m.type === 'gear_updated');
      expect(gearWsEvent).toBeDefined();
      if (gearWsEvent?.type === 'gear_updated') {
        expect(gearWsEvent.gear?.guitarModel).toBe('Fender Stratocaster HSS');
      }

      // Invalid guitar after saving must NOT overwrite existing valid gear
      const secondInvalid = await app.inject({
        method: 'PUT',
        url: '/api/ai/gear',
        payload: { guitarModel: 'Geladeira Brastemp' },
      });
      expect(secondInvalid.statusCode).toBe(422);
      const persisted = await app.inject({ method: 'GET', url: '/api/ai/gear' });
      expect(persisted.json().gear.guitarModel).toBe('Fender Stratocaster HSS');

      // Auth token enforced on /api/ai/*
      app.stateManager.setAuthToken('1234');
      expect((await app.inject({ method: 'GET', url: '/api/ai/gear' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/ai/gear',
            payload: { guitarModel: 'Gibson Les Paul' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/ai/tone/apply',
            payload: { slotIndex: 4, prompt: 'Blues quente' },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      void address;
      ws?.close();
    }
  });

  it('enforces slot >= 36 protection, forbidden slot mentions, missing gear, disconnected pedal, and aborts before Flash write if Gemini fails', async () => {
    let failToneGeneration = false;
    const mockGemini: GeminiClientLike = {
      async generateJson<T>(opts: { userPrompt: string }): Promise<T> {
        const parsed = JSON.parse(opts.userPrompt) as { task?: string };
        if (parsed.task === 'validate_musician_gear') {
          return {
            recognized: true,
            pickupSummary: 'HH',
            recommendations: ['Equilibrar médios'],
          } as T;
        }
        if (failToneGeneration) {
          throw new AiServiceError('AI_UNAVAILABLE', 'Gemini falhou antes da gravação', 503);
        }
        return {
          intent: 'create_new',
          presetName: 'Ambient 3D',
          bpm: 110,
          blocks: {
            AMP: { modelId: 5, params: { Gain: 40, Bright: 1, Level: 68, Bass: 52, Middle: 55, Treble: 60 } },
            CAB: { modelId: 5 },
            MIC: { modelId: 2 },
          },
          summary: 'Timbre limpo com efeito 3D.',
          tips: ['Use captador do braço.'],
        } as T;
      },
    };

    app = createBackendApp({
      midiAdapter: adapter,
      experimentalEdit: true,
      experimentalBackupDir: backupDir,
      staticDir: null,
      includeFactoryPresets: false,
      geminiClient: mockGemini,
      aiGearPath: gearPath,
      aiCalibrationDir: calibrationDir,
    });
    await app.ready();

    // 1. Factory slot >= 36 -> 400 FACTORY_SLOT_PROTECTED
    const factoryRes = await app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 36, prompt: 'Clean quente' },
    });
    expect(factoryRes.statusCode).toBe(400);
    expect(factoryRes.json().code).toBe('FACTORY_SLOT_PROTECTED');

    // 2. Forbidden slot mention -> 400 SLOT_MENTION_FORBIDDEN
    for (const badPrompt of ['Coloque no 4C', 'Use preset 5C', 'Copia F1A', 'Salve no slot 10', 'Grava no 3D']) {
      const mentionRes = await app.inject({
        method: 'POST',
        url: '/api/ai/tone/apply',
        payload: { slotIndex: 4, prompt: badPrompt },
      });
      expect(mentionRes.statusCode).toBe(400);
      expect(mentionRes.json().code).toBe('SLOT_MENTION_FORBIDDEN');
    }

    // 3. Safe 3D phrase passes mention check and hits 412 GEAR_NOT_CONFIGURED
    const noGearRes = await app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 4, prompt: 'Quero timbre espacial com efeito 3D e som 3D' },
    });
    expect(noGearRes.statusCode).toBe(412);
    expect(noGearRes.json().code).toBe('GEAR_NOT_CONFIGURED');

    // Save valid gear
    await app.inject({
      method: 'PUT',
      url: '/api/ai/gear',
      payload: { guitarModel: 'Gibson Les Paul Standard' },
    });

    // 4. Disconnected pedal -> 503 DISCONNECTED
    const disconnectedRes = await app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 4, prompt: 'Blues cremoso com efeito 3D' },
    });
    expect(disconnectedRes.statusCode).toBe(503);
    expect(disconnectedRes.json().code).toBe('DISCONNECTED');

    // Connect pedal
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });

    // 5. Gemini fails -> abort BEFORE backup or 0x0E Flash write!
    failToneGeneration = true;
    const beforeMessages = adapter.getSentMessages().length;
    const beforeSlot4 = Uint8Array.from(adapter.getSlotStruct(4));
    const failAiRes = await app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 4, prompt: 'Blues cremoso com efeito 3D' },
    });
    expect(failAiRes.statusCode).toBe(503);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(adapter.getSlotStruct(4)).toEqual(beforeSlot4);
    const newWriteFrames = adapter
      .getSentMessages()
      .slice(beforeMessages)
      .filter((m) => m[0] === 0xf0 && m[7] === 0x0e);
    expect(newWriteFrames).toHaveLength(0);

    // 6. Gemini succeeds -> creates backup, sends 0x0E, verifies readback, updates experimentalState and presets
    failToneGeneration = false;
    const okRes = await app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 4, prompt: 'Timbre ambient limpo com efeito 3D' },
    });
    expect(okRes.statusCode).toBe(200);
    const body = okRes.json();
    expect(body.slotIndex).toBe(4);
    expect(body.displayBank).toBe('2A');
    expect(body.presetName).toBe('Ambient 3D');
    expect(body.saveResult.ackReceived).toBe(true);
    expect(body.saveResult.verified).toBe(true);
    expect(body.experimentalState.slot).toBe(4);
    expect(body.experimentalState.loaded).toBe(true);
    expect(body.experimentalState.dirty).toBe(false);
    expect(body.experimentalState.sourceMode).toBe('hardware');
    expect(decodeMg300PresetName(adapter.getSlotStruct(4))).toBe('Ambient 3D');
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 0x3c, 4]);
    expect(app.stateManager.getKnownUserStructs().has(4)).toBe(true);
  });

  it('calibrates output deterministically from hardware_user -> nuxpreset_files -> factory_default and enforces MG-300 catalog exceptions', () => {
    // 1. Factory default fallback
    const factoryBaseline = resolveCalibrationBaseline({
      calibrationDir: path.join(tempDir, 'nonexistent'),
    });
    expect(factoryBaseline.source).toBe('factory_default');
    expect(factoryBaseline.avgPatchVolume).toBe(50);
    expect(factoryBaseline.avgIrVolume).toBe(20);
    expect(factoryBaseline.avgAmpLevel).toBe(65);

    // 2. .nuxpreset fallback
    fs.mkdirSync(calibrationDir, { recursive: true });
    const nuxBytes = buildNuxPresetBinary({
      name: 'User Custom Nux',
      patchVolume: 60,
      irVolume: 20,
      formatVersion: 'v2',
    });
    fs.writeFileSync(path.join(calibrationDir, 'custom.nuxpreset'), nuxBytes);
    const fileBaseline = resolveCalibrationBaseline({ calibrationDir });
    expect(fileBaseline.source).toBe('nuxpreset_files');
    expect(fileBaseline.sampleCount).toBe(1);
    expect(fileBaseline.avgPatchVolume).toBe(60);

    // 3. Hardware user structs filter out factory copies and blank drafts when real presets exist
    const hwStructs = new Map<number, Uint8Array>();
    const factoryCopy = buildMg300Struct102({ name: 'VT Blues lead', patchVolume: 50 });
    const blankDraft = buildMg300Struct102({ name: 'New Preset', patchVolume: 50 });
    const realUser = buildMg300Struct102({ name: 'Meu Crunch', patchVolume: 54, irVolume: 20 });
    realUser[0x1c] = 72; // AMP Level
    hwStructs.set(0, realUser);
    hwStructs.set(1, factoryCopy);
    hwStructs.set(2, blankDraft);
    const hwBaseline = resolveCalibrationBaseline({ knownUserStructs: hwStructs, calibrationDir });
    expect(hwBaseline.source).toBe('hardware_user');
    expect(hwBaseline.sampleCount).toBe(1);
    expect(hwBaseline.avgPatchVolume).toBe(54);
    expect(hwBaseline.avgAmpLevel).toBe(72);

    // 4. Extreme AI volumes are clamped below avgOutputScore * 1.08, EFX 12 Pitch is NOT treated as volume,
    //    AMP 2 omits CC24, AMP 4 has 3 params, AMP 8 omits Middle, MOD 13 clamps Harmo to 0..9, CAB 100 blocked in create_new
    const calibratedExtreme = buildAndCalibrateStruct102({
      existingStruct: buildMg300Struct102({ name: 'Blank' }),
      baseline: hwBaseline,
      plan: {
        intent: 'create_new',
        presetName: 'Extreme Test',
        patchVolume: 100,
        irVolume: 40,
        blocks: {
          COMP: { modelId: 1, params: { Output: 100, Sensitivity: 65 } },
          EFX: { modelId: 12, params: { Pitch: 88, Range: 1 } },
          AMP: { modelId: 2, params: { Gain: 70, Pres: 99, Level: 100, Bass: 60, Middle: 50, Treble: 65 } },
          MOD: { modelId: 13, params: { 'Minor Scale': 1, Key: 4, Harmo: 50, Balance: 45 } },
          CAB: { modelId: MG300_USER_IR_CAB_ID },
          MIC: { modelId: 2 },
        },
        summary: 'Test',
        tips: [],
      },
    });
    expect(computeStruct102OutputScore(calibratedExtreme.struct102)).toBeLessThanOrEqual(
      hwBaseline.avgOutputScore * 1.08 + 0.001,
    );
    expect(calibratedExtreme.struct102[0x02]).toBe(12);
    expect(calibratedExtreme.struct102[0x13]).toBe(88); // Pitch Bender p0 preserved!
    expect(calibratedExtreme.struct102[0x1b]).toBe(0); // AMP 2 Deluxe Rvb has no CC24!
    expect(calibratedExtreme.struct102[0x2f + 2]).toBe(9); // MOD 13 Harmo clamped to 9
    expect(calibratedExtreme.struct102[0x09]).not.toBe(MG300_USER_IR_CAB_ID);

    // 5. AMP 4 Tweedy (3 params) and AMP 8 Class A15 (no Middle) + AMP=0 -> CAB=0
    const tweedyResult = buildAndCalibrateStruct102({
      existingStruct: buildMg300Struct102({ name: 'Blank' }),
      baseline: hwBaseline,
      plan: {
        intent: 'create_new',
        presetName: 'Tweedy',
        blocks: {
          AMP: { modelId: 4, params: { Gain: 55, Tone: 60, Level: 70, Bass: 80, Middle: 80, Treble: 80 } },
          CAB: { modelId: 4 },
        },
        summary: 'Tweedy',
        tips: [],
      },
    });
    expect(Array.from(tweedyResult.struct102.subarray(0x1a, 0x20))).toEqual([
      55,
      60,
      tweedyResult.calibration.appliedAmpLevel,
      0,
      0,
      0,
    ]);
    expect(tweedyResult.calibration.appliedAmpLevel).toBeGreaterThanOrEqual(35);
    expect(tweedyResult.calibration.appliedAmpLevel).toBeLessThanOrEqual(70);

    const classA15Result = buildAndCalibrateStruct102({
      existingStruct: buildMg300Struct102({ name: 'Blank' }),
      baseline: hwBaseline,
      plan: {
        intent: 'create_new',
        presetName: 'AC15',
        blocks: {
          AMP: { modelId: 8, params: { Gain: 45, Cut: 30, Level: 68, Bass: 52, Middle: 99, Treble: 64 } },
        },
        summary: 'AC15',
        tips: [],
      },
    });
    expect(classA15Result.struct102[0x1e]).toBe(0); // Middle omitted on Class A15

    const ampOffResult = buildAndCalibrateStruct102({
      existingStruct: buildMg300Struct102({ name: 'Blank' }),
      baseline: hwBaseline,
      plan: {
        intent: 'create_new',
        presetName: 'No Amp',
        blocks: {
          AMP: { modelId: 0 },
          CAB: { modelId: 10 },
        },
        summary: 'No Amp',
        tips: [],
      },
    });
    expect(ampOffResult.struct102[0x03]).toBe(0);
    expect(ampOffResult.struct102[0x09]).toBe(0);
  });

  it('preserves untouched blocks (including inactive bytes of bypassed blocks) and User IR CAB=100 in edit_existing, and serializes concurrent mutations', async () => {
    const existing = buildMg300Struct102({ name: 'Custom User IR', patchVolume: 52, irVolume: 22 });
    existing[0x01] = 0; // COMP bypassed, with custom inactive bytes
    existing.set([41, 73, 0, 0, 0, 0], 0x0c);
    existing[0x06] = 0; // MOD bypassed, with custom inactive bytes
    existing.set([61, 44, 33, 2, 0, 0], 0x2f);
    existing[0x03] = 15; // Friedman
    existing.set([65, 55, 70, 58, 52, 62], 0x1a);
    existing[0x09] = MG300_USER_IR_CAB_ID; // CAB=100 with custom User IR name "OwnHammer"
    const irNameEncoded = encodeMg300PresetName('OwnHammer');
    existing[0x57] = irNameEncoded.length;
    existing.set(irNameEncoded.bytes.subarray(0, 10), 0x58);

    const baseline = resolveCalibrationBaseline({});
    const edited = buildAndCalibrateStruct102({
      existingStruct: existing,
      baseline,
      plan: {
        intent: 'edit_existing',
        presetName: 'Custom User IR',
        blocks: {
          DLY: { modelId: 4, params: { Time: 48, 'F.Back': 35, Level: 42 } },
        },
        summary: 'Adicionado Tape Echo sem mexer nos outros blocos.',
        tips: [],
      },
    });

    // Untouched COMP (bypass=0) and MOD (bypass=0) inactive bytes preserved byte-for-byte!
    expect(edited.struct102[0x01]).toBe(0);
    expect(Array.from(edited.struct102.subarray(0x0c, 0x12))).toEqual([41, 73, 0, 0, 0, 0]);
    expect(edited.struct102[0x06]).toBe(0);
    expect(Array.from(edited.struct102.subarray(0x2f, 0x35))).toEqual([61, 44, 33, 2, 0, 0]);
    // Untouched AMP & CAB=100 + User IR name preserved
    expect(edited.struct102[0x03]).toBe(15);
    expect(edited.struct102[0x09]).toBe(MG300_USER_IR_CAB_ID);
    expect(decodeMg300UserIrName(edited.struct102)).toBe('OwnHammer');
    // Edited DLY applied
    expect(edited.struct102[0x07]).toBe(4);
    expect(Array.from(edited.struct102.subarray(0x36, 0x39))).toEqual([48, 35, 42]);

    // Concurrency check: slow Gemini response holds mutex -> second request gets 409 DEVICE_BUSY
    let releaseSlowGemini!: () => void;
    const slowGemini: GeminiClientLike = {
      async generateJson<T>(opts: { userPrompt: string }): Promise<T> {
        const parsed = JSON.parse(opts.userPrompt) as { task?: string };
        if (parsed.task === 'validate_musician_gear') {
          return { recognized: true, pickupSummary: 'HH', recommendations: [] } as T;
        }
        await new Promise<void>((resolve) => {
          releaseSlowGemini = resolve;
        });
        return {
          intent: 'edit_existing',
          presetName: 'Slow Edit',
          blocks: { RVB: { modelId: 2, params: { Mix: 35, Decay: 55, 'Pre.D': 20, Liveliness: 50 } } },
          summary: 'Reverb Hall adicionado.',
          tips: [],
        } as T;
      },
    };

    app = createBackendApp({
      midiAdapter: adapter,
      experimentalEdit: true,
      experimentalBackupDir: backupDir,
      staticDir: null,
      includeFactoryPresets: false,
      geminiClient: slowGemini,
      aiGearPath: gearPath,
      aiCalibrationDir: calibrationDir,
    });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
    await app.inject({
      method: 'PUT',
      url: '/api/ai/gear',
      payload: { guitarModel: 'Ibanez RG550' },
    });

    const firstApply = app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 15, prompt: 'Adiciona hall reverb' },
    });

    // Wait until Gemini call starts inside exclusive lock
    await new Promise((r) => setTimeout(r, 40));
    const concurrentLoad = await app.inject({
      method: 'POST',
      url: '/api/experimental/load',
      payload: { slot: 15 },
    });
    expect(concurrentLoad.statusCode).toBe(409);
    expect(concurrentLoad.json().code).toBe('DEVICE_BUSY');

    releaseSlowGemini();
    const finished = await firstApply;
    expect(finished.statusCode).toBe(200);
    expect(finished.json().experimentalState.busy).toBe(false);
  });
});
