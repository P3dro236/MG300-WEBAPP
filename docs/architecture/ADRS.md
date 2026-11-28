# Architecture Decision Records (ADRs) — MG Control (`ADR-007` a `ADR-018`)

> **Etapa:** S02 — Arquitetura, Contratos e Migração
> **Continuidade:** Dá sequência aos `ADR-001`..`ADR-006` registrados em [TECHNICAL_DECISIONS.md](../TECHNICAL_DECISIONS.md).

---

## Índice Consolidado

| ADR | Título | Status | Etapas Impactadas |
|---|---|---|---|
| **ADR-007** | Empacotamento Electron x64 e Build JS dos Workspaces Node | Aceito (S02) | S03, S09 |
| **ADR-008** | Isolamento do Renderer, Preload Allowlist e Navegação Restrita | Aceito (S02) | S03, S07 |
| **ADR-009** | Lifecycle, Supervisão e Shutdown do Local Core pelo Electron Main | Aceito (S02) | S03, S04 |
| **ADR-010** | Estratégia de Empacotamento WinMM MIDI sem Quebra de ABI | Aceito (S02) | S03, S04, S09 |
| **ADR-011** | Storage Local Unificado em `userData` e Remoção de Paths Pessoais | Aceito (S02) | S03, S04, S09 |
| **ADR-012** | Política de Portas, Bind LAN Offline e Descoberta Mobile | Aceito (S02) | S03, S04, S07 |
| **ADR-013** | Hosting Cloud Modular e Sizing Inicial sob Teto ~R$150/mês | Aceito c/ Cotação (S02) | S05, S11 |
| **ADR-014** | PostgreSQL, Migrations Forward-Safe e Backup/Restore Externo | Aceito (S02) | S05, S07, S11 |
| **ADR-015** | Autenticação, Refresh Rotativo, DPAPI e Limite de 3 Dispositivos | Aceito (S02) | S05, S07, S08 |
| **ADR-016** | Billing Cartão/Pix, Ledger Idempotente e Portal Web Separado | Aceito (S02) | S06, S08 |
| **ADR-017** | Proxy Gemini Server-Side, Escopo de IA, Custo e Feedback Voluntário | Aceito (S02) | S06, S07 |
| **ADR-018** | Distribuição Windows x64, SemVer e Aviso de Atualização | Aceito (S02) | S09, S10, S11 |

---

## ADR-007: Empacotamento Electron x64 e Build JS dos Workspaces Node
- **Contexto:** Hoje `npm run build` compila apenas `@quicktone/frontend`; os 4 pacotes Node (`shared`, `reader`, `midi`, `backend`) rodam TypeScript em runtime via `tsx` e não possuem `dist/`.
- **Decisão:** Adotar **`electron-builder`** visando alvo inicial Windows x64 (instalador NSIS per-user sem exigir privilégio administrativo obrigatório + build unpacked para testes automatizados). Compilar os pacotes Node para JS (`dist/`) via `tsc`/`tsup` (ou bundle dedicado do Local Core), eliminando `tsx` do pacote de produção.
- **Consequências:** Boot mais rápido, pacote menor, independência de Node/npm instalado no Windows do músico. Exige ajustar scripts `build` dos workspaces na S03/S09.

## ADR-008: Isolamento do Renderer, Preload Allowlist e Navegação Restrita
- **Contexto:** O app desktop servirá interface React local e fará autenticação Cloud via Electron Main, criando risco caso o Renderer seja comprometido.
- **Decisão:** Configurar toda `BrowserWindow` com `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, CSP estrito (`default-src 'self'`, `connect-src 'self' ws://127.0.0.1:* ws://localhost:*`, sem inline scripts), bloqueio de `will-navigate` e `setWindowOpenHandler` (links externos abrem via `shell.openExternal` somente após validação de URL `https://`). Preload expõe apenas os canais tipados `IPC_CHANNELS_V1` (`mg:v1:*`) validados por Zod.
- **Consequências:** Nenhuma API Node vaza para o browser; qualquer novo recurso nativo exige contrato versionado explícito.

## ADR-009: Lifecycle, Supervisão e Shutdown do Local Core pelo Electron Main
- **Contexto:** O núcleo local Fastify + WebSocket + MIDI já é estável e testado; reescrevê-lo dentro do Electron Main duplicaria estado e quebraria o fluxo LAN.
- **Decisão:** O Electron Main atua como **orquestrador único** (`app.requestSingleInstanceLock()`). Em produção, o Main inicia o Local Core compilado como processo filho gerenciado (`ELECTRON_RUN_AS_NODE=1` ou `utilityProcess`), monitora `/api/health`, reinicia automaticamente em crash inesperado com backoff exponencial (máximo 3 tentativas em 60 s antes de sinalizar estado degradado) e encerra o servidor graciosamente (`app.close()` + kill de árvore em timeout de 3 s) em `before-quit`/`will-quit`, garantindo zero processos órfãos (inclusive do worker WinMM).
- **Consequências:** Preserva 100% da arquitetura HTTP/WS do núcleo local e facilita testes isolados sem Electron.

## ADR-010: Estratégia de Empacotamento WinMM MIDI sem Quebra de ABI
- **Contexto:** A auditoria S01 comprovou que não há addon `.node` C++ no projeto; [winmm-adapter.ts](../../packages/midi-service/src/winmm-adapter.ts) usa C# P/Invoke sobre `winmm.dll`, compilado em runtime via `powershell.exe` + `Add-Type` em `%TEMP%`. Compilar em runtime em `%TEMP%` gera risco de bloqueio por antivírus/SmartScreen/AppLocker em Windows limpo.
- **Decisão:** Preservar integralmente a lógica de protocolo duplex `winmm.dll`, buffer SysEx (8×4096 B) e auto-recovery (`mmresult=1`) do `WinMmMidiAdapter`, evoluindo o transporte na S04 para **helper executável pré-compilado** em build (ex.: `mg-winmm-bridge.exe` em `extraResources` com protocolo JSON-lines stdin/stdout idêntico ao worker atual), mantendo fallback configurável apenas em dev se necessário. Nenhuma dependência de `node-gyp` ou rebuild de ABI Electron é introduzida.
- **Consequências:** Zero risco de incompatibilidade de ABI entre Node e Electron, cold start instantâneo sem `csc.exe`/`Add-Type` em máquina final, e assinatura digital possível junto ao instalador na S09.

## ADR-011: Storage Local Unificado em `userData` e Remoção de Paths Pessoais
- **Contexto:** A S01 identificou 6 caminhos graváveis espalhados (`process.cwd()`, `MONOREPO_ROOT`, `%TEMP%`, `localStorage`) e caminhos pessoais hardcoded (`C:\Users\pedro\...`, `S25+ de Pedro`) em [discovery.ts](../../packages/quicktone-reader/src/discovery.ts#L13-L21). Em instalações em `Program Files` ou `app.asar`, gravações no diretório da app falham.
- **Decisão:**
  1. Centralizar todo armazenamento gravável do desktop sob `MG_DATA_DIR` (em Electron: `app.getPath('userData')`, ex.: `%APPDATA%\MG Control\`), dividido em: `backups/`, `data/user-gear.json`, `data/trusted-devices.json`, `logs/midi-diagnostics.log`, `config/settings.json`.
  2. Remover imediatamente (S04) todos os caminhos pessoais hardcoded de `DEFAULT_QUICKTONE_CANDIDATE_PATHS`, usando apenas diretórios padrão do sistema (`Documents/NUX`, `Downloads`) e pasta escolhida pelo usuário.
  3. Definir política de retenção de backups locais (ex.: manter os últimos 100 backups por slot ou últimos 30 dias configuráveis) e migração não-destrutiva de `localStorage` (`mg300_webapp_storage_v1` → `mgcontrol_storage_v2`).
- **Consequências:** Upgrades e desinstalações preservam dados do músico; funcionamento garantido sem permissão de administrador.

## ADR-012: Política de Portas, Bind LAN Offline e Descoberta Mobile
- **Contexto:** A LAN celular↔PC em tempo real via QR Code e WebSocket `/ws` é um diferencial já funcional e offline. Ocupação da porta `3001` por outra instância/serviço impediria o boot do app.
- **Decisão:** Tentar bind `0.0.0.0:3001` como porta preferencial (mantendo bookmarks/firewall existentes); se `EADDRINUSE`, sondar faixa `3002..3020` (ou porta efêmera `0` como último recurso). O Local Core comunica a porta real vinculada e URLs LAN ao Electron Main (`LocalCoreBootstrapEventV1`), e o QR Code usa dinamicamente a porta efetiva. O app exibirá instruções claras de liberação da porta em **Rede Privada** no Windows Firewall (sem exigir privilégio admin silencioso).
- **Consequências:** App nunca falha silenciosamente por porta ocupada e preserva o pareamento LAN offline intacto.

## ADR-013: Hosting Cloud Modular e Sizing Inicial sob Teto ~R$150/mês
- **Contexto:** A arquitetura exige backend Cloud seguro (`/v1`) com PostgreSQL, TLS e backups externos dentro de orçamento inicial aproximado de R$150/mês, evitando complexidade prematura de microservices.
- **Decisão:** Implantar a Cloud API como **monólito modular Fastify** atrás de proxy reverso TLS (Caddy/Nginx) em **VPS Linux LTS** (baseline inicial de cotação/teste: `2 vCPU / 4 GB RAM / 40–80 GB SSD/NVMe`, região com baixa latência ao Brasil), sujeito à cotação formal e validação antes de contratação (regra: não contratar sem autorização do Pedro).
- **Consequências:** Menor custo fixo previsível, zero cold starts para webhooks/IA e fácil portabilidade via containers/systemd caso PaaS ou escala horizontal seja necessária no futuro.

## ADR-014: PostgreSQL, Migrations Forward-Safe e Backup/Restore Externo
- **Contexto:** Ledger financeiro de créditos, idempotência de webhooks e limite atômico de 3 dispositivos exigem garantias ACID.
- **Decisão:** Utilizar **PostgreSQL 16+** inicialmente na mesma VPS (isolado em rede loopback/privada, sem porta pública, usuário aplicativo com least-privilege), com migrações SQL versionadas e **forward-safe** (padrão *expand → backfill → switch → contract*, sem `DROP` destrutivo no mesmo deploy). Backups lógicos/físicos diários criptografados fora da VPS (object storage externo) com teste periódico de restore em S05/S11. **Não** criar tabelas para biblioteca ou sincronização de presets cloud no MVP.
- **Consequências:** Atomicidade real em reservas de crédito e contagem de devices; caminho limpo para separar DB gerenciado quando o volume crescer.

## ADR-015: Autenticação, Refresh Rotativo, DPAPI e Limite de 3 Dispositivos
- **Contexto:** Recursos locais (MIDI, presets, LAN) devem funcionar **sem login e offline**. A conta é exigida apenas para créditos e geração por IA, limitada a 3 dispositivos por conta com múltiplas sessões permitidas.
- **Decisão:**
  - Cadastro com senha forte + verificação obrigatória de e-mail antes de conceder os 3 créditos trial e habilitar IA. Respostas nunca enumeram e-mails existentes.
  - **Access Token (JWT curto, 15 min)** em memória + **Refresh Token opaco rotativo (30 dias)** armazenado no DB via hash SHA-256 com detecção de reuso/revogação em cadeia.
  - No Electron Windows, o token/chave local do dispositivo é protegido via **Windows DPAPI** (`Electron safeStorage`), vinculado a um `deviceKey` gerado localmente cujo hash é registrado no servidor (`/v1/devices`). Fingerprint de hardware atua apenas como sinal auxiliar (nunca fator único).
  - Limite de **3 dispositivos ativos por conta** aplicado atomicamente em transação PostgreSQL (`SELECT ... FOR UPDATE` na conta). Perda/formatação do PC exige novo registro e eventual revogação de dispositivo antigo no Portal Web.
- **Consequências:** Uso local permanece livre; roubo de refresh token ou clonagem simples de máquina não compromete a conta.

## ADR-016: Billing Cartão/Pix, Ledger Idempotente e Portal Web Separado
- **Contexto:** O Brasil exige cartão + Pix; o desktop local não deve hospedar checkout complexo nem depender de redirect de browser para liberar créditos.
- **Decisão:**
  - **Portal Web separado** (PT/EN responsivo) consome `/v1` para login, saldo, extrato, compra e gestão de dispositivos.
  - Interface `PaymentProvider` na Cloud com **Stripe** prioritária (cartão + Pix se elegível na conta Brasil) e **Mercado Pago** como fallback/provedor Pix no Brasil.
  - Apenas venda avulsa de pacotes de créditos (sem assinatura no lançamento, mantendo `CreditBucketType` extensível). Preços/pacotes vêm de tabela/configuração server-side (R$9,90 / US$2,99 por 10 créditos permanece hipótese até validação de unit economics na S06).
  - **Ledger imutável (`credit_ledger`)** com buckets separados: `trial` (3 créditos após e-mail verificado, expiração em 30 dias) e `purchased` (sem expiração), consumindo preferencialmente `trial` próximo do vencimento antes de `purchased`.
  - Fluxo de cobrança por geração: `reserve (1)` → chamada Gemini → `consume` em sucesso ou `release` em falha/timeout, com `idempotencyKey`.
  - Créditos comprados são concedidos **exclusivamente** após webhook assinado + verificação server-to-server + registro de `webhook_events` para idempotência/replay.
- **Consequências:** Conciliação auditável entre gateway, pedidos e saldo; zero concessão falsa por redirect de cliente.

## ADR-017: Proxy Gemini Server-Side, Escopo de IA, Custo e Feedback Voluntário
- **Contexto:** Hoje a chave Gemini e o prompt estão no cliente local, não há medição de `usageMetadata`/custo, `PUT /api/ai/gear` gasta chamadas Gemini sem controle e `edit_existing` (`intent=1`) existe no código.
- **Decisão:**
  1. Criar `AiProviderAdapter` exclusivamente na Cloud (`/v1/ai/generate`), removendo `GEMINI_API_KEY` e prompts do cliente desktop.
  2. O modelo Gemini retorna apenas o plano estruturado (`AiTonePlanV1`); o Local Core compila e valida deterministicamente (`buildAndCalibrateStruct102` + política de ambiência → `struct102` → `0x0E` + readback).
  3. Toda chamada grava obrigatoriamente `usageMetadata` (`promptTokens`, `candidatesTokens`, `thoughtsTokens`, `totalTokens`), `modelId`, `latencyMs`, `attempts` e `estimatedCostUsd`, protegida por rate limit (conta/device/IP), `maxOutputTokens`, timeout, orçamento diário/mensal e kill switch.
  4. **Alinhamento de escopo (`DEC-05`):** Como default arquitetural até decisão comercial explícita do Pedro antes da S06, validar guitarra em `PUT /api/ai/gear` **localmente/deterministicamente sem gastar Gemini**, e manter o contrato `AiTonePlanV1` compatível com `intent: 'create_new' | 'edit_existing'`, cobrando 1 crédito por geração concluída caso `edit_existing` seja mantido ou restringindo a `create_new` por feature flag server-side conforme decisão de produto.
  5. Feedback pós-geração (`AiFeedbackRequestV1`) é estritamente voluntário (`voluntary: true`); nenhuma telemetria geral de comportamento é coletada.
- **Consequências:** Proteção financeira contra abuso de IA e medição real de custo por timbre antes de abrir vendas.

## ADR-018: Distribuição Windows x64, SemVer e Aviso de Atualização
- **Contexto:** O repositório privado no GitHub não serve para distribuição pública a usuários finais; auto-update silencioso completo está fora do MVP.
- **Decisão:** Versionamento SemVer (`MAJOR.MINOR.PATCH`). Artefatos de release (instalador Windows x64 `.exe`, arquivo `.sha256` e `version-manifest.json`) hospedados em object storage/CDN HTTPS (ex.: Cloudflare R2 / S3 / Vercel Blob após cotação). O Electron Main consulta `version-manifest.json` periodicamente/sob demanda sem bloquear uso offline; se houver versão mais nova, exibe aviso discreto + botão abrindo a página oficial de download no navegador. Code Signing Windows (OV/EV) será integrado na S09 mediante cotação e aprovação.
- **Consequências:** Entrega simples, verificável por checksum SHA-256, sem risco de auto-update corromper drivers/sessão no MVP.
