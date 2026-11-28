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
  ALLOWED_GEMINI_MODELS,
  AiServiceError,
  GeminiClient,
  type FetchLike,
  type GeminiClientLike,
  type GeminiGenerateJsonOptions,
  selectAndRankGeminiModels,
} from '../ai/gemini-client.js';
import {
  TONE_RESPONSE_SCHEMA,
  TONE_SYSTEM_INSTRUCTION,
} from '../ai/ai-tone-service.js';
import {
  buildAndCalibrateStruct102,
  computeStruct102OutputScore,
  resolveCalibrationBaseline,
} from '../ai/tone-calibrator.js';

class FakePedalAdapter extends MockMidiAdapter {
  public readonly flashSlots = new Map<number, Uint8Array>();
  public ackWrites = true;
  public answerIdentity = true;
  public simulateStm32InactiveBytes = false;

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
      const written = this.decodeWrite(bytes);
      if (this.simulateStm32InactiveBytes) {
        // Real STM32 firmware quirk: inactive params of bypassed blocks (MOD=0, offset 48)
        // and undeclared trailing DLY bytes [3..5] (offsets 0x39..0x3b) may reflect ROM metadata.
        if (written[0x06] === 0) {
          written[48] = 2;
        }
        if (written[0x07] === 4) {
          written.set([7, 1, 0], 0x39);
        }
      }
      this.flashSlots.set(slotIndex, written);
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

  it('parses and loads .env without overwriting non-empty process.env variables while filling empty ones', () => {
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
    fs.writeFileSync(
      envFileA,
      'QT_TEST_ENV_A="from-a"\nQT_TEST_ENV_EXISTING="from-a"\nQT_TEST_ENV_EMPTY="filled-from-a"\n',
    );
    fs.writeFileSync(envFileB, 'QT_TEST_ENV_A="from-b"\nQT_TEST_ENV_B="from-b"\n');

    const prevExisting = process.env.QT_TEST_ENV_EXISTING;
    const prevA = process.env.QT_TEST_ENV_A;
    const prevB = process.env.QT_TEST_ENV_B;
    const prevEmpty = process.env.QT_TEST_ENV_EMPTY;
    process.env.QT_TEST_ENV_EXISTING = 'already-set';
    process.env.QT_TEST_ENV_EMPTY = '';
    delete process.env.QT_TEST_ENV_A;
    delete process.env.QT_TEST_ENV_B;

    try {
      loadEnvFiles([envFileA, envFileB]);
      expect(process.env.QT_TEST_ENV_EXISTING).toBe('already-set');
      expect(process.env.QT_TEST_ENV_EMPTY).toBe('filled-from-a');
      expect(process.env.QT_TEST_ENV_A).toBe('from-a');
      expect(process.env.QT_TEST_ENV_B).toBe('from-b');
    } finally {
      if (prevExisting === undefined) delete process.env.QT_TEST_ENV_EXISTING;
      else process.env.QT_TEST_ENV_EXISTING = prevExisting;
      if (prevA === undefined) delete process.env.QT_TEST_ENV_A;
      else process.env.QT_TEST_ENV_A = prevA;
      if (prevB === undefined) delete process.env.QT_TEST_ENV_B;
      else process.env.QT_TEST_ENV_B = prevB;
      if (prevEmpty === undefined) delete process.env.QT_TEST_ENV_EMPTY;
      else process.env.QT_TEST_ENV_EMPTY = prevEmpty;
    }
  });

  it('restricts model discovery strictly to ALLOWED_GEMINI_MODELS in exact order, caches via x-goog-api-key, and fails over without leaking secrets', async () => {
    const ranked = selectAndRankGeminiModels([
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/imagen-3.0-generate-002', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemma-3-27b-it', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-4-carbon', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-nano-banana-2.1', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-4-hydrogen', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    ]);
    expect(ranked).toEqual([
      'models/gemini-3.8-flash',
      'models/gemini-3.6-flash',
      'models/gemini-4-hydrogen',
      'models/gemini-3.5-flash-lite',
    ]);
    expect(ranked).toEqual([...ALLOWED_GEMINI_MODELS]);

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
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
            ],
          });
        }
        return makeJsonResponse({
          models: [
            { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        });
      }

      // Disallowed models must never be called
      expect(url).not.toContain('gemini-2.5-pro');
      expect(url).not.toContain('gemini-4-argon');

      // Key 1 3.8-flash -> 429 RESOURCE_EXHAUSTED
      if (apiKey === key1 && url.includes('gemini-3.8-flash')) {
        return makeJsonResponse(
          { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for ${key1}` } },
          429,
        );
      }
      // Key 1 3.6-flash -> 503
      if (apiKey === key1 && url.includes('gemini-3.6-flash')) {
        return makeJsonResponse({ error: { code: 503, message: 'Service unavailable' } }, 503);
      }
      // Key 2 3.6-flash -> valid JSON
      if (apiKey === key2 && url.includes('gemini-3.6-flash')) {
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

  it('retries HTTP 400 for unsupported thinkingConfig/responseSchema on the same model and skips invalid 401/403 keys immediately', async () => {
    const invalidKey = 'BAD_KEY_401';
    const validKey = 'GOOD_KEY_2';
    const generateCalls: Array<{
      apiKey: string | null;
      url: string;
      generationConfig: Record<string, unknown>;
    }> = [];

    const fetchMock: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const apiKey = headers.get('x-goog-api-key');

      if (url.endsWith('/models')) {
        if (apiKey === invalidKey) {
          return makeJsonResponse(
            { error: { code: 401, status: 'UNAUTHENTICATED', message: 'API key not valid' } },
            401,
          );
        }
        return makeJsonResponse({
          models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        });
      }

      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as {
        generationConfig: Record<string, unknown>;
      };
      generateCalls.push({ apiKey, url, generationConfig: parsedBody.generationConfig });

      // Attempt 1: reject thinkingConfig with HTTP 400
      if (parsedBody.generationConfig.thinkingConfig !== undefined) {
        return makeJsonResponse(
          { error: { code: 400, message: 'Unknown field thinkingConfig in generationConfig' } },
          400,
        );
      }

      // Attempt 2: reject responseSchema with HTTP 400
      if (parsedBody.generationConfig.responseSchema !== undefined) {
        return makeJsonResponse(
          { error: { code: 400, message: 'responseSchema is not supported on this model' } },
          400,
        );
      }

      // Attempt 3 on the SAME model (gemini-3.8-flash): succeeds!
      return makeJsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: '{"intent":0,"name":"Retry OK","b":{}}' }],
            },
          },
        ],
      });
    };

    const client = new GeminiClient({
      apiKeys: [invalidKey, validKey],
      fetchFn: fetchMock,
    });

    const result = await client.generateJson<{ intent: number; name: string }>({
      systemInstruction: 'sys',
      userPrompt: 'usr',
      responseSchema: TONE_RESPONSE_SCHEMA,
      thinkingBudget: 0,
      maxOutputTokens: 640,
    });

    expect(result).toEqual({ intent: 0, name: 'Retry OK', b: {} });
    // Invalid key must NEVER trigger any :generateContent request
    expect(generateCalls.filter((c) => c.apiKey === invalidKey)).toHaveLength(0);
    // All 3 attempts happened on gemini-3.8-flash (no premature failover to 3.6-flash)
    expect(generateCalls).toHaveLength(3);
    expect(generateCalls.every((c) => c.url.includes('gemini-3.8-flash'))).toBe(true);
    expect(generateCalls[0]!.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(generateCalls[0]!.generationConfig.responseSchema).toBeDefined();
    expect(generateCalls[1]!.generationConfig.thinkingConfig).toBeUndefined();
    expect(generateCalls[1]!.generationConfig.responseSchema).toBeDefined();
    expect(generateCalls[2]!.generationConfig.thinkingConfig).toBeUndefined();
    expect(generateCalls[2]!.generationConfig.responseSchema).toBeUndefined();
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

  it('enforces protections, sends strictly numeric responseSchema + compact prompt, and builds deterministic summary/tips from numeric Gemini JSON', async () => {
    let failToneGeneration = false;
    let lastToneCallOpts: GeminiGenerateJsonOptions | null = null;

    const mockGemini: GeminiClientLike = {
      async generateJson<T>(opts: GeminiGenerateJsonOptions): Promise<T> {
        const parsed = JSON.parse(opts.userPrompt) as { task?: string };
        if (parsed.task === 'validate_musician_gear') {
          return {
            recognized: true,
            pickupSummary: 'HH (dois humbuckers PAF)',
            recommendations: ['Equilibrar médios em 500Hz ao tocar em caixa ativa.'],
          } as T;
        }
        lastToneCallOpts = opts;
        if (failToneGeneration) {
          throw new AiServiceError('AI_UNAVAILABLE', 'Gemini falhou antes da gravação', 503);
        }
        // Strictly numeric payload: ZERO summary or tips returned by the API!
        return {
          intent: 0,
          name: 'Ambient 3D',
          bpm: 110,
          tf: 0,
          ic: 2,
          b: {
            '3': { m: 5, p: [40, 1, 68, 52, 55, 60] },
            '9': { m: 5 },
            '10': { m: 2 },
          },
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
      payload: { guitarModel: 'Gibson Les Paul Standard', outputTarget: 'Caixa ativa FRFR' },
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

    // 6. Gemini succeeds with strictly numeric payload -> backend builds struct102, summary & tips
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
    expect(body.bpm).toBe(110);
    expect(body.summary).toContain('2A');
    expect(body.summary).toContain('Ambient 3D');
    expect(body.summary).toContain('AMP Twin Rvb');
    expect(body.summary).toContain('CAB Twin 212');
    expect(body.summary).toContain('MIC Dynamic SM57');
    expect(Array.isArray(body.tips)).toBe(true);
    expect(body.tips.length).toBeGreaterThanOrEqual(1);
    expect(body.tips.length).toBeLessThanOrEqual(3);
    expect(body.tips.some((tip: string) => tip.includes('Gibson Les Paul Standard'))).toBe(true);
    expect(body.tips.some((tip: string) => tip.includes('IR Cut'))).toBe(true);
    expect(body.saveResult.ackReceived).toBe(true);
    expect(body.saveResult.verified).toBe(true);
    expect(body.experimentalState.slot).toBe(4);
    expect(body.experimentalState.loaded).toBe(true);
    expect(body.experimentalState.dirty).toBe(false);
    expect(body.experimentalState.sourceMode).toBe('hardware');
    expect(decodeMg300PresetName(adapter.getSlotStruct(4))).toBe('Ambient 3D');
    expect(adapter.getSlotStruct(4)[0x43]).toBe(2); // irCut=2 applied
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 0x3c, 4]);
    expect(app.stateManager.getKnownUserStructs().has(4)).toBe(true);

    // Verify Gemini call contract: static systemInstruction, responseSchema, thinkingBudget=0, compact userPrompt
    expect(lastToneCallOpts).not.toBeNull();
    expect(lastToneCallOpts!.systemInstruction).toBe(TONE_SYSTEM_INSTRUCTION);
    expect(lastToneCallOpts!.systemInstruction).toContain('COMP(1) -> EFX(2) -> AMP(3)');
    expect(lastToneCallOpts!.systemInstruction).toContain('Hiwatt DR103');
    expect(lastToneCallOpts!.systemInstruction).toContain('Analog Delay');
    expect(lastToneCallOpts!.responseSchema).toEqual(TONE_RESPONSE_SCHEMA);
    expect(lastToneCallOpts!.thinkingBudget).toBe(0);
    expect(lastToneCallOpts!.maxOutputTokens).toBe(640);
    expect(lastToneCallOpts!.temperature).toBe(0.25);

    const parsedPrompt = JSON.parse(lastToneCallOpts!.userPrompt) as Record<string, unknown>;
    expect(parsedPrompt.mg300Catalog).toBeUndefined();
    expect(parsedPrompt.expectedJsonSchema).toBeUndefined();
    expect(parsedPrompt.slot).toEqual({ slotIndex: 4, displayBank: '2A' });
    expect(parsedPrompt.request).toBe('Timbre ambient limpo com efeito 3D');
    const currentCtx = parsedPrompt.current as { blocks: Record<string, number[]> };
    expect(Array.isArray(currentCtx.blocks['3'])).toBe(true);
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
    //    AMP 2 omits CC24 (packed 5-param array supported), AMP 4 has 3 params, AMP 8 omits Middle,
    //    MOD 13 clamps Harmo to 0..9, CAB 100 blocked in create_new
    const calibratedExtreme = buildAndCalibrateStruct102({
      existingStruct: buildMg300Struct102({ name: 'Blank' }),
      baseline: hwBaseline,
      plan: {
        intent: 'create_new',
        presetName: 'Extreme Test',
        patchVolume: 100,
        irVolume: 40,
        blocks: {
          COMP: { modelId: 1, params: [100, 65] },
          EFX: { modelId: 12, params: [88, 1] },
          AMP: { modelId: 2, params: [70, 100, 60, 50, 65] },
          MOD: { modelId: 13, params: [1, 4, 50, 45] },
          CAB: { modelId: MG300_USER_IR_CAB_ID },
          MIC: { modelId: 2 },
        },
      },
    });
    expect(computeStruct102OutputScore(calibratedExtreme.struct102)).toBeLessThanOrEqual(
      hwBaseline.avgOutputScore * 1.08 + 0.001,
    );
    expect(calibratedExtreme.struct102[0x02]).toBe(12);
    expect(calibratedExtreme.struct102[0x13]).toBe(88); // Pitch Bender p0 preserved!
    expect(calibratedExtreme.struct102[0x1a]).toBe(70); // AMP 2 Gain
    expect(calibratedExtreme.struct102[0x1b]).toBe(0); // AMP 2 Deluxe Rvb has no CC24!
    expect(calibratedExtreme.struct102[0x1d]).toBe(60); // AMP 2 Bass mapped from packed index 2
    expect(calibratedExtreme.struct102[0x2f + 2]).toBe(9); // MOD 13 Harmo clamped to 9
    expect(calibratedExtreme.struct102[0x09]).not.toBe(MG300_USER_IR_CAB_ID);

    // 5. AMP 4 Tweedy (3 params) and AMP 8 Class A15 (no Middle, packed 5-param array) + AMP=0 -> CAB=0
    const tweedyResult = buildAndCalibrateStruct102({
      existingStruct: buildMg300Struct102({ name: 'Blank' }),
      baseline: hwBaseline,
      plan: {
        intent: 'create_new',
        presetName: 'Tweedy',
        blocks: {
          AMP: { modelId: 4, params: [55, 60, 70, 80, 80, 80] },
          CAB: { modelId: 4 },
        },
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
          AMP: { modelId: 8, params: [45, 30, 68, 52, 64] },
        },
      },
    });
    expect(classA15Result.struct102[0x1e]).toBe(0); // Middle omitted on Class A15
    expect(classA15Result.struct102[0x1f]).toBe(64); // Treble mapped from packed index 4

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
      },
    });
    expect(ampOffResult.struct102[0x03]).toBe(0);
    expect(ampOffResult.struct102[0x09]).toBe(0);
  });

  it('clamps DLY/RVB cleanly on high-gain solos (including Analog Delay Echo/Intensity) while preserving wet ambience on explicit ambient/shoegaze prompts', () => {
    const baseline = resolveCalibrationBaseline({
      calibrationDir: path.join(tempDir, 'nonexistent'),
    });
    const blank = buildMg300Struct102({ name: 'Blank' });

    // 1. Sweet Child O' Mine high-gain solo with exaggerated Tape Echo + Hall -> clamped to clear non-resonant levels
    const sweetChild = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: "Timbre do solo de Sweet Child O' Mine do Slash",
      plan: {
        intent: 'create_new',
        presetName: 'Sweet Child Solo',
        blocks: {
          AMP: { modelId: 12, params: [72, 55, 68, 58, 62, 60] }, // Brit 800 high-gain
          DLY: { modelId: 4, params: [46, 55, 50] }, // Tape Echo: Time=46, F.Back=55, Level=50
          RVB: { modelId: 2, params: [55, 80, 5, 80] }, // Hall: Mix=55, Decay=80, Pre.D=5, Liveliness=80
          CAB: { modelId: 13 },
          MIC: { modelId: 2 },
        },
      },
    });
    expect(sweetChild.struct102[0x36]).toBe(46); // Time preserved
    expect(sweetChild.struct102[0x37]).toBeLessThanOrEqual(22); // F.Back clamped <= 22
    expect(sweetChild.struct102[0x38]).toBeLessThanOrEqual(24); // Level clamped <= 24
    expect(sweetChild.struct102[0x3d]).toBeLessThanOrEqual(22); // Hall Mix clamped <= 22
    expect(sweetChild.struct102[0x3e]).toBeLessThanOrEqual(42); // Hall Decay clamped <= 42
    expect(sweetChild.struct102[0x3f]).toBeGreaterThanOrEqual(20); // Hall Pre.D >= 20
    expect(sweetChild.struct102[0x40]).toBeLessThanOrEqual(45); // Hall Liveliness <= 45

    // 2. Analog Delay (id=1): p1=Echo (level <= 24), p2=Intensity (feedback <= 20) on high-gain
    const analogSolo = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Solo de blues rock estilo Gary Moore',
      plan: {
        intent: 'create_new',
        presetName: 'Blues Solo',
        blocks: {
          AMP: { modelId: 15, params: [68, 50, 68, 55, 60, 58] },
          DLY: { modelId: 1, params: [44, 60, 55] }, // Analog Delay: Time=44, Echo=60, Intensity=55
          CAB: { modelId: 13 },
        },
      },
    });
    expect(analogSolo.struct102[0x36]).toBe(44); // Time
    expect(analogSolo.struct102[0x37]).toBe(24); // Echo (level) clamped to 24
    expect(analogSolo.struct102[0x38]).toBe(20); // Intensity (feedback) clamped to 20

    // 3. Explicit ambient/shoegaze request preserves high DLY/RVB values
    const ambientShoegaze = buildAndCalibrateStruct102({
      existingStruct: blank,
      baseline,
      userPrompt: 'Quero um timbre ambient shoegaze com muito delay e reverb longo',
      plan: {
        intent: 'create_new',
        presetName: 'Shoegaze Wash',
        blocks: {
          AMP: { modelId: 1, params: [35, 1, 65, 50, 52, 58] },
          DLY: { modelId: 4, params: [52, 55, 50] },
          RVB: { modelId: 2, params: [55, 80, 25, 65] },
          CAB: { modelId: 1 },
        },
      },
    });
    expect(ambientShoegaze.struct102[0x37]).toBe(55); // F.Back preserved
    expect(ambientShoegaze.struct102[0x38]).toBe(50); // Level preserved
    expect(ambientShoegaze.struct102[0x3d]).toBe(55); // Hall Mix preserved
    expect(ambientShoegaze.struct102[0x3e]).toBe(80); // Hall Decay preserved
  });

  it('preserves untouched blocks and User IR CAB=100 in edit_existing (default high-gain ceiling vs explicit increase) and serializes concurrent mutations', async () => {
    const existing = buildMg300Struct102({ name: 'Custom User IR', patchVolume: 52, irVolume: 22 });
    existing[0x01] = 0; // COMP bypassed, with custom inactive bytes
    existing.set([41, 73, 0, 0, 0, 0], 0x0c);
    existing[0x06] = 0; // MOD bypassed, with custom inactive bytes
    existing.set([61, 44, 33, 2, 0, 0], 0x2f);
    existing[0x03] = 15; // Friedman (Gain=65 -> high-gain)
    existing.set([65, 55, 70, 58, 52, 62], 0x1a);
    existing[0x09] = MG300_USER_IR_CAB_ID; // CAB=100 with custom User IR name "OwnHammer"
    const irNameEncoded = encodeMg300PresetName('OwnHammer');
    existing[0x57] = irNameEncoded.length;
    existing.set(irNameEncoded.bytes.subarray(0, 10), 0x58);

    const baseline = resolveCalibrationBaseline({});

    // A. Default edit_existing on high-gain Friedman -> Tape Echo clamped to clean high-gain ceiling [48, 22, 24]
    const editedDefault = buildAndCalibrateStruct102({
      existingStruct: existing,
      baseline,
      userPrompt: 'Adicionar Tape Echo para solos',
      plan: {
        intent: 'edit_existing',
        presetName: 'Custom User IR',
        blocks: {
          DLY: { modelId: 4, params: [48, 35, 42] },
        },
      },
    });
    // Untouched COMP (bypass=0) and MOD (bypass=0) inactive bytes preserved byte-for-byte!
    expect(editedDefault.struct102[0x01]).toBe(0);
    expect(Array.from(editedDefault.struct102.subarray(0x0c, 0x12))).toEqual([41, 73, 0, 0, 0, 0]);
    expect(editedDefault.struct102[0x06]).toBe(0);
    expect(Array.from(editedDefault.struct102.subarray(0x2f, 0x35))).toEqual([61, 44, 33, 2, 0, 0]);
    // Untouched AMP & CAB=100 + User IR name preserved
    expect(editedDefault.struct102[0x03]).toBe(15);
    expect(editedDefault.struct102[0x09]).toBe(MG300_USER_IR_CAB_ID);
    expect(decodeMg300UserIrName(editedDefault.struct102)).toBe('OwnHammer');
    // Edited DLY calibrated for high-gain Friedman
    expect(editedDefault.struct102[0x07]).toBe(4);
    expect(Array.from(editedDefault.struct102.subarray(0x36, 0x39))).toEqual([48, 22, 24]);

    // B. Explicit "aumentar delay" request -> preserves [48, 35, 42] within <= 65 safety ceiling
    const editedExplicitMoreDelay = buildAndCalibrateStruct102({
      existingStruct: existing,
      baseline,
      userPrompt: 'Quero aumentar delay com Tape Echo mais presente',
      plan: {
        intent: 'edit_existing',
        presetName: 'Custom User IR',
        blocks: {
          DLY: { modelId: 4, params: [48, 35, 42] },
        },
      },
    });
    expect(editedExplicitMoreDelay.struct102[0x07]).toBe(4);
    expect(Array.from(editedExplicitMoreDelay.struct102.subarray(0x36, 0x39))).toEqual([48, 35, 42]);

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
          intent: 1,
          name: 'Slow Edit',
          b: {
            '8': { m: 2, p: [35, 55, 20, 50] },
          },
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
    expect(finished.json().summary).toContain('RVB Hall');
  });

  it('returns saveResult.verified=true when STM32 readback alters inactive MOD=0 byte (offset 48) and undeclared DLY[3..5] bytes', async () => {
    adapter.simulateStm32InactiveBytes = true;

    const numericGemini: GeminiClientLike = {
      async generateJson<T>(opts: GeminiGenerateJsonOptions): Promise<T> {
        const parsed = JSON.parse(opts.userPrompt) as { task?: string };
        if (parsed.task === 'validate_musician_gear') {
          return {
            recognized: true,
            pickupSummary: 'SSS (três single-coils)',
            recommendations: ['Use NR moderado com single-coils.'],
          } as T;
        }
        return {
          intent: 0,
          name: 'Slash Lead',
          bpm: 124,
          tf: 0,
          ic: 2,
          b: {
            '2': { m: 5, p: [70, 58, 18] }, // T Screamer
            '3': { m: 15, p: [66, 54, 68, 56, 62, 58] }, // Friedman
            '6': { m: 0 }, // MOD bypassed -> adapter will mutate offset 48 to 2
            '7': { m: 4, p: [46, 20, 22] }, // Tape Echo -> adapter will mutate DLY[3..5] to [7,1,0]
            '8': { m: 3, p: [18, 34] }, // Plate
            '9': { m: 13 }, // V30 412
            '10': { m: 2 }, // SM57
          },
        } as T;
      },
    };

    app = createBackendApp({
      midiAdapter: adapter,
      experimentalEdit: true,
      experimentalBackupDir: backupDir,
      staticDir: null,
      includeFactoryPresets: false,
      geminiClient: numericGemini,
      aiGearPath: gearPath,
      aiCalibrationDir: calibrationDir,
    });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
    await app.inject({
      method: 'PUT',
      url: '/api/ai/gear',
      payload: { guitarModel: 'Fender Stratocaster SSS', outputTarget: 'Monitor FRFR' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 4, prompt: 'Solo rock clássico definido' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.saveResult.ackReceived).toBe(true);
    expect(body.saveResult.verified).toBe(true);
    expect(body.saveResult.mismatchedOffsets).toEqual([]);
    expect(body.experimentalState.loaded).toBe(true);
    expect(body.experimentalState.dirty).toBe(false);
    // Confirm the hardware slot actually held the mutated STM32 bytes on offset 48 and DLY[3..5]
    const stored = adapter.getSlotStruct(4);
    expect(stored[0x06]).toBe(0);
    expect(stored[48]).toBe(2);
    expect(Array.from(stored.subarray(0x39, 0x3c))).toEqual([7, 1, 0]);
  });

  it('handles thought parts, thinking-required 400 retry with bumped maxOutputTokens, non-quota token 400 errors, 401/403 on generateContent, and .env auto-reload', async () => {
    const calls: Array<{ apiKey: string | null; url: string; maxOutputTokens?: unknown }> = [];
    const fetchMock: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const apiKey = headers.get('x-goog-api-key');

      if (url.endsWith('/models')) {
        return makeJsonResponse({
          models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as {
        generationConfig?: { thinkingConfig?: unknown; maxOutputTokens?: unknown };
      };
      calls.push({ apiKey, url, maxOutputTokens: body.generationConfig?.maxOutputTokens });

      // Key 1 passes /models (cached) but gets 403 on :generateContent -> must skip remaining models on Key 1 immediately
      if (apiKey === 'REVOKED_KEY') {
        return makeJsonResponse(
          { error: { code: 403, message: 'Invalid authentication token' } },
          403,
        );
      }

      // Key 2 on 3.8-flash: rejects thinkingBudget=0 with "Thinking cannot be disabled" -> retries same model with bumped maxOutputTokens and returns thought part + JSON part
      if (apiKey === 'VALID_KEY' && url.includes('gemini-3.8-flash')) {
        if (body.generationConfig?.thinkingConfig !== undefined) {
          return makeJsonResponse(
            { error: { code: 400, message: 'Thinking cannot be disabled for this model' } },
            400,
          );
        }
        return makeJsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Internal reasoning about MG-300 blocks...' },
                  { text: '{"ok":true,"from":"non-thought-part"}' },
                ],
              },
            },
          ],
        });
      }

      return makeJsonResponse({}, 500);
    };

    const client = new GeminiClient({
      apiKeys: ['REVOKED_KEY', 'VALID_KEY'],
      fetchFn: fetchMock,
    });
    const res = await client.generateJson<{ ok: boolean; from: string }>({
      systemInstruction: 'sys',
      userPrompt: 'usr',
      thinkingBudget: 0,
      maxOutputTokens: 640,
    });
    expect(res).toEqual({ ok: true, from: 'non-thought-part' });
    // REVOKED_KEY only hit 3.8-flash once (skipped 3.6-flash immediately on 403)
    expect(calls.filter((c) => c.apiKey === 'REVOKED_KEY')).toHaveLength(1);
    // VALID_KEY retried on 3.8-flash with bumped maxOutputTokens >= 2048
    const validCalls = calls.filter((c) => c.apiKey === 'VALID_KEY');
    expect(validCalls).toHaveLength(2);
    expect(validCalls[0]!.maxOutputTokens).toBe(640);
    expect(Number(validCalls[1]!.maxOutputTokens)).toBeGreaterThanOrEqual(2048);

    // HTTP 400 mentioning "maxOutputTokens" must NOT be misclassified as 429 AI_QUOTA_EXHAUSTED
    const nonQuotaTokenClient = new GeminiClient({
      apiKeys: ['KEY_X'],
      fetchFn: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/models')) {
          return makeJsonResponse({
            models: [
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            ],
          });
        }
        return makeJsonResponse(
          { error: { code: 400, message: 'Invalid value for maxOutputTokens: exceeds token limit' } },
          400,
        );
      },
    });
    await expect(
      nonQuotaTokenClient.generateJson({ systemInstruction: 's', userPrompt: 'u' }),
    ).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      statusCode: 503,
    });

    // Auto .env reload when process.env keys are empty
    const prevKey1 = process.env.GEMINI_API_KEY;
    const prevKey2 = process.env.GEMINI_API_KEY_2;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY_2;
    let loadCalls = 0;
    try {
      const reloadClient = new GeminiClient({
        loadEnvFn: () => {
          loadCalls += 1;
          process.env.GEMINI_API_KEY = 'RELOADED_KEY';
          return ['/.env'];
        },
        fetchFn: async (input, init) => {
          const url = typeof input === 'string' ? input : input.toString();
          const apiKey = new Headers(init?.headers).get('x-goog-api-key');
          expect(apiKey).toBe('RELOADED_KEY');
          if (url.endsWith('/models')) {
            return makeJsonResponse({
              models: [
                { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
              ],
            });
          }
          return makeJsonResponse({
            candidates: [{ content: { parts: [{ text: '{"reloaded":true}' }] } }],
          });
        },
      });
      const reloaded = await reloadClient.generateJson<{ reloaded: boolean }>({
        systemInstruction: 's',
        userPrompt: 'u',
      });
      expect(reloaded).toEqual({ reloaded: true });
      expect(loadCalls).toBe(1);
    } finally {
      if (prevKey1 === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey1;
      if (prevKey2 === undefined) delete process.env.GEMINI_API_KEY_2;
      else process.env.GEMINI_API_KEY_2 = prevKey2;
    }
  });

  it('normalizes permissive Gemini numeric payloads (null optionals, out-of-range iv/name, bpm=0 in edit_existing) and covers Room/Modulate/partial AMP 2', async () => {
    const existing = buildMg300Struct102({
      name: 'Existing 4D',
      patchVolume: 52,
      irVolume: 20,
    });
    existing[0x64] = 136; // Existing BPM = 136
    // Pre-existing high DLY/RVB that must stay untouched when edit_existing omits DLY/RVB
    existing[0x03] = 2; // AMP 2 Deluxe Rvb
    existing.set([40, 0, 62, 50, 52, 58], 0x1a);
    existing[0x07] = 4;
    existing.set([48, 52, 48, 0, 0, 0], 0x36);
    existing[0x08] = 2;
    existing.set([50, 74, 25, 40, 0, 0], 0x3d);
    adapter.flashSlots.set(15, existing);

    const baseline = resolveCalibrationBaseline({});

    // 1. AMP 2 partial packed array [65, 72] updates Gain and Level (0x1c) without dropping Level,
    //    and untouched DLY/RVB stay preserved in edit_existing
    const partialAmp2 = buildAndCalibrateStruct102({
      existingStruct: existing,
      baseline,
      userPrompt: 'Aumentar ganho e volume do Deluxe Reverb',
      plan: {
        intent: 'edit_existing',
        presetName: 'Existing 4D',
        blocks: {
          AMP: { modelId: 2, params: [65, 72] },
        },
      },
    });
    expect(partialAmp2.struct102[0x1a]).toBe(65); // Gain
    expect(partialAmp2.struct102[0x1b]).toBe(0); // Undeclared p1 stays 0
    expect(partialAmp2.struct102[0x1c]).toBe(72); // Level mapped from packed index 1!
    expect(partialAmp2.struct102[0x1d]).toBe(50); // Bass preserved from existing
    expect(Array.from(partialAmp2.struct102.subarray(0x36, 0x39))).toEqual([48, 52, 48]); // DLY untouched
    expect(Array.from(partialAmp2.struct102.subarray(0x3d, 0x41))).toEqual([50, 74, 25, 40]); // RVB untouched

    // 2. RVB Room (id=1: p0=Mix, p1=Tone, p2=Decay) preserves Tone (0x3e) & clamps Decay (0x3f);
    //    DLY Modulate (id=3) clamps Mod (0x39 <= 30) on lead/solo requests
    const roomAndModulate = buildAndCalibrateStruct102({
      existingStruct: buildMg300Struct102({ name: 'Blank' }),
      baseline,
      userPrompt: 'Solo rock direto estilo AC/DC',
      plan: {
        intent: 'create_new',
        presetName: 'Rock Direct',
        blocks: {
          AMP: { modelId: 10, params: [62, 55, 65, 52, 64, 58] },
          DLY: { modelId: 3, params: [42, 45, 40, 75] }, // Modulate: Mod=75 -> <= 25
          RVB: { modelId: 1, params: [50, 68, 70] }, // Room: Mix=50, Tone=68, Decay=70
        },
      },
    });
    expect(roomAndModulate.struct102[0x39]).toBeLessThanOrEqual(30); // Modulate Mod <= 30
    expect(roomAndModulate.struct102[0x3d]).toBeLessThanOrEqual(22); // Room Mix clamped <= 22 (high-gain)
    expect(roomAndModulate.struct102[0x3e]).toBe(68); // Room Tone preserved!
    expect(roomAndModulate.struct102[0x3f]).toBeLessThanOrEqual(48); // Room Decay clamped <= 48

    // 3. Full /api/ai/tone/apply with null optionals, bpm: 0 in edit_existing, iv: 55, long name > 40 chars
    const permissiveGemini: GeminiClientLike = {
      async generateJson<T>(opts: GeminiGenerateJsonOptions): Promise<T> {
        const parsed = JSON.parse(opts.userPrompt) as { task?: string };
        if (parsed.task === 'validate_musician_gear') {
          return { recognized: true, pickupSummary: 'SSS', recommendations: [] } as T;
        }
        return {
          intent: 1,
          name: 'Super Long Preset Name Generated By Gemini Exceeding Forty Characters',
          bpm: 0,
          tf: null,
          pv: null,
          iv: 55,
          ic: 2,
          b: {
            '3': { m: 2, p: [58, 70] },
            '9': { m: 5, p: null },
          },
        } as T;
      },
    };

    app = createBackendApp({
      midiAdapter: adapter,
      experimentalEdit: true,
      experimentalBackupDir: backupDir,
      staticDir: null,
      includeFactoryPresets: false,
      geminiClient: permissiveGemini,
      aiGearPath: gearPath,
      aiCalibrationDir: calibrationDir,
    });
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
    await app.inject({
      method: 'PUT',
      url: '/api/ai/gear',
      payload: { guitarModel: 'Fender Stratocaster', outputTarget: 'PA' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/tone/apply',
      payload: { slotIndex: 15, prompt: 'Ajustar ganho do Deluxe' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bpm).toBe(136); // bpm: 0 did NOT overwrite existing BPM 136!
    expect(body.presetName.length).toBeLessThanOrEqual(18);
    expect(body.calibration.appliedIrVolume).toBe(40); // iv: 55 clamped safely to 40
    expect(adapter.getSlotStruct(15)[0x1c]).toBe(70); // AMP 2 Level applied from partial packed array
  });
});
