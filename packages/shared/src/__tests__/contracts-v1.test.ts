import { describe, expect, it } from 'vitest';
import {
  AccountProfileV1Schema,
  AccountSummaryV1Schema,
  type AiTonePlanV1,
  AiFeedbackRequestV1Schema,
  AiGenerateRequestV1Schema,
  AiGenerateResponseV1Schema,
  ApiErrorEnvelopeV1Schema,
  AppInfoV1Schema,
  AuthLoginRequestV1Schema,
  AuthRefreshRequestV1Schema,
  AuthRegisterRequestV1Schema,
  AuthRegisterResponseV1Schema,
  AuthSessionResponseV1Schema,
  AuthVerifyEmailRequestV1Schema,
  CheckoutCreateRequestV1Schema,
  CheckoutCreateResponseV1Schema,
  CloudApiErrorEnvelopeV1Schema,
  CONTRACT_VERSION_V1,
  CreditLedgerEntryV1Schema,
  CreditSummaryResponseV1Schema,
  DeviceIdentityV1Schema,
  DeviceListResponseV1Schema,
  DeviceRegisterRequestV1Schema,
  DeviceRevokeResponseV1Schema,
  DiagnosticsExportResultV1Schema,
  IPC_CHANNELS_V1,
  IpcChannelV1Schema,
  LocalCoreBootstrapEventV1Schema,
  LocalCoreStatusV1Schema,
  MAX_DEVICES_PER_ACCOUNT_V1,
  OkResponseV1Schema,
  OpenExternalUrlRequestV1Schema,
  OpenExternalUrlResponseV1Schema,
  PaymentOrderRecordV1Schema,
  UpdateCheckResultV1Schema,
  UpdateManifestV1Schema,
  WebhookNormalizedEventV1Schema,
} from '../contracts-v1.js';

describe('@quicktone/shared — S02 Versioned Contracts v1', () => {
  it('validates all IPC allowlist channels, Electron shell schemas, and rejects non-HTTPS or arbitrary channels', () => {
    expect(CONTRACT_VERSION_V1).toBe('1.0');
    expect(IPC_CHANNELS_V1).toContain('mg:v1:core:get-status');
    expect(IpcChannelV1Schema.safeParse('mg:v1:app:get-info').success).toBe(true);
    expect(IpcChannelV1Schema.safeParse('fs:readFile').success).toBe(false);

    expect(
      OpenExternalUrlRequestV1Schema.safeParse({ url: 'https://mgcontrol.example/portal' }).success,
    ).toBe(true);
    expect(
      OpenExternalUrlRequestV1Schema.safeParse({ url: 'http://insecure.example' }).success,
    ).toBe(false);
    expect(
      OpenExternalUrlRequestV1Schema.safeParse({ url: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(OpenExternalUrlResponseV1Schema.safeParse({ opened: true }).success).toBe(true);
    expect(OkResponseV1Schema.safeParse({ ok: true }).success).toBe(true);

    expect(
      AppInfoV1Schema.safeParse({
        appName: 'MG Control',
        appVersion: '1.0.0',
        contractVersion: '1.0',
        platform: 'win32',
        arch: 'x64',
        dataDir: 'C:\\Users\\user\\AppData\\Roaming\\MG Control',
        isPackaged: true,
      }).success,
    ).toBe(true);

    expect(
      LocalCoreStatusV1Schema.safeParse({
        status: 'running',
        port: 3001,
        baseUrl: 'http://127.0.0.1:3001',
        lanUrls: ['http://192.168.1.50:3001'],
        restartCount: 0,
        lastError: null,
      }).success,
    ).toBe(true);

    expect(
      LocalCoreBootstrapEventV1Schema.safeParse({
        event: 'ready',
        contractVersion: '1.0',
        host: '0.0.0.0',
        port: 3001,
        lanUrls: ['http://192.168.1.50:3001'],
        pid: 4120,
        dataDir: 'C:\\Users\\user\\AppData\\Roaming\\MG Control',
        startedAt: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(true);

    expect(
      DiagnosticsExportResultV1Schema.safeParse({
        exportedPath: 'C:\\Users\\user\\AppData\\Roaming\\MG Control\\diag.zip',
        includedFiles: ['logs/midi-diagnostics.log'],
        sanitized: true,
        exportedAt: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(true);

    expect(
      DeviceIdentityV1Schema.safeParse({
        deviceKeyId: 'a'.repeat(32),
        deviceName: 'Estudio Principal',
        platform: 'win32',
        dpapiAvailable: true,
      }).success,
    ).toBe(true);

    const manifest = UpdateManifestV1Schema.parse({
      contractVersion: '1.0',
      version: '1.1.0',
      platform: 'win32',
      arch: 'x64',
      downloadUrl: 'https://cdn.mgcontrol.app/releases/MG-Control-Setup-1.1.0.exe',
      sha256: 'a'.repeat(64),
      publishedAt: '2026-11-28T01:00:00.000Z',
    });
    expect(
      UpdateCheckResultV1Schema.safeParse({
        currentVersion: '1.0.0',
        updateAvailable: true,
        manifest,
        checkedAt: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      UpdateManifestV1Schema.safeParse({
        ...manifest,
        downloadUrl: 'http://cdn.mgcontrol.app/setup.exe',
        sha256: 'short',
      }).success,
    ).toBe(false);
  });

  it('validates Auth, AccountSummaryV1, Device registration and max 3 active devices rule', () => {
    expect(
      AuthRegisterRequestV1Schema.safeParse({
        email: 'musico@example.com',
        password: 'StrongPassword123!',
      }).success,
    ).toBe(true);
    expect(
      AuthRegisterRequestV1Schema.safeParse({
        email: 'musico@example.com',
        password: 'short',
      }).success,
    ).toBe(false);
    expect(
      AuthRegisterResponseV1Schema.safeParse({ accepted: true, verificationSent: true }).success,
    ).toBe(true);
    expect(AuthVerifyEmailRequestV1Schema.safeParse({ token: 't'.repeat(24) }).success).toBe(true);
    expect(
      AuthLoginRequestV1Schema.safeParse({
        email: 'musico@example.com',
        password: 'StrongPassword123!',
      }).success,
    ).toBe(true);
    expect(AuthRefreshRequestV1Schema.safeParse({ refreshToken: 'r'.repeat(32) }).success).toBe(true);

    const account = AccountProfileV1Schema.parse({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'musico@example.com',
      emailVerified: true,
      locale: 'pt-BR',
      createdAt: '2026-11-28T01:00:00.000Z',
    });

    expect(
      AuthSessionResponseV1Schema.safeParse({
        account,
        tokens: {
          accessToken: 'a'.repeat(32),
          accessExpiresInSeconds: 900,
          refreshToken: 'r'.repeat(32),
          refreshExpiresAt: '2026-12-28T01:00:00.000Z',
        },
      }).success,
    ).toBe(true);

    expect(
      AccountSummaryV1Schema.safeParse({
        ...account,
        credits: {
          trialAvailable: 3,
          trialExpiresAt: '2026-12-28T01:00:00.000Z',
          purchasedAvailable: 10,
          reservedPending: 0,
          totalAvailable: 13,
        },
      }).success,
    ).toBe(true);

    expect(
      AccountProfileV1Schema.safeParse({
        ...account,
        presets: [],
      }).success,
    ).toBe(false);

    expect(
      DeviceRegisterRequestV1Schema.safeParse({
        deviceName: 'PC Casa',
        platform: 'win32',
        devicePublicKeyHash: 'f'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      DeviceRevokeResponseV1Schema.safeParse({
        ok: true,
        revokedAt: '2026-11-28T01:15:00.000Z',
      }).success,
    ).toBe(true);

    const makeDevice = (idx: number, status: 'active' | 'revoked') => ({
      deviceId: `00000000-0000-4000-8000-00000000000${idx}`,
      deviceName: `Studio PC ${idx}`,
      platform: 'win32' as const,
      status,
      registeredAt: '2026-11-28T01:00:00.000Z',
      lastSeenAt: '2026-11-28T01:10:00.000Z',
      revokedAt: status === 'revoked' ? '2026-11-28T01:15:00.000Z' : null,
    });

    expect(
      DeviceListResponseV1Schema.safeParse({
        maxDevices: MAX_DEVICES_PER_ACCOUNT_V1,
        devices: [
          makeDevice(1, 'active'),
          makeDevice(2, 'active'),
          makeDevice(3, 'active'),
          makeDevice(4, 'revoked'),
        ],
      }).success,
    ).toBe(true);

    expect(
      DeviceListResponseV1Schema.safeParse({
        maxDevices: MAX_DEVICES_PER_ACCOUNT_V1,
        devices: [
          makeDevice(1, 'active'),
          makeDevice(2, 'active'),
          makeDevice(3, 'active'),
          makeDevice(4, 'active'),
        ],
      }).success,
    ).toBe(false);
  });

  it('enforces bounded AI request payloads, partial typed AiTonePlanV1, catalog model validation, and User IR guard', () => {
    const partialPlan: AiTonePlanV1 = {
      intent: 'edit_existing',
      presetName: 'Solo Boost',
      blocks: {
        DLY: { modelId: 4, params: [44, 20, 22] },
      },
    };

    const baseReq = {
      idempotencyKey: 'gen-req-0000000000000001',
      deviceId: '11111111-1111-4111-8111-111111111111',
      slotIndex: 15,
      prompt: 'Timbre hard rock anos 80 com medio presente',
      gear: {
        guitarModel: 'Superstrat HSS',
        outputTarget: 'FRFR',
        pickupSummary: 'HSS',
      },
      baseline: {
        avgPatchVolume: 50,
        avgIrVolume: 20,
        avgAmpLevel: 65,
      },
      currentPreset: {
        presetName: 'Base Rock',
        bpm: 120,
        timeFlag: 0,
        irCut: 2,
        irVolume: 20,
        patchVolume: 55,
        blocks: {
          AMP: [12, 65, 55, 60, 62, 58, 52],
        },
      },
    };

    expect(AiGenerateRequestV1Schema.safeParse(baseReq).success).toBe(true);
    expect(AiGenerateRequestV1Schema.safeParse({ ...baseReq, slotIndex: 36 }).success).toBe(false);
    expect(
      AiGenerateRequestV1Schema.safeParse({
        ...baseReq,
        prompt: 'Grave no slot 2B com bastante drive',
      }).success,
    ).toBe(false);
    expect(
      AiGenerateRequestV1Schema.safeParse({
        ...baseReq,
        gear: { ...baseReq.gear, guitarModel: 'X'.repeat(200) },
      }).success,
    ).toBe(false);
    expect(
      AiGenerateRequestV1Schema.safeParse({
        ...baseReq,
        currentPreset: {
          ...baseReq.currentPreset,
          blocks: { INVALID_KEY: [1] },
        },
      }).success,
    ).toBe(false);

    const validResp = AiGenerateResponseV1Schema.safeParse({
      generationId: '22222222-2222-4222-8222-222222222222',
      idempotencyKey: 'gen-req-0000000000000001',
      plan: partialPlan,
      usage: {
        provider: 'gemini',
        modelId: 'models/gemini-3.8-flash',
        promptTokens: 1200,
        candidatesTokens: 140,
        thoughtsTokens: 0,
        totalTokens: 1340,
        latencyMs: 820,
        attempts: 1,
        estimatedCostUsd: 0.00042,
      },
      creditConsumed: 1,
      creditsRemaining: {
        trialAvailable: 2,
        trialExpiresAt: '2026-12-28T01:00:00.000Z',
        purchasedAvailable: 10,
        reservedPending: 0,
        totalAvailable: 12,
      },
      createdAt: '2026-11-28T01:00:00.000Z',
    });
    expect(validResp.success).toBe(true);

    // Rejects invalid modelId per block (e.g., COMP only has modelId 0..1)
    expect(
      AiGenerateResponseV1Schema.safeParse({
        ...(validResp.success ? validResp.data : {}),
        plan: {
          intent: 'create_new',
          presetName: 'Bad Model',
          blocks: { COMP: { modelId: 99 } },
        },
      }).success,
    ).toBe(false);

    // Rejects CAB=100 (User IR) when intent=create_new
    expect(
      AiGenerateResponseV1Schema.safeParse({
        ...(validResp.success ? validResp.data : {}),
        plan: {
          intent: 'create_new',
          presetName: 'Bad UserIR',
          blocks: { CAB: { modelId: 100 } },
        },
      }).success,
    ).toBe(false);

    expect(
      AiFeedbackRequestV1Schema.safeParse({
        generationId: '22222222-2222-4222-8222-222222222222',
        rating: 5,
        comment: 'Soou muito bem na caixa ativa.',
        voluntary: true,
      }).success,
    ).toBe(true);
    expect(
      AiFeedbackRequestV1Schema.safeParse({
        generationId: '22222222-2222-4222-8222-222222222222',
        rating: 5,
        voluntary: false,
      }).success,
    ).toBe(false);
  });

  it('validates Credit ledger (rejecting delta 0), Billing Card+Pix, PaymentOrder, Webhook, and Cloud Error Envelope', () => {
    expect(
      CreditLedgerEntryV1Schema.safeParse({
        entryId: '33333333-3333-4333-8333-333333333333',
        type: 'reserve',
        bucket: 'trial',
        delta: 0,
        idempotencyKey: 'zero-delta-invalid',
        referenceId: null,
        createdAt: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(false);

    expect(
      CreditSummaryResponseV1Schema.safeParse({
        balance: {
          trialAvailable: 3,
          trialExpiresAt: '2026-12-28T01:00:00.000Z',
          purchasedAvailable: 0,
          reservedPending: 0,
          totalAvailable: 3,
        },
        entries: [
          {
            entryId: '33333333-3333-4333-8333-333333333333',
            type: 'grant_trial',
            bucket: 'trial',
            delta: 3,
            idempotencyKey: 'trial-user-1111',
            referenceId: null,
            createdAt: '2026-11-28T01:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      CheckoutCreateRequestV1Schema.safeParse({
        packageId: 'pack_10_credits',
        paymentMethod: 'pix',
        currency: 'BRL',
        idempotencyKey: 'checkout-00000000000001',
        returnUrl: 'https://portal.mgcontrol.app/billing/return',
      }).success,
    ).toBe(true);
    expect(
      CheckoutCreateRequestV1Schema.safeParse({
        packageId: 'pack_10_credits',
        paymentMethod: 'pix',
        currency: 'BRL',
        idempotencyKey: 'checkout-00000000000001',
        returnUrl: 'http://portal.mgcontrol.app/billing/return',
      }).success,
    ).toBe(false);

    expect(
      CheckoutCreateResponseV1Schema.safeParse({
        orderId: '44444444-4444-4444-8444-444444444444',
        provider: 'mercado_pago',
        paymentMethod: 'pix',
        pixQrCode: 'base64-qr',
        pixCopyPaste: '00020126...',
        expiresAt: '2026-11-28T01:30:00.000Z',
      }).success,
    ).toBe(true);

    // Rejects checkout response with neither URL nor Pix QR payload
    expect(
      CheckoutCreateResponseV1Schema.safeParse({
        orderId: '44444444-4444-4444-8444-444444444444',
        provider: 'stripe',
        paymentMethod: 'card',
        expiresAt: '2026-11-28T01:30:00.000Z',
      }).success,
    ).toBe(false);

    expect(
      PaymentOrderRecordV1Schema.safeParse({
        orderId: '44444444-4444-4444-8444-444444444444',
        packageId: 'pack_10_credits',
        credits: 10,
        provider: 'stripe',
        paymentMethod: 'card',
        currency: 'BRL',
        amountMinor: 990,
        status: 'paid',
        createdAt: '2026-11-28T01:00:00.000Z',
        paidAt: '2026-11-28T01:02:00.000Z',
      }).success,
    ).toBe(true);

    expect(
      WebhookNormalizedEventV1Schema.safeParse({
        eventId: 'evt_stripe_123',
        provider: 'stripe',
        type: 'payment.succeeded',
        orderId: '44444444-4444-4444-8444-444444444444',
        amountMinor: 990,
        currency: 'BRL',
        receivedAt: '2026-11-28T01:05:00.000Z',
      }).success,
    ).toBe(true);

    expect(
      CloudApiErrorEnvelopeV1Schema.safeParse({
        code: 'AI_KILL_SWITCH_ACTIVE',
        message: 'Serviço de IA temporariamente pausado.',
        timestamp: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      CloudApiErrorEnvelopeV1Schema.safeParse({
        code: 'UNKNOWN_ARBITRARY_CODE',
        message: 'Erro inválido',
        timestamp: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      ApiErrorEnvelopeV1Schema.safeParse({
        code: 'LEGACY_LOCAL_CODE',
        message: 'Compatível com envelope local.',
        timestamp: '2026-11-28T01:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
