# Registro de Alterações — Etapa S02: Arquitetura, Contratos e Migração

- **Branch de origem:** `feat/s02-architecture-contracts`
- **Branch de integração:** `main`
- **Data:** 2026-11-28
- **Gate da etapa:** `PASS`

---

## 1. Objetivo e Escopo

Consolidar a arquitetura-alvo do **MG Control** (Electron standalone Windows x64 + Local Core Fastify/WS/MIDI/QuickTone + Cloud Backend modular `/v1` + PostgreSQL + Portal Web separado), versionar todos os contratos de fronteira (`v1.0`), criar o utilitário puro de migração não-destrutiva e anonimização de dados locais e validar tudo com testes unitários, de integração, de contrato e Code Review independente.

---

## 2. Commits Realizados na S02

1. `9a9bc0e` — `docs(architecture): documentar C4, ADRs 007-018, contratos v1 e plano de migracao S02`
2. `07e8675` — `feat(shared): adicionar contratos versionados v1 e utilitario de migracao local`
3. `cf5ba15` — `test(contracts): adicionar testes unitarios, de contrato e migracao da etapa S02`
4. Commit atual deste registro — `docs(changes): registrar o que foi feito na etapa S02`

---

## 3. Arquivos Criados e Alterados

### Documentação Arquitetural
- [C4-ARCHITECTURE.md](../architecture/C4-ARCHITECTURE.md) — Diagramas Mermaid C4 Níveis 1, 2 e 3 (contexto atual vs. alvo, containers, componentes internos) e tabela de ownership/limites estritos.
- [ADRS.md](../architecture/ADRS.md) — Registro dos `ADR-007` a `ADR-018`.
- [CONTRACTS.md](../architecture/CONTRACTS.md) — Especificação dos contratos IPC (`mg:v1:*`), Local Core REST/WS e Cloud REST `/v1`.
- [MIGRATION-AND-ROLLBACK.md](../architecture/MIGRATION-AND-ROLLBACK.md) — Sequência incremental `S02`→`S11`, matriz de variáveis de ambiente (sem segredos), migração não-destrutiva, migrations forward-safe e plano de rollback por camada.
- [TECHNICAL_DECISIONS.md](../TECHNICAL_DECISIONS.md) — Atualizado com referência aos `ADR-007`..`ADR-018`.

### Código (`@quicktone/shared`)
- [contracts-v1.ts](../../packages/shared/src/contracts-v1.ts) — Schemas Zod versionados (`CONTRACT_VERSION_V1 = '1.0'`), allowlist fechada `IPC_CHANNELS_V1`, `LocalCoreBootstrapEventV1Schema`, `UpdateManifestV1Schema`, `Auth*`, `AccountProfileV1Schema`, `AccountSummaryV1Schema`, `Device*` (`MAX_DEVICES_PER_ACCOUNT_V1 = 3`), `Credit*`, `AiGenerate*` (com validação por bloco do catálogo MG-300 e proteção contra `CAB=100` em `create_new`), `AiFeedbackRequestV1Schema`, `Checkout*`, `PaymentOrder*`, `WebhookNormalizedEventV1Schema` e `CloudApiErrorEnvelopeV1Schema`.
- [data-migration.ts](../../packages/shared/src/data-migration.ts) — Transformador puro não-destrutivo `migrateLocalStoragePayloadV1ToV2` (`mg300_webapp_storage_v1` → `mgcontrol_storage_v2`), planejador `planLocalDataDirectoryMigration` (`DISK_MIGRATION_RULES` com `overwrite: false`) e sanitizador `anonymizeLocalDataSnapshot`.
- [index.ts](../../packages/shared/src/index.ts) — Reexportação de `contracts-v1.js` e `data-migration.js`.

### Testes Adicionados
- [contracts-v1.test.ts](../../packages/shared/src/__tests__/contracts-v1.test.ts) — Validação unitária de schemas IPC, Auth, Account, Devices (máx. 3 ativos), Credits/Ledger, AI Proxy (limites de payload, catálogo por bloco, `CAB=100`, `usageMetadata`, feedback voluntário), Billing e Error Envelopes.
- [data-migration.test.ts](../../packages/shared/src/__tests__/data-migration.test.ts) — Anonimização de caminhos Windows/IPs LAN (`::ffff:`), migração idempotente v1→v2 com recuperação de dados corrompidos e planejamento de cópia para `userData`.
- [s02-contracts.test.ts](../../packages/backend/src/__tests__/s02-contracts.test.ts) — Contract tests `Local Core ↔ Electron` (HTTP/WS reais via `createBackendApp` + `MockMidiAdapter`), `Electron ↔ Cloud` (`AiGenerateResponseV1` compilado via `buildAndCalibrateStruct102` em frame SysEx `0x0E` válido) e `Portal ↔ Cloud`.

---

## 4. Decisões Consolidadas (`ADR-007` a `ADR-018`)

- **Empacotamento & Shell (`ADR-007`, `ADR-008`, `ADR-009`):** `electron-builder` NSIS Windows x64, compilação dos workspaces Node para JS (`dist/`), Renderer isolado (`contextIsolation=true`, `nodeIntegration=false`, `sandbox=true`, CSP) e Electron Main orquestrando o Local Core sem duplicar servidor nem deixar processos órfãos.
- **MIDI, Storage & LAN (`ADR-010`, `ADR-011`, `ADR-012`):** Preservação de `winmm.dll` e protocolo LAN `/ws` offline sem login, evolução para helper WinMM pré-compilado (S04), unificação de dados locais em `MG_DATA_DIR` (`%APPDATA%\MG Control\`) removendo caminhos pessoais hardcoded e fallback automático de portas `3001`..`3020`.
- **Cloud, Auth, Billing, IA & Distribuição (`ADR-013` a `ADR-018`):** Monólito modular Fastify + PostgreSQL (teto inicial ~R$150/mês sujeito à cotação), migrations forward-safe, DPAPI + limite atômico de 3 dispositivos, Stripe (cartão/Pix) + Mercado Pago (Pix fallback), ledger idempotente (3 créditos trial 30d + comprados sem vencimento), proxy Gemini server-side com medição obrigatória de `usageMetadata`/custo e kill switch, feedback voluntário e update via manifest/aviso + download HTTPS com SHA-256.

---

## 5. Validações e Code Review Independente

| Verificação | Resultado | Escopo |
|---|---|---|
| `npm run typecheck` | **PASS** (exit `0`) | 5/5 workspaces (`@quicktone/shared`, `@quicktone/reader`, `@quicktone/midi`, `@quicktone/backend`, `@quicktone/frontend`) |
| `npm run test` (`BypassSandbox: true`*) | **PASS** (exit `0`, `8.60s`) | **15/15 arquivos**, **151/151 testes** |
| `npm run test:e2e` (`BypassSandbox: true`*) | **PASS** (exit `0`, `4.0s`) | **4/4 testes** em `e2e/controller.spec.ts` |
| Code Review independente (`code-reviewer`) | **APROVADO** (Rodada 2) | `0 CRÍTICO`, `0 ALTO`, `0 MÉDIO`, `1 BAIXO` (item `BAIXO` residual em `migratedFromVersion` também corrigido e revalidado) |

*\*Em sandbox restrito no Windows, Vitest e Playwright falham com `EPERM` ao gravar em `node_modules\.vite-temp\` e `test-results\.last-run.json`.*
