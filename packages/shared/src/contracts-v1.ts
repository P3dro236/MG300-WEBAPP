import { z } from 'zod';
import {
  AiDelayProfileSchema,
  AiMusicalPurposeSchema,
  AiToneIntentSchema,
} from './contracts.js';
import {
  MG300_USER_IR_CAB_ID,
  getMg300BlockCatalog,
  isValidMg300BlockModel,
} from './mg300-catalog.js';
import {
  MG300_USER_SLOT_MAX,
  MG300_USER_SLOT_MIN,
  containsForbiddenSlotMention,
} from './mg300-experimental.js';

export const CONTRACT_VERSION_V1 = '1.0' as const;
export const WS_LAN_PROTOCOL_VERSION_V1 = '1.0' as const;
export const MAX_DEVICES_PER_ACCOUNT_V1 = 3 as const;

const SemVerRegex = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const Sha256HexRegex = /^[0-9a-f]{64}$/i;

const HttpsUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL deve usar HTTPS.');

export const ApiErrorCodeV1Schema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'EMAIL_NOT_VERIFIED',
  'NOT_FOUND',
  'CONFLICT',
  'DEVICE_LIMIT_REACHED',
  'DEVICE_REVOKED',
  'INSUFFICIENT_CREDITS',
  'CREDITS_EXPIRED',
  'RATE_LIMITED',
  'AI_KILL_SWITCH_ACTIVE',
  'AI_BUDGET_EXCEEDED',
  'AI_UNAVAILABLE',
  'FACTORY_SLOT_PROTECTED',
  'SLOT_MENTION_FORBIDDEN',
  'PAYMENT_FAILED',
  'WEBHOOK_SIGNATURE_INVALID',
  'CORE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ApiErrorCodeV1 = z.infer<typeof ApiErrorCodeV1Schema>;

export const ApiErrorEnvelopeV1Schema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1).optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().datetime(),
});
export type ApiErrorEnvelopeV1 = z.infer<typeof ApiErrorEnvelopeV1Schema>;

export const CloudApiErrorEnvelopeV1Schema = ApiErrorEnvelopeV1Schema.extend({
  code: ApiErrorCodeV1Schema,
});
export type CloudApiErrorEnvelopeV1 = z.infer<typeof CloudApiErrorEnvelopeV1Schema>;

export const OkResponseV1Schema = z.object({
  ok: z.literal(true),
});
export type OkResponseV1 = z.infer<typeof OkResponseV1Schema>;

// ============================================================================
// Electron IPC Allowlist (Main <-> Preload <-> Renderer)
// ============================================================================

export const IPC_CHANNELS_V1 = [
  'mg:v1:app:get-info',
  'mg:v1:core:get-status',
  'mg:v1:core:restart',
  'mg:v1:diagnostics:export',
  'mg:v1:external:open-url',
  'mg:v1:update:check',
  'mg:v1:auth:get-session',
  'mg:v1:auth:set-session',
  'mg:v1:auth:clear-session',
  'mg:v1:device:get-identity',
] as const;

export const IpcChannelV1Schema = z.enum(IPC_CHANNELS_V1);
export type IpcChannelV1 = z.infer<typeof IpcChannelV1Schema>;

export const AppInfoV1Schema = z.object({
  appName: z.literal('MG Control'),
  appVersion: z.string().regex(SemVerRegex),
  contractVersion: z.literal(CONTRACT_VERSION_V1),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
  dataDir: z.string().min(1),
  isPackaged: z.boolean(),
});
export type AppInfoV1 = z.infer<typeof AppInfoV1Schema>;

export const LocalCoreLifecycleStateV1Schema = z.enum([
  'starting',
  'running',
  'restarting',
  'degraded',
  'stopped',
]);
export type LocalCoreLifecycleStateV1 = z.infer<typeof LocalCoreLifecycleStateV1Schema>;

export const LocalCoreStatusV1Schema = z.object({
  status: LocalCoreLifecycleStateV1Schema,
  port: z.number().int().min(1).max(65535).nullable(),
  baseUrl: z.string().url().nullable(),
  lanUrls: z.array(z.string().url()),
  restartCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type LocalCoreStatusV1 = z.infer<typeof LocalCoreStatusV1Schema>;

export const LocalCoreBootstrapEventV1Schema = z.object({
  event: z.literal('ready'),
  contractVersion: z.literal(CONTRACT_VERSION_V1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  lanUrls: z.array(z.string().url()),
  pid: z.number().int().positive(),
  dataDir: z.string().min(1),
  startedAt: z.string().datetime(),
});
export type LocalCoreBootstrapEventV1 = z.infer<typeof LocalCoreBootstrapEventV1Schema>;

export const OpenExternalUrlRequestV1Schema = z.object({
  url: HttpsUrlSchema,
});
export type OpenExternalUrlRequestV1 = z.infer<typeof OpenExternalUrlRequestV1Schema>;

export const OpenExternalUrlResponseV1Schema = z.object({
  opened: z.boolean(),
});
export type OpenExternalUrlResponseV1 = z.infer<typeof OpenExternalUrlResponseV1Schema>;

export const DiagnosticsExportResultV1Schema = z.object({
  exportedPath: z.string().min(1),
  includedFiles: z.array(z.string().min(1)),
  sanitized: z.literal(true),
  exportedAt: z.string().datetime(),
});
export type DiagnosticsExportResultV1 = z.infer<typeof DiagnosticsExportResultV1Schema>;

export const UpdateManifestV1Schema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION_V1),
  version: z.string().regex(SemVerRegex),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
  downloadUrl: HttpsUrlSchema,
  sha256: z.string().regex(Sha256HexRegex),
  publishedAt: z.string().datetime(),
  minSupportedVersion: z.string().regex(SemVerRegex).optional(),
  releaseNotesUrl: HttpsUrlSchema.optional(),
});
export type UpdateManifestV1 = z.infer<typeof UpdateManifestV1Schema>;

export const UpdateCheckResultV1Schema = z.object({
  currentVersion: z.string().regex(SemVerRegex),
  updateAvailable: z.boolean(),
  manifest: UpdateManifestV1Schema.nullable(),
  checkedAt: z.string().datetime(),
});
export type UpdateCheckResultV1 = z.infer<typeof UpdateCheckResultV1Schema>;

export const DeviceIdentityV1Schema = z.object({
  deviceKeyId: z.string().min(16).max(128),
  deviceName: z.string().trim().min(1).max(80),
  platform: z.literal('win32'),
  dpapiAvailable: z.boolean(),
});
export type DeviceIdentityV1 = z.infer<typeof DeviceIdentityV1Schema>;

// ============================================================================
// Cloud Auth, Account, Credits & Devices (/v1/auth/*, /v1/account, /v1/credits, /v1/devices)
// ============================================================================

export const CreditBucketTypeV1Schema = z.enum(['trial', 'purchased']);
export type CreditBucketTypeV1 = z.infer<typeof CreditBucketTypeV1Schema>;

export const CreditLedgerEntryTypeV1Schema = z.enum([
  'grant_trial',
  'grant_purchase',
  'reserve',
  'consume',
  'release',
  'expire',
  'refund_debit',
]);
export type CreditLedgerEntryTypeV1 = z.infer<typeof CreditLedgerEntryTypeV1Schema>;

export const CreditBalanceV1Schema = z.object({
  trialAvailable: z.number().int().nonnegative(),
  trialExpiresAt: z.string().datetime().nullable(),
  purchasedAvailable: z.number().int().nonnegative(),
  reservedPending: z.number().int().nonnegative(),
  totalAvailable: z.number().int().nonnegative(),
});
export type CreditBalanceV1 = z.infer<typeof CreditBalanceV1Schema>;

export const CreditLedgerEntryV1Schema = z.object({
  entryId: z.string().uuid(),
  type: CreditLedgerEntryTypeV1Schema,
  bucket: CreditBucketTypeV1Schema,
  delta: z.number().int().refine((n) => n !== 0, 'Delta não pode ser zero.'),
  idempotencyKey: z.string().min(8).max(128),
  referenceId: z.string().min(1).max(128).nullable(),
  createdAt: z.string().datetime(),
});
export type CreditLedgerEntryV1 = z.infer<typeof CreditLedgerEntryV1Schema>;

export const CreditSummaryResponseV1Schema = z.object({
  balance: CreditBalanceV1Schema,
  entries: z.array(CreditLedgerEntryV1Schema),
});
export type CreditSummaryResponseV1 = z.infer<typeof CreditSummaryResponseV1Schema>;

export const AuthRegisterRequestV1Schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
  locale: z.enum(['pt-BR', 'en-US']).default('pt-BR'),
});
export type AuthRegisterRequestV1 = z.infer<typeof AuthRegisterRequestV1Schema>;

export const AuthRegisterResponseV1Schema = z.object({
  accepted: z.literal(true),
  verificationSent: z.literal(true),
});
export type AuthRegisterResponseV1 = z.infer<typeof AuthRegisterResponseV1Schema>;

export const AuthVerifyEmailRequestV1Schema = z.object({
  token: z.string().trim().min(20).max(256),
});
export type AuthVerifyEmailRequestV1 = z.infer<typeof AuthVerifyEmailRequestV1Schema>;

export const AuthLoginRequestV1Schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});
export type AuthLoginRequestV1 = z.infer<typeof AuthLoginRequestV1Schema>;

export const AuthRefreshRequestV1Schema = z.object({
  refreshToken: z.string().trim().min(24).max(512),
});
export type AuthRefreshRequestV1 = z.infer<typeof AuthRefreshRequestV1Schema>;

export const AuthLogoutRequestV1Schema = z.object({
  refreshToken: z.string().trim().min(24).max(512).optional(),
});
export type AuthLogoutRequestV1 = z.infer<typeof AuthLogoutRequestV1Schema>;

export const AuthTokensV1Schema = z.object({
  accessToken: z.string().min(20),
  accessExpiresInSeconds: z.number().int().positive().max(3600),
  refreshToken: z.string().min(24),
  refreshExpiresAt: z.string().datetime(),
});
export type AuthTokensV1 = z.infer<typeof AuthTokensV1Schema>;

export const AccountProfileV1Schema = z
  .object({
    userId: z.string().uuid(),
    email: z.string().email(),
    emailVerified: z.boolean(),
    locale: z.enum(['pt-BR', 'en-US']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AccountProfileV1 = z.infer<typeof AccountProfileV1Schema>;

export const AccountSummaryV1Schema = AccountProfileV1Schema.extend({
  credits: CreditBalanceV1Schema,
}).strict();
export type AccountSummaryV1 = z.infer<typeof AccountSummaryV1Schema>;

export const AuthSessionResponseV1Schema = z.object({
  account: AccountProfileV1Schema,
  tokens: AuthTokensV1Schema,
});
export type AuthSessionResponseV1 = z.infer<typeof AuthSessionResponseV1Schema>;

export const DeviceRegisterRequestV1Schema = z.object({
  deviceName: z.string().trim().min(1).max(80),
  platform: z.literal('win32'),
  devicePublicKeyHash: z.string().regex(Sha256HexRegex),
  auxFingerprintHash: z.string().regex(Sha256HexRegex).optional(),
});
export type DeviceRegisterRequestV1 = z.infer<typeof DeviceRegisterRequestV1Schema>;

export const DeviceRecordV1Schema = z.object({
  deviceId: z.string().uuid(),
  deviceName: z.string().min(1).max(80),
  platform: z.literal('win32'),
  status: z.enum(['active', 'revoked']),
  registeredAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type DeviceRecordV1 = z.infer<typeof DeviceRecordV1Schema>;

export const DeviceListResponseV1Schema = z
  .object({
    maxDevices: z.literal(MAX_DEVICES_PER_ACCOUNT_V1),
    devices: z.array(DeviceRecordV1Schema),
  })
  .refine(
    (data) =>
      data.devices.filter((d) => d.status === 'active').length <= MAX_DEVICES_PER_ACCOUNT_V1,
    {
      message: `Limite máximo de ${MAX_DEVICES_PER_ACCOUNT_V1} dispositivos ativos excedido.`,
      path: ['devices'],
    },
  );
export type DeviceListResponseV1 = z.infer<typeof DeviceListResponseV1Schema>;

export const DeviceRevokeResponseV1Schema = z.object({
  ok: z.literal(true),
  revokedAt: z.string().datetime(),
});
export type DeviceRevokeResponseV1 = z.infer<typeof DeviceRevokeResponseV1Schema>;

// ============================================================================
// Cloud AI Proxy & Feedback (/v1/ai/generate, /v1/ai/feedback)
// ============================================================================

export const Mg300BlockCodeV1Schema = z.enum([
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
export type Mg300BlockCodeV1 = z.infer<typeof Mg300BlockCodeV1Schema>;

export const AiToneBlockDirectiveV1Schema = z.object({
  modelId: z.number().int().min(0).max(MG300_USER_IR_CAB_ID),
  params: z.array(z.number().int().min(0).max(100)).max(6).optional(),
});
export type AiToneBlockDirectiveV1 = z.infer<typeof AiToneBlockDirectiveV1Schema>;

export const AiToneBlocksV1Schema = z
  .object({
    COMP: AiToneBlockDirectiveV1Schema.optional(),
    EFX: AiToneBlockDirectiveV1Schema.optional(),
    AMP: AiToneBlockDirectiveV1Schema.optional(),
    EQ: AiToneBlockDirectiveV1Schema.optional(),
    NR: AiToneBlockDirectiveV1Schema.optional(),
    MOD: AiToneBlockDirectiveV1Schema.optional(),
    DLY: AiToneBlockDirectiveV1Schema.optional(),
    RVB: AiToneBlockDirectiveV1Schema.optional(),
    CAB: AiToneBlockDirectiveV1Schema.optional(),
    MIC: AiToneBlockDirectiveV1Schema.optional(),
  })
  .strict();
export type AiToneBlocksV1 = z.infer<typeof AiToneBlocksV1Schema>;

export const AiTonePlanV1Schema = z
  .object({
    intent: AiToneIntentSchema,
    presetName: z.string().trim().min(1).max(18),
    musicalPurpose: AiMusicalPurposeSchema.optional(),
    delayProfile: AiDelayProfileSchema.optional(),
    duplicateDelayDirectives: z.number().int().nonnegative().optional(),
    bpm: z.number().int().min(40).max(240).optional(),
    timeFlag: z.number().int().min(0).max(1).optional(),
    irCut: z.number().int().min(0).max(2).optional(),
    irVolume: z.number().int().min(0).max(40).optional(),
    patchVolume: z.number().int().min(0).max(100).optional(),
    blocks: AiToneBlocksV1Schema,
  })
  .superRefine((plan, ctx) => {
    for (const [blockCode, directive] of Object.entries(plan.blocks)) {
      if (!directive) {
        continue;
      }
      const blockMeta = getMg300BlockCatalog(blockCode);
      if (!blockMeta || !isValidMg300BlockModel(blockMeta.cc, directive.modelId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', blockCode, 'modelId'],
          message: `Modelo ${directive.modelId} inválido para o bloco ${blockCode} da NUX MG-300.`,
        });
      }
      if (
        blockCode === 'CAB' &&
        plan.intent === 'create_new' &&
        directive.modelId === MG300_USER_IR_CAB_ID
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', 'CAB', 'modelId'],
          message: 'User IR (CAB=100) não é permitido em criação do zero (intent=create_new).',
        });
      }
    }
  });
export type AiTonePlanV1 = z.infer<typeof AiTonePlanV1Schema>;

export const AiToneBaselineV1Schema = z.object({
  avgPatchVolume: z.number().min(0).max(100),
  avgIrVolume: z.number().min(0).max(40),
  avgAmpLevel: z.number().min(0).max(100),
});
export type AiToneBaselineV1 = z.infer<typeof AiToneBaselineV1Schema>;

const BoundedPresetBlockKeyV1Schema = z.union([
  z.enum(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']),
  Mg300BlockCodeV1Schema,
]);

export const AiGenerateRequestV1Schema = z.object({
  idempotencyKey: z.string().trim().min(16).max(128),
  deviceId: z.string().uuid(),
  slotIndex: z
    .number()
    .int()
    .min(MG300_USER_SLOT_MIN, 'Apenas slots de Usuário (0..35) são permitidos.')
    .max(MG300_USER_SLOT_MAX, 'Slots de Fábrica (36..71) são protegidos.'),
  prompt: z
    .string()
    .trim()
    .min(3)
    .max(600)
    .superRefine((value, ctx) => {
      const forbidden = containsForbiddenSlotMention(value);
      if (forbidden !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Menção proibida a slot/preset ("${forbidden}") no prompt.`,
        });
      }
    }),
  gear: z.object({
    guitarModel: z.string().trim().min(2).max(100),
    outputTarget: z.string().trim().max(120),
    pickupSummary: z.string().trim().min(1).max(120),
  }),
  baseline: AiToneBaselineV1Schema,
  currentPreset: z
    .object({
      presetName: z.string().trim().max(18),
      bpm: z.number().int().min(40).max(240),
      timeFlag: z.number().int().min(0).max(1),
      irCut: z.number().int().min(0).max(2),
      irVolume: z.number().int().min(0).max(40),
      patchVolume: z.number().int().min(0).max(100),
      hasUserIr: z.boolean().optional(),
      blocks: z
        .record(
          BoundedPresetBlockKeyV1Schema,
          z.array(z.number().int().min(0).max(127)).max(7),
        )
        .refine((obj) => Object.keys(obj).length <= 10, 'Máximo de 10 blocos permitido.'),
    })
    .optional(),
});
export type AiGenerateRequestV1 = z.infer<typeof AiGenerateRequestV1Schema>;

export const AiUsageMetricsV1Schema = z.object({
  provider: z.literal('gemini'),
  modelId: z.string().min(1),
  promptTokens: z.number().int().nonnegative(),
  candidatesTokens: z.number().int().nonnegative(),
  thoughtsTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  estimatedCostUsd: z.number().nonnegative(),
});
export type AiUsageMetricsV1 = z.infer<typeof AiUsageMetricsV1Schema>;

export const AiGenerateResponseV1Schema = z.object({
  generationId: z.string().uuid(),
  idempotencyKey: z.string().min(16).max(128),
  plan: AiTonePlanV1Schema,
  usage: AiUsageMetricsV1Schema,
  creditConsumed: z.union([z.literal(0), z.literal(1)]),
  creditsRemaining: CreditBalanceV1Schema,
  createdAt: z.string().datetime(),
});
export type AiGenerateResponseV1 = z.infer<typeof AiGenerateResponseV1Schema>;

export const AiFeedbackRequestV1Schema = z.object({
  generationId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
  voluntary: z.literal(true),
});
export type AiFeedbackRequestV1 = z.infer<typeof AiFeedbackRequestV1Schema>;

// ============================================================================
// Billing & Portal (/v1/payments/*, /v1/webhooks/:provider)
// ============================================================================

export const PaymentProviderV1Schema = z.enum(['stripe', 'mercado_pago']);
export type PaymentProviderV1 = z.infer<typeof PaymentProviderV1Schema>;

export const PaymentMethodV1Schema = z.enum(['card', 'pix']);
export type PaymentMethodV1 = z.infer<typeof PaymentMethodV1Schema>;

export const CurrencyCodeV1Schema = z.enum(['BRL', 'USD']);
export type CurrencyCodeV1 = z.infer<typeof CurrencyCodeV1Schema>;

export const CreditPackageV1Schema = z.object({
  packageId: z.string().min(1).max(64),
  credits: z.number().int().positive(),
  currency: CurrencyCodeV1Schema,
  amountMinor: z.number().int().positive(),
  active: z.boolean(),
});
export type CreditPackageV1 = z.infer<typeof CreditPackageV1Schema>;

export const CheckoutCreateRequestV1Schema = z.object({
  packageId: z.string().trim().min(1).max(64),
  paymentMethod: PaymentMethodV1Schema,
  currency: CurrencyCodeV1Schema,
  idempotencyKey: z.string().trim().min(16).max(128),
  returnUrl: HttpsUrlSchema,
});
export type CheckoutCreateRequestV1 = z.infer<typeof CheckoutCreateRequestV1Schema>;

export const CheckoutCreateResponseV1Schema = z
  .object({
    orderId: z.string().uuid(),
    provider: PaymentProviderV1Schema,
    paymentMethod: PaymentMethodV1Schema,
    checkoutUrl: HttpsUrlSchema.optional(),
    pixQrCode: z.string().min(1).optional(),
    pixCopyPaste: z.string().min(1).optional(),
    expiresAt: z.string().datetime(),
  })
  .superRefine((resp, ctx) => {
    const hasUrl = Boolean(resp.checkoutUrl);
    const hasPixPayload = Boolean(resp.pixQrCode && resp.pixCopyPaste);
    if (!hasUrl && !hasPixPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Checkout deve conter checkoutUrl ou par pixQrCode + pixCopyPaste.',
      });
    }
    if (resp.paymentMethod === 'card' && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkoutUrl'],
        message: 'Checkout com cartão exige checkoutUrl.',
      });
    }
  });
export type CheckoutCreateResponseV1 = z.infer<typeof CheckoutCreateResponseV1Schema>;

export const PaymentOrderStatusV1Schema = z.enum([
  'pending',
  'paid',
  'expired',
  'failed',
  'refunded',
  'disputed',
]);
export type PaymentOrderStatusV1 = z.infer<typeof PaymentOrderStatusV1Schema>;

export const PaymentOrderRecordV1Schema = z.object({
  orderId: z.string().uuid(),
  packageId: z.string().min(1),
  credits: z.number().int().positive(),
  provider: PaymentProviderV1Schema,
  paymentMethod: PaymentMethodV1Schema,
  currency: CurrencyCodeV1Schema,
  amountMinor: z.number().int().positive(),
  status: PaymentOrderStatusV1Schema,
  createdAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
});
export type PaymentOrderRecordV1 = z.infer<typeof PaymentOrderRecordV1Schema>;

export const WebhookNormalizedEventV1Schema = z.object({
  eventId: z.string().min(1).max(256),
  provider: PaymentProviderV1Schema,
  type: z.enum([
    'payment.succeeded',
    'payment.failed',
    'payment.expired',
    'payment.refunded',
    'payment.disputed',
  ]),
  orderId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeV1Schema,
  receivedAt: z.string().datetime(),
});
export type WebhookNormalizedEventV1 = z.infer<typeof WebhookNormalizedEventV1Schema>;
