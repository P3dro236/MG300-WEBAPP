# Etapa S03 — Electron Shell e Orquestração (`feat/s03-electron-shell`)

**Data:** 2026-11-28  
**Branch:** `feat/s03-electron-shell` (baseada em `main` @ `e60632e`)  
**Status do Gate S03:** **PASS (código, testes, empacotamento Windows x64 de teste e Code Review independente aprovados; smoke com hardware USB NUX MG-300 físico pendente de janela de teste no Windows)**

---

## 1. Resumo Executivo

A Etapa S03 transformou o **MG Control** em uma aplicação desktop standalone para **Windows x64** baseada em **Electron**, mantendo o núcleo local existente (`@quicktone/backend` + `@quicktone/midi` + `@quicktone/quicktone-reader` + `@quicktone/shared`) e preservando integralmente o funcionamento offline via USB-MIDI, leitura de presets QuickTone, pareamento LAN via QR Code/WebSocket e o modo Web clássico (`npm start`).

Não houve alteração em protocolo MIDI, firmware da pedaleira, fluxo LAN nem antecipação de recursos Cloud (`S05`/`S06`/`S08`).

---

## 2. Alterações Arquiteturais e Arquivos Criados/Modificados

### 2.1 Adaptação do Local Core e Build Frontend (`@quicktone/shared`, `@quicktone/backend`, `@quicktone/frontend`)
- **`packages/shared/src/contracts-v1.ts`:** Unificação da interface `MgControlDesktopBridgeV1` (consumida tanto pelo `preload.ts` quanto por `electron.d.ts`).
- **`packages/backend/src/index.ts`:**
  - Suporte explícito a `dataDir` / `MG_DATA_DIR`, `MG_STATIC_DIR`, `PORT` / `MG_PORT` e `allowPortFallback` / `MG_ALLOW_PORT_FALLBACK=1` (tentando sequência de até 20 portas a partir da preferencial + fallback efêmero `0` em caso de `EADDRINUSE`/`EACCES`, com pré-probe TCP e cleanup de instâncias em retry).
  - Configuração de `QUICKTONE_MIDI_LOG_FILE` dentro de `MG_DATA_DIR/logs/midi-diagnostics.log` **antes** da criação de `ControllerStateManager` e `MidiService`.
  - Suporte a execução direta em bundle CommonJS (`require.main === module` + fallback ESM `import.meta.url`), emissão do evento estruturado `__MG_CORE_BOOTSTRAP__:<json>` validado por `LocalCoreBootstrapEventV1Schema`, e desligamento limpo via `stdin` (`{"cmd":"shutdown"}`, `end`, `close` sob `MG_CORE_IPC_STDIN=1`) além de `SIGINT`/`SIGTERM`.
- **`packages/backend/src/app.ts`:** Resolução de `MG_STATIC_DIR` e caminhos padrão em `MG_DATA_DIR` (`backups/`, `data/user-gear.json`), além de cabeçalhos defensivos (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e `X-Frame-Options: DENY` em assets/HTML estáticos).
- **`packages/backend/scripts/build-core.mjs` & `packages/backend/package.json`:** Novo script `build` com `esbuild` compilando o Local Core para `packages/backend/dist/local-core.cjs` (`2.221.692` bytes, `0` warnings).
- **`packages/frontend/vite.config.ts` & `packages/frontend/src/types/electron.d.ts`:** Desabilitação de sourcemaps em build padrão (`sourcemap: process.env.VITE_SOURCEMAP === 'true'`) e tipagem global de `window.mgControl`.

### 2.2 Workspace Desktop Electron Windows x64 (`@quicktone/desktop`)
- **`packages/desktop/src/paths.ts`:** Resolução determinística de caminhos em desenvolvimento (`isPackaged=false`) e empacotado (`isPackaged=true`, via `process.resourcesPath`), helper compartilhado `writeFileAtomicSync` com sufixo único (`${process.pid}-${crypto.randomUUID()}`) e executor `runNonDestructiveLegacyMigration()` baseado em `planLocalDataDirectoryMigration()` (sem apagar origem nem sobrescrever arquivos existentes no destino).
- **`packages/desktop/src/sanitizer.ts`:** Sanitização de textos e payloads diagnósticos (mascarando tokens Bearer/JWT/API keys, e-mails, nomes de usuário em caminhos Windows, IPv4 privados e IPv6 ULA/link-local `fc/fd/fe80`).
- **`packages/desktop/src/security.ts`:** `webPreferences` estritas (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`), construtor dinâmico de CSP sem `'unsafe-eval'`/`'unsafe-inline'` para scripts, e validação de origens de navegação e URLs externas (`https://` sem credenciais, `<= 2048` chars).
- **`packages/desktop/src/dpapi-store.ts`:** Persistência criptografada via Electron `safeStorage` (DPAPI Windows) para sessão Cloud (`auth-session.dpapi.json`) sem fallback em texto claro, além de identidade estável do dispositivo (`device-identity.json`).
- **`packages/desktop/src/core-supervisor.ts`:** Supervisão completa do processo `local-core.cjs` com `ELECTRON_RUN_AS_NODE=1`, espera de bootstrap + health check `/api/health`, polling periódico com guarda de reentrância (`healthCheckInFlight`), recuperação após 3 falhas seguidas sem duplicação de `scheduleAutoRestart()` (`intentionallyTerminatedChildren` `WeakSet`), limite de 3 reinícios automáticos em janela de 60s entrando em `'degraded'`, logs sanitizados e rotacionados (`desktop-main.log`), exportação de diagnóstico sanitizado e encerramento limpo com fallback `taskkill /PID ... /T /F` sem deixar PIDs órfãos.
- **`packages/desktop/src/ipc-router.ts` & `packages/desktop/src/preload.ts`:** Exposição exclusiva de `window.mgControl` congelado via `contextBridge` cobrindo os 10 canais fechados de `IPC_CHANNELS_V1`, com validação Zod de entrada/saída, checagem de origem (`lastKnownCoreOrigin` preservando diagnósticos/restart mesmo em estado `degraded`) e verificação de `mainFrame` (`isSenderAuthorized`).
- **`packages/desktop/src/main.ts`:** `app.setName('MG Control')` e `app.setPath('userData', ...)` antes de `app.requestSingleInstanceLock()`, migração não destrutiva no boot, CSP dinâmica via `onHeadersReceived` com deduplicação de cabeçalhos, bloqueio de `will-attach-webview`, `will-navigate`, `will-redirect`, `setWindowOpenHandler`, permissões negadas por padrão e encerramento limpo no `before-quit`.
- **`packages/desktop/scripts/build-desktop.mjs`, `packages/desktop/scripts/smoke-packaged.mjs` & `packages/desktop/electron-builder.yml`:** Build de `main.js` + `preload.js` com verificação automática de que `dist/preload.js` não importa nenhum módulo além de `electron`; empacotamento Windows x64 NSIS (`publish: null`, `asar: true`, `extraResources` com `local-core.cjs` e `frontend/dist`); script `smoke:packaged` validando o executável final empacotado.

### 2.3 Testes Adicionados e Infraestrutura de QA
- **`packages/desktop/src/__tests__/desktop-unit.test.ts`:** Caminhos dev/packaged, migração não destrutiva e idempotente, redação de segredos/IPv4/IPv6/paths, postura de segurança e CSP, auditoria estática de `preload.ts`, `DpapiSessionStore`, e todos os 10 canais IPC incluindo estados `degraded` e rejeição de subframes.
- **`packages/desktop/src/__tests__/core-supervisor.test.ts`:** Ciclo real com `local-core.cjs` e `MG_DATA_DIR` isolado, fallback de porta ocupada, recuperação automática de crash `SIGKILL`, 3 falhas consecutivas de `/api/health` com reinício único (`restartCount === 1`), `restart()` manual + rotação de log, cap de 3 auto-restarts em 60s levando a `'degraded'`, e ausência de PID órfão.
- **`e2e/electron.spec.ts`, `playwright.electron.config.ts`, `playwright.config.ts`, `vitest.config.ts`, `package.json`, `.gitignore`:** Suíte Playwright Electron validando ciclo abrir/fechar/reabrir com persistência (`MG_DATA_DIR`, `localStorage`, DPAPI), zero PID órfão, isolamento de contexto/CSP/bloqueio de navegação e popups, fluxos offline (presets, volume, QR LAN) e bloqueio real de segunda instância (`second-instance`).

---

## 3. Resultados de Validação (Pós-Última Edição)

| Verificação | Comando | Resultado | Observação |
|---|---|---|---|
| Build + Typecheck | `npm run build` && `npm run typecheck` | **PASS** | 6/6 workspaces (`shared`, `reader`, `midi`, `backend`, `frontend`, `desktop`); `local-core.cjs` (2.221.692 B, 0 warnings), `main.js` (231.368 B), `preload.js` (182.911 B) |
| Unitários + Integração | `npm run test` (`BypassSandbox: true` por bloqueio sandbox `EACCES` em loopback TCP) | **PASS** | **17/17 arquivos, 161/161 testes** |
| E2E Web + Electron | `npm run test:e2e` (`BypassSandbox: true` por rede sandbox) | **PASS** | Web (`controller.spec.ts`): **4/4**; Electron (`electron.spec.ts`): **3/3** |
| Instalador Windows x64 (teste, sem publish) | `npm run dist:win:test` (`BypassSandbox: true` por cache NSIS) | **PASS** | Gerado `packages/desktop/release/MG Control Setup 1.0.0.exe` (**87.858.452 B**), `win-unpacked/MG Control.exe` (**201.233.408 B**), `resources/app.asar` (**4.020.489 B**), `resources/core/local-core.cjs` (**2.221.692 B**), `resources/frontend/index.html` (**623 B**, **0 arquivos `.map`**) |
| Smoke no executável empacotado | `npm --workspace=@quicktone/desktop run smoke:packaged` (`BypassSandbox: true`) | **PASS** | `win-unpacked/MG Control.exe` validado em runtime real (`isPackaged=true`, `/api/health` 200, zero `.map`, zero PID órfão) |
| Hardware USB NUX MG-300 físico | Teste manual Windows com pedaleira conectada via `WinMmMidiAdapter` | **PENDING** | Aguardando validação presencial de Pedro em janela de teste (S04 / hardware físico) |

---

## 4. Code Review Independente (`code-reviewer`, somente leitura)

- **1ª Rodada:** Veredito `REPROVADO` — identificados `2 ALTO` (dupla chamada a `scheduleAutoRestart()` em falha de health check; `getAllowedOrigins()` vazio bloqueando IPCs de recuperação em modo `restarting`/`degraded`), `2 MÉDIO` (race `start`/`restart`/`stop`; lacunas de teste de health check, limite de restart e pacote final) e `3 BAIXO` (duplicação de `MgControlDesktopBridgeV1`, `void` promises / `!` assertion / headers duplicados em `main.ts`, sufixo `.tmp-${pid}` sem UUID).
- **2ª Rodada (após correções e retestes):** Veredito **`APROVADO`** (`0 CRÍTICO`, `0 ALTO`, `0 MÉDIO`, `0 BAIXO`).
