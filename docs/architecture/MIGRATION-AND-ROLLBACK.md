# Plano Incremental de Migração, Ambientes e Rollback — MG Control

> **Etapa:** S02 — Arquitetura, Contratos e Migração
> **Fonte de verdade do helper:** [data-migration.ts](../../packages/shared/src/data-migration.ts)

---

## 1. Sequência Incremental de Migração (`S02` → `S11`)

| Fase | Escopo | Compatibilidade garantida | Critério de saída |
|---|---|---|---|
| **S02 (atual)** | ADRs, C4, contratos `contracts-v1.ts` e utilitário puro `data-migration.ts` em `@quicktone/shared` | Zero mudança disruptiva no fluxo web/LAN atual | Gate S02 PASS + Code Review |
| **S03** | Shell Electron Main + Preload + Build JS dos workspaces Node + `MG_DATA_DIR` (`userData`) | `npm start` web continua funcionando; migração automática não-destrutiva copia dados legados para `userData` | Abre sem terminal, zero órfãos, E2E Electron PASS |
| **S04** | Remoção de paths pessoais, empacotamento helper WinMM pré-compilado, validação LAN/Firewall | Protocolo `winmm.dll`, `QuickToneDiscoveryService` e `/ws` LAN preservados 100% | Smoke físico MG-300 + LAN offline PASS |
| **S05** | Cloud API Fastify + PostgreSQL + Auth + DPAPI + 3 devices | Local Core segue independente e offline sem conta | Migrations, auth e backup/restore PASS |
| **S06** | Proxy Gemini na Cloud + Ledger de créditos + medição real de custo | Compilador/calibrador local recebe `AiTonePlanV1` e gera idêntico `struct102` | Reserva/consumo/liberação idempotentes PASS |
| **S07** | Auditoria transversal de segurança + LGPD + DPAPI + CSP | Nenhuma degradação funcional offline | Zero achados Críticos/Altos |
| **S08** | Portal Web separado + Stripe/Mercado Pago (Cartão + Pix) + Webhooks | Desktop local permanece sem login obrigatório e sem checkout embutido | Compra Cartão/Pix + conciliação PASS |
| **S09** | Instalador Windows x64, SHA-256, version manifest, CI/CD | Upgrade/desinstalação preservam `%APPDATA%\MG Control\` | Teste em Windows limpo e 2º PC PASS |
| **S10–S11** | Landing `mg300.vercel.app` alinhada + Validação integrada e Go/No-Go | Todos os gates `S01`–`S10` verdes | Aprovação explícita de Pedro |

---

## 2. Configuração por Ambiente (Nomes de Variáveis — Sem Segredos)

| Variável | Local / Dev | Test (CI/Vitest/E2E) | Staging | Production | Escopo |
|---|---|---|---|---|---|
| `NODE_ENV` | `development` | `test` | `staging` | `production` | Todos |
| `HOST` / `PORT` | `0.0.0.0` / `3001` | `127.0.0.1` / `0` | `0.0.0.0` / `3001` | `0.0.0.0` / `3001` (fallback `3002..3020`) | Local Core |
| `MG_DATA_DIR` | `<repo>` (opcional) | `os.tmpdir()` | `%APPDATA%\MG Control` | `%APPDATA%\MG Control` | Local Core / Electron |
| `QUICKTONE_MIDI_ADAPTER` | `winmm` (ou `mock`) | `mock` | `winmm` | `winmm` | Local Core |
| `QUICKTONE_EXPERIMENTAL_EDIT` | `1` | `1` / param | `1` | `1` | Local Core |
| `MG_CLOUD_API_URL` | `http://127.0.0.1:4000` | mock/local | `https://api-stg.<dominio>` | `https://api.<dominio>` | Electron Main |
| `MG_UPDATE_MANIFEST_URL` | opcional | mock | `https://<cdn>/staging/manifest.json` | `https://<cdn>/manifest.json` | Electron Main |
| `DATABASE_URL` | local pg | test pg / container | secret manager | secret manager | Cloud API |
| `JWT_ACCESS_SECRET` / `REFRESH_PEPPER` | dev-only | test-only | secret manager | secret manager | Cloud API |
| `GEMINI_API_KEY` / `GEMINI_API_KEY_2` | `.env` dev (apenas até S06) | mock `fetchFn` | secret manager Cloud | secret manager Cloud | **Somente Cloud API pós-S06** |
| `AI_KILL_SWITCH` / `AI_DAILY_BUDGET_USD` | `false` / `5` | `false` | secret/config | config operacional | Cloud API |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | sandbox | mock | sandbox | secret manager | Cloud API |
| `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET` | sandbox | mock | sandbox | secret manager | Cloud API |
| `EMAIL_PROVIDER_API_KEY` / `EMAIL_FROM` | console/sandbox | mock | sandbox | secret manager | Cloud API |

---

## 3. Migração Não-Destrutiva de Dados Locais

Implementada no transformador puro [data-migration.ts](../../packages/shared/src/data-migration.ts) (cuja integração efetiva no browser e no bootstrap Electron ocorre na S03):
1. **Browser `localStorage` (`mg300_webapp_storage_v1` → `mgcontrol_storage_v2`):**
   - `migrateLocalStoragePayloadV1ToV2(rawV1Json)` transforma a string JSON legada de forma pura (`sourceUntouched: true`), valida cada item com `PresetSchema.safeParse`, remove placeholders (`User 1A..9D`) e preserva 100% dos presets e preferências válidos (`filter`, `viewMode`, `lastVolume`) para o formato `PersistedAppDataV2` (a leitura/gravação no `window.localStorage` ocorrerá na S03 mantendo a chave v1 intacta).
   - Em caso de entradas individuais corrompidas, descarta apenas os itens inválidos registrando `droppedCorruptEntries` e `warnings`, mantendo os demais presets intactos.
2. **Diretórios de Disco (`planLocalDataDirectoryMigration`):**
   - Planeja a cópia não-destrutiva (`overwrite: false`) de arquivos relativos a `packages/backend/` ou à raiz (`process.cwd()`) para `MG_DATA_DIR` (`%APPDATA%\MG Control\`):
     - `(packages/backend/)backups/*.json` → `<userData>/backups/`
     - `(packages/backend/)data/trusted-devices.json` → `<userData>/data/trusted-devices.json`
     - `data/user-gear.json` → `<userData>/data/user-gear.json`
     - `logs/midi-diagnostics.log` / `logs/midi-diagnostics.prev.log` → `<userData>/logs/`
3. **Anonimização para Testes (`anonymizeLocalDataSnapshot`):**
   - Mascara usernames Windows (`C:\Users\<nome>\...` → `C:\Users\REDACTED\...`), IPs privados (`192.168.x.y` → `192.0.2.10`), `deviceName` e `tokenHash` para permitir testes determinísticos sobre snapshots reais sem expor PII.

---

## 4. Política de Migrations PostgreSQL Forward-Safe (`S05+`)

Toda alteração de schema no PostgreSQL seguirá o ciclo **Expand → Backfill → Switch → Contract**:
1. **Expand:** Adicionar colunas anuláveis/com default, novas tabelas ou novos índices (`CREATE INDEX CONCURRENTLY` quando aplicável), compatíveis com a versão N-1 da API.
2. **Backfill:** Popular dados em lotes idempotentes sem locks longos.
3. **Switch:** Publicar nova versão da Cloud API lendo/escrevendo o novo formato.
4. **Contract:** Remover colunas/estruturas legadas apenas em release posterior, após janela de rollback confirmada.
- **Regras:** Nunca usar `synchronize: true` em produção; cada migration possui script `up` e procedimento documentado de contingência/restore.

---

## 5. Estratégia de Rollback por Camada

| Camada | Gatilho de Rollback | Procedimento Seguro (Sem Perda de Dados) |
|---|---|---|
| **Local Core / Electron** | Crash recorrente, regressão WinMM/LAN ou falha de IPC | Reinstalar versão anterior do instalador `.exe`; dados em `%APPDATA%\MG Control\` e `mg300_webapp_storage_v1` permanecem intactos porque a migração é por cópia (`overwrite: false`). |
| **Cloud API (`/v1`)** | Aumento de erro 5xx, latência ou falha em auth/créditos | Reverter binário/container para tag anterior mantendo o mesmo schema expandido (migrations forward-safe garantem compatibilidade N-1). |
| **IA Proxy (Gemini)** | Custo anômalo, erro em lote ou resposta inválida | Ativar `AI_KILL_SWITCH=true` imediatamente (`503 AI_KILL_SWITCH_ACTIVE`), liberando todas as reservas pendentes sem cobrar créditos e mantendo 100% das funções locais/MIDI/LAN operacionais. |
| **PostgreSQL** | Corrupção lógica ou falha grave pós-migration | Restaurar snapshot criptografado externo + WAL até o ponto imediatamente anterior e validar checklist de integridade do ledger. |
| **Billing / Webhooks** | Divergência de valores ou erro de gateway | Desativar checkout no Portal Web (flag), manter processamento idempotente de webhooks pendentes e reconciliar `payment_orders ↔ credit_ledger`. |
