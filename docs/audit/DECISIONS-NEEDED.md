# Decisões Necessárias — Pós-Auditoria S01

> **Etapa:** S01 — Auditoria Baseline
> **Objetivo:** Registrar decisões técnicas (para S02 ADRs) e decisões operacionais/estratégicas de Pedro (`pedro/`) que destravam as próximas etapas.

---

## 1. Decisões Imediatas para Destravar S02–S04 (Curto Prazo)

### DEC-01: Higienização do Git na branch `feat/ai-tone-assistant`
- **Referência:** `pedro/01-URGENTE-ACOES-IMEDIATAS.md` (P0: Repo local, branch limpa e commit registrado).
- **Situação encontrada:** Há 6 arquivos modificados e 7 entradas untracked na working tree atual (política de delay/ambiência + `docs/prod_decision/`).
- **Decisão necessária:** Commitar o trabalho estável atual da política de ambiência em `feat/ai-tone-assistant` (ou em branch dedicada) e abrir branch limpa de integração (ex.: `main` / `feat/mg-control-architecture`) antes de iniciar alterações de código na S03+.

### DEC-02: Janela de Smoke Test Físico (`NUX MG-300` + Celular LAN sem internet)
- **Referência:** `pedro/01-URGENTE-ACOES-IMEDIATAS.md` (P0: Manter MG-300 disponível) & `agy/01` / `agy/04`.
- **Situação encontrada:** Smoke físico na branch atual está `PENDING`; documentação cita firmware `V4.02.23`.
- **Decisão/ação necessária:** Confirmar versão exata do firmware da pedaleira e executar o checklist físico da seção 5 de [TEST-MATRIX.md](./TEST-MATRIX.md) (pode ocorrer em paralelo ao S02 documental, mas **bloqueia aprovação física de S04/S09/S11**).

### DEC-03: Identificação do Repositório e Projeto Vercel (`mg300.vercel.app`)
- **Referência:** `pedro/01-URGENTE-ACOES-IMEDIATAS.md` (P0: Identificar repo do site e projeto Vercel) & `agy/01` / `agy/10`.
- **Situação encontrada:** Inspeção remota indisponível na S01 (`PENDING`).
- **Decisão/ação necessária:** Informar caminho local ou URL do repositório do site e nome/ID do projeto na Vercel (sem colar tokens).

---

## 2. Decisões Arquiteturais para os ADRs da S02

### DEC-04: Estratégia de Empacotamento do Acesso WinMM MIDI no Electron
- **Contexto real:** `WinMmMidiAdapter` hoje invoca `powershell.exe` e compila C# em `%TEMP%\quicktone-winmm-<hash>\bridge.dll` via `Add-Type`.
- **Opções para ADR em S02:**
  - *Opção A (Recomendada):* Manter a lógica C# P/Invoke em `winmm.dll`, porém **pré-compilar** um binário/helper Windows x64 dedicado (ex.: `mg-midi-bridge.exe` / DLL assinada) no build, eliminando `powershell.exe` e compilação `Add-Type` em runtime em máquinas de clientes.
  - *Opção B:* Manter `powershell.exe` + pré-compilação no build sem `Add-Type` em runtime.
  - *Opção C:* Substituir por addon nativo Node-API C++ (`electron-rebuild`).
- **Destrava:** S02 (ADR), S03 (lifecycle), S04 (MIDI) e S09 (instalador Windows limpo).

### DEC-05: Escopo de `edit_existing` (`intent=1`) e Validação de Guitarra (`PUT /api/ai/gear`) no MVP Comercial
- **Contexto real:**
  - `AiToneService` já implementa `intent=0` (`create_new`) e `intent=1` (`edit_existing` — ajuste incremental sobre preset existente). Já `agy/00` e `agy/06` dizem *"somente geração de timbres no lançamento; análise/melhoria IA fora do MVP"*.
  - `PUT /api/ai/gear` também faz 1 chamada à API Gemini sem controle de créditos.
- **Decisão necessária:**
  1. Manter `edit_existing` (`intent=1`) ativo no lançamento cobrando 1 crédito por uso (tratado como geração sobre slot), **ou** ocultar/desativar `intent=1` até pós-MVP?
  2. Manter validação de guitarra via Gemini (com rate limit rígido) **ou** validar guitarra deterministicamente/localmente sem gastar chamada Gemini?
- **Destrava:** S02 (contratos `/v1/ai/*`) e S06 (ledger/unit economics).

### DEC-06: Padronização de Storage Local, Build Node e Nomenclatura `MG Control`
- **Contexto real:** 6 locais de storage espalhados (`process.cwd()`, `MONOREPO_ROOT`, `%TEMP%`, `localStorage` `mg300_webapp_storage_v1`), paths hardcoded `C:\Users\pedro\...`, pacotes Node sem `build` JS e nomes legados `@quicktone/*`.
- **Decisão para S02:** Definir layout único em `%APPDATA%\MG Control\` (`userData`) com migração automática não-destrutiva de `data/user-gear.json`, `backups/` e `localStorage`, além de definir `tsup`/`tsc` para gerar `dist/` nos pacotes Node antes da S03.

---

## 3. Decisões Estratégicas & Infraestrutura de Maior Lead Time (`S05`–`S10`)

Referências cruzadas com `pedro/01-URGENTE-ACOES-IMEDIATAS.md`, `pedro/02-DECISOES-ESTRATEGICAS.md` e `pedro/03-REQUISITOS-MINIMOS-INFRA-E-SITE.md`:

| ID | Tema | Referência `pedro/` | Decisão / Ação necessária | Etapa que destrava |
|---|---|---|---|---|
| **DEC-07** | Projeto Google AI Studio prod + Model IDs | `pedro/01` (P1) & `pedro/03` | Confirmar projeto comercial Google AI Studio, validar quais dos 4 model IDs de `ALLOWED_GEMINI_MODELS` (`gemini-3.8-flash`, `3.6-flash`, `4-hydrogen`, `3.5-flash-lite`) existem/são oficiais na conta prod, e separar credenciais dev vs prod no secret manager. | S06 (custo e proxy IA) |
| **DEC-08** | Gateway Cartão + Pix no Brasil | `pedro/01` (P1) & `pedro/02` (#7) | Verificar elegibilidade da conta Stripe Brasil para **Pix** além de cartão (taxas, moedas BRL/USD, prazo de liquidação); preparar conta **Mercado Pago Developers** caso Stripe não libere Pix. | S08 (billing e webhooks) |
| **DEC-09** | E-mail transacional & Domínio próprio | `pedro/01` (P1/P2) & `pedro/02` (#4) | Definir provedor transacional (Resend, Postmark, Brevo ou SES) e domínio próprio (após cotação de renovação) para configurar SPF/DKIM/DMARC. | S05 (verificação e-mail), S08, S10 |
| **DEC-10** | Hosting Cloud & PostgreSQL (~R$150/mês) | `pedro/02` (#1/#2) & `pedro/03` | Aprovar após cotação comparativa (VPS Linux 2 vCPU/4 GB + PostgreSQL self-hosted + backup externo vs PaaS) mantendo teto ~R$150/mês. | S05 (cloud deploy) |
| **DEC-11** | Storage/CDN de instaladores & Code Signing | `pedro/01` (P2) & `pedro/02` (#3/#6) | Definir object storage/CDN (R2 / S3 / Vercel Blob) para `.exe` + `.sha256` e decidir contratação de certificado OV/EV Windows após cotação (pode aguardar build de teste da S09). | S09 (distribuição pública) |
| **DEC-12** | Controlador LGPD, Termos e Privacidade | `pedro/01` (P2) | Definir dados legais do controlador (PF/CNPJ) e e-mail de contato LGPD/suporte para publicação dos documentos legais. | S07, S10, S11 (Go-Live) |
