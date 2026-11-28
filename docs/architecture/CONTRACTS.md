# Especificação de Contratos Versionados (`v1.0`) — MG Control

> **Etapa:** S02 — Arquitetura, Contratos e Migração
> **Fonte de verdade em código:** [contracts-v1.ts](../../packages/shared/src/contracts-v1.ts) e [contracts.ts](../../packages/shared/src/contracts.ts)

---

## 1. Política de Versionamento e Compatibilidade

- **Versão de contrato:** `CONTRACT_VERSION_V1 = '1.0'`.
- **Regras dentro de `v1`:** apenas adições retrocompatíveis (campos opcionais, novos códigos de erro ou novos endpoints). Remoção/renomeação de campos obrigatórios ou mudança semântica exige `v2` (`/v2/*` ou `mg:v2:*`).
- **Envelope padrão de erro (`ApiErrorEnvelopeV1Schema` e `CloudApiErrorEnvelopeV1Schema` com `ApiErrorCodeV1Schema`):**
  ```json
  {
    "code": "STRING_CODE",
    "message": "Mensagem legível para o usuário",
    "requestId": "opcional-uuid-ou-trace",
    "retryAfterSeconds": 60,
    "details": {},
    "timestamp": "2026-11-28T00:00:00.000Z"
  }
  ```

---

## 2. Contratos IPC (`Electron Main ↔ Preload ↔ Renderer`)

Canais fechados em `IPC_CHANNELS_V1` (nenhum canal genérico permitido):

| Canal (`mg:v1:*`) | Direção | Request Schema | Response Schema |
|---|---|---|---|
| `mg:v1:app:get-info` | Renderer → Main | `void` | `AppInfoV1Schema` (`appVersion`, `platform: 'win32'`, `arch: 'x64'`, `dataDir`, `isPackaged`) |
| `mg:v1:core:get-status` | Renderer → Main | `void` | `LocalCoreStatusV1Schema` (`status`, `port`, `baseUrl`, `lanUrls`, `restartCount`, `lastError`) |
| `mg:v1:core:restart` | Renderer → Main | `void` | `LocalCoreStatusV1Schema` |
| `mg:v1:diagnostics:export` | Renderer → Main | `void` | `DiagnosticsExportResultV1Schema` (`exportedPath`, `includedFiles`, `sanitized: true`) |
| `mg:v1:external:open-url` | Renderer → Main | `OpenExternalUrlRequestV1Schema` (somente `https://`) | `OpenExternalUrlResponseV1Schema` (`{ opened: boolean }`) |
| `mg:v1:update:check` | Renderer → Main | `void` | `UpdateCheckResultV1Schema` (inclui `UpdateManifestV1Schema` com SemVer, `https://`, SHA-256 64 hex) |
| `mg:v1:auth:get-session` | Renderer → Main | `void` | `AuthSessionResponseV1Schema \| null` |
| `mg:v1:auth:set-session` | Renderer → Main | `AuthSessionResponseV1Schema` (armazenado via DPAPI) | `OkResponseV1Schema` (`{ ok: true }`) |
| `mg:v1:auth:clear-session` | Renderer → Main | `void` | `OkResponseV1Schema` (`{ ok: true }`) |
| `mg:v1:device:get-identity` | Renderer → Main | `void` | `DeviceIdentityV1Schema` (`deviceKeyId`, `deviceName`, `dpapiAvailable`) |

**Handshake Local Core → Electron Main:** `LocalCoreBootstrapEventV1Schema` (`event: 'ready'`, `contractVersion`, `host`, `port`, `lanUrls`, `pid`, `dataDir`, `startedAt`).

---

## 3. Contratos do Local Core (`REST /api/*` & `WebSocket /ws`)

Preserva integralmente os contratos existentes em [contracts.ts](../../packages/shared/src/contracts.ts) para manter 100% da LAN offline intacta:
- **HTTP:** `HealthResponseSchema`, `ControllerStateSchema`, `PresetsResponseSchema`, `SelectPresetRequestSchema`, `UpdateVolumeRequestSchema`, `PairingStatusResponseSchema`, `ExperimentalEditStateSchema`, `AiGearConfigSchema`, `AiToneApplyRequestSchema`, `AiToneApplyResponseSchema`.
- **WebSocket (`/ws`, `WS_LAN_PROTOCOL_VERSION_V1 = '1.0'`):**
  - Client → Server (`WsClientMessageSchema`): `ping`, `request_sync`.
  - Server → Client (`WsServerMessageSchema`): `state_sync`, `presets_updated`, `pairing_updated` (somente desktop), `experimental_state_sync`, `gear_updated`, `error`, `pong`.

---

## 4. Contratos da Cloud API (`/v1`)

### 4.1 Auth, Conta e Dispositivos
| Rota | Request | Response | Regras |
|---|---|---|---|
| `POST /v1/auth/register` | `AuthRegisterRequestV1Schema` | `AuthRegisterResponseV1Schema` | Não enumera se e-mail já existe |
| `POST /v1/auth/verify-email` | `AuthVerifyEmailRequestV1Schema` | `AuthSessionResponseV1Schema` | Concede 3 créditos trial (30d) atomicamente |
| `POST /v1/auth/login` | `AuthLoginRequestV1Schema` | `AuthSessionResponseV1Schema` | Access curto + Refresh rotativo |
| `POST /v1/auth/refresh` | `AuthRefreshRequestV1Schema` | `AuthTokensV1Schema` | Rotaciona refresh e revoga reuso |
| `POST /v1/auth/logout` | `AuthLogoutRequestV1Schema` | `OkResponseV1Schema` | Revoga sessão refresh |
| `GET /v1/account` | Bearer Access | `AccountSummaryV1Schema` | Sem presets/MIDI; traz e-mail verificado e resumo `credits` (`CreditBalanceV1Schema`) |
| `GET /v1/devices` | Bearer Access | `DeviceListResponseV1Schema` | `maxDevices: 3`, lista devices ativos/revogados |
| `POST /v1/devices` | `DeviceRegisterRequestV1Schema` | `DeviceRecordV1Schema` | Registra `devicePublicKeyHash` (DPAPI); bloqueia 4º ativo com `409 DEVICE_LIMIT_REACHED` |
| `DELETE /v1/devices/:deviceId` | Bearer Access | `DeviceRevokeResponseV1Schema` | Revoga dispositivo e libera vaga |

### 4.2 Créditos & Ledger (`/v1/credits`)
- `GET /v1/credits` → `CreditSummaryResponseV1Schema`:
  - `balance`: `trialAvailable`, `trialExpiresAt`, `purchasedAvailable`, `reservedPending`, `totalAvailable`.
  - `entries`: `CreditLedgerEntryV1Schema[]` (`grant_trial`, `grant_purchase`, `reserve`, `consume`, `release`, `expire`, `refund_debit`).

### 4.3 Proxy IA & Feedback (`/v1/ai/*`)
- `POST /v1/ai/generate`:
  - **Request (`AiGenerateRequestV1Schema`):** `idempotencyKey`, `slotIndex` (`0..35` — rejeita Factory `36..71`), `prompt` (3..600 chars, validado por `containsForbiddenSlotMention`), `gear`, `baseline`, `currentPreset?`.
  - **Response (`AiGenerateResponseV1Schema`):** `generationId`, `idempotencyKey`, `plan` (`AiTonePlanV1Schema` compatível com `buildAndCalibrateStruct102`), `usage` (`AiUsageMetricsV1Schema`: `modelId`, `promptTokens`, `candidatesTokens`, `thoughtsTokens`, `totalTokens`, `latencyMs`, `attempts`, `estimatedCostUsd`), `creditConsumed` (`0 | 1`), `creditsRemaining`.
- `POST /v1/ai/feedback`:
  - **Request (`AiFeedbackRequestV1Schema`):** `generationId`, `rating` (`1..5`), `comment?` (max 500), `voluntary: true`.

### 4.4 Billing & Webhooks (`/v1/payments/*`, `/v1/webhooks/:provider`)
- `POST /v1/payments/checkout`:
  - **Request (`CheckoutCreateRequestV1Schema`):** `packageId`, `paymentMethod` (`card` | `pix`), `currency` (`BRL` | `USD`), `idempotencyKey`, `returnUrl` (`https://`).
  - **Response (`CheckoutCreateResponseV1Schema`):** `orderId`, `provider` (`stripe` | `mercado_pago`), `paymentMethod`, `checkoutUrl?`, `pixQrCode?`, `pixCopyPaste?`, `expiresAt`.
- `POST /v1/webhooks/:provider`:
  - Valida assinatura HMAC/header do provedor, normaliza para `WebhookNormalizedEventV1Schema` (`eventId`, `provider`, `type`, `orderId`, `amountMinor`, `currency`, `receivedAt`) e aplica idempotência estrita em `webhook_events`.
- `GET /v1/updates/manifest`:
  - Retorna `UpdateManifestV1Schema` (`version` SemVer, `downloadUrl` `https://`, `sha256` 64 hex, `publishedAt`, `releaseNotesUrl?`).
