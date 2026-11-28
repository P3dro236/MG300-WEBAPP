import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AccountSummaryV1Schema,
  AiFeedbackRequestV1Schema,
  AiGenerateRequestV1Schema,
  AiGenerateResponseV1Schema,
  CheckoutCreateRequestV1Schema,
  CheckoutCreateResponseV1Schema,
  ControllerStateSchema,
  CreditSummaryResponseV1Schema,
  DeviceListResponseV1Schema,
  HealthResponseSchema,
  LocalCoreBootstrapEventV1Schema,
  PairingStatusResponseSchema,
  PresetsResponseSchema,
  UpdateManifestV1Schema,
  WebhookNormalizedEventV1Schema,
  WsServerMessageSchema,
  buildMg300PresetWriteSysEx,
  isExperimentalPresetWriteSysEx,
} from '@quicktone/shared';
import { MockMidiAdapter } from '@quicktone/midi';
import { buildMg300Struct102 } from '@quicktone/reader';
import { createBackendApp, type QuickToneBackendApp } from '../app.js';
import { buildAndCalibrateStruct102, resolveCalibrationBaseline } from '../ai/tone-calibrator.js';

describe('S02 Contract Tests — Local Core <-> Electron, Electron <-> Cloud, Portal <-> Cloud', () => {
  let app: QuickToneBackendApp | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('Local Core <-> Electron: preserves offline REST/WS LAN contracts and validates bootstrap handshake', async () => {
    const adapter = new MockMidiAdapter({ autoConfirmHardware: false });
    app = createBackendApp({
      midiAdapter: adapter,
      staticDir: null,
      includeFactoryPresets: true,
      autoConnectMidiOnInit: true,
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const parsedUrl = new URL(address);
    const port = Number(parsedUrl.port);

    const bootstrap = LocalCoreBootstrapEventV1Schema.parse({
      event: 'ready',
      contractVersion: '1.0',
      host: '127.0.0.1',
      port,
      lanUrls: [`http://127.0.0.1:${port}`],
      pid: process.pid,
      dataDir: 'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control',
      startedAt: new Date().toISOString(),
    });
    expect(bootstrap.port).toBe(port);

    const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(healthRes.json()).status).toBe('ok');

    const statusRes = await app.inject({ method: 'GET', url: '/api/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(ControllerStateSchema.parse(statusRes.json()).connectionState).toBe('connected');

    const presetsRes = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(presetsRes.statusCode).toBe(200);
    expect(PresetsResponseSchema.parse(presetsRes.json()).presets.length).toBeGreaterThan(0);

    const pairingRes = await app.inject({ method: 'GET', url: '/api/pairing/status' });
    expect(pairingRes.statusCode).toBe(200);
    expect(PairingStatusResponseSchema.parse(pairingRes.json()).isLocalDesktop).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      const firstFrame = await new Promise<unknown>((resolve, reject) => {
        ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
        ws.once('error', reject);
      });
      const parsedWs = WsServerMessageSchema.parse(firstFrame);
      expect(parsedWs.type).toBe('state_sync');
    } finally {
      ws.close();
    }
  });

  it('Electron <-> Cloud (/v1): compiles Cloud AiGenerateResponseV1 plan into a valid MG-300 0x0E SysEx frame', () => {
    const request = AiGenerateRequestV1Schema.parse({
      idempotencyKey: 's02-contract-key-0001',
      deviceId: '11111111-1111-4111-8111-111111111111',
      slotIndex: 15,
      prompt: 'Clean cristalino estilo Stratocaster para base sem delay',
      gear: {
        guitarModel: 'Stratocaster SSS',
        outputTarget: 'FRFR',
        pickupSummary: 'SSS',
      },
      baseline: {
        avgPatchVolume: 50,
        avgIrVolume: 20,
        avgAmpLevel: 65,
      },
    });

    const cloudResponse = AiGenerateResponseV1Schema.parse({
      generationId: '22222222-2222-4222-8222-222222222222',
      idempotencyKey: request.idempotencyKey,
      plan: {
        intent: 'create_new',
        presetName: 'Strat Clean',
        musicalPurpose: 'clean_dry',
        delayProfile: 'NONE',
        bpm: 110,
        timeFlag: 0,
        irCut: 2,
        blocks: {
          COMP: { modelId: 1, params: [50, 50] },
          AMP: { modelId: 5, params: [32, 62, 50, 52, 54, 48] },
          DLY: { modelId: 4, params: [35, 25, 25] }, // Must be stripped by deterministic ambience validator
          RVB: { modelId: 2, params: [20, 35, 20, 30] },
          CAB: { modelId: 5 },
          MIC: { modelId: 1 },
        },
      },
      usage: {
        provider: 'gemini',
        modelId: 'models/gemini-3.8-flash',
        promptTokens: 980,
        candidatesTokens: 120,
        thoughtsTokens: 0,
        totalTokens: 1100,
        latencyMs: 640,
        attempts: 1,
        estimatedCostUsd: 0.00031,
      },
      creditConsumed: 1,
      creditsRemaining: {
        trialAvailable: 2,
        trialExpiresAt: '2026-12-28T01:00:00.000Z',
        purchasedAvailable: 0,
        reservedPending: 0,
        totalAvailable: 2,
      },
      createdAt: '2026-11-28T01:00:00.000Z',
    });

    const calibrated = buildAndCalibrateStruct102({
      plan: cloudResponse.plan,
      existingStruct: buildMg300Struct102({ name: 'Old 4D' }),
      baseline: resolveCalibrationBaseline({}),
      userPrompt: request.prompt,
    });

    expect(calibrated.struct102[0x07]).toBe(0); // Delay excluded deterministically
    const writeFrame = buildMg300PresetWriteSysEx(calibrated.struct102, request.slotIndex);
    expect(isExperimentalPresetWriteSysEx(writeFrame)).toBe(true);

    expect(
      AiFeedbackRequestV1Schema.safeParse({
        generationId: cloudResponse.generationId,
        rating: 5,
        voluntary: true,
      }).success,
    ).toBe(true);

    expect(
      UpdateManifestV1Schema.safeParse({
        contractVersion: '1.0',
        version: '1.0.1',
        platform: 'win32',
        arch: 'x64',
        downloadUrl: 'https://cdn.mgcontrol.app/win/MG-Control-1.0.1.exe',
        sha256: 'b'.repeat(64),
        publishedAt: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('Portal <-> Cloud (/v1): validates separated portal contracts for account summary, devices, credits, checkout and webhooks', () => {
    const account = AccountSummaryV1Schema.parse({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'guitarrista@example.com',
      emailVerified: true,
      locale: 'pt-BR',
      createdAt: '2026-11-28T01:00:00.000Z',
      credits: {
        trialAvailable: 3,
        trialExpiresAt: '2026-12-28T01:00:00.000Z',
        purchasedAvailable: 10,
        reservedPending: 0,
        totalAvailable: 13,
      },
    });
    expect(account.emailVerified).toBe(true);
    expect(account.credits.totalAvailable).toBe(13);

    const devices = DeviceListResponseV1Schema.parse({
      maxDevices: 3,
      devices: [
        {
          deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          deviceName: 'Notebook Windows',
          platform: 'win32',
          status: 'active',
          registeredAt: '2026-11-28T01:00:00.000Z',
          lastSeenAt: '2026-11-28T01:02:00.000Z',
          revokedAt: null,
        },
      ],
    });
    expect(devices.devices).toHaveLength(1);

    const credits = CreditSummaryResponseV1Schema.parse({
      balance: {
        trialAvailable: 3,
        trialExpiresAt: '2026-12-28T01:00:00.000Z',
        purchasedAvailable: 10,
        reservedPending: 0,
        totalAvailable: 13,
      },
      entries: [],
    });
    expect(credits.balance.totalAvailable).toBe(13);

    const checkoutReq = CheckoutCreateRequestV1Schema.parse({
      packageId: 'pack_10_credits',
      paymentMethod: 'card',
      currency: 'BRL',
      idempotencyKey: 'portal-order-0000000001',
      returnUrl: 'https://portal.mgcontrol.app/account/credits',
    });
    expect(checkoutReq.paymentMethod).toBe('card');

    const checkoutResp = CheckoutCreateResponseV1Schema.parse({
      orderId: '55555555-5555-4555-8555-555555555555',
      provider: 'stripe',
      paymentMethod: 'card',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      expiresAt: '2026-11-28T02:00:00.000Z',
    });

    const webhook = WebhookNormalizedEventV1Schema.parse({
      eventId: 'evt_123',
      provider: 'stripe',
      type: 'payment.succeeded',
      orderId: checkoutResp.orderId,
      amountMinor: 990,
      currency: 'BRL',
      receivedAt: '2026-11-28T01:05:00.000Z',
    });
    expect(webhook.type).toBe('payment.succeeded');
  });
});
