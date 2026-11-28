# Matriz de Testes e Cobertura Real — MG Control

> **Etapa:** S01 — Auditoria Baseline
> **Data:** 2026-11-28

---

## 1. Scripts Reais de Teste e Qualidade

| Escopo | Script | Comando real | Status de existência |
|---|---|---|---|
| Raiz | `typecheck` | `npm run typecheck --workspaces --if-present` | Existe |
| Raiz | `test` / `test:unit` | `vitest run` | Existe |
| Raiz | `test:e2e` | `playwright test` | Existe |
| Raiz | `build` | `npm run build --workspaces --if-present` | Existe (compila só `frontend`) |
| Raiz / Workspaces | `lint`, `format`, `test:coverage`, `test:electron` | — | **Ausentes** |
| CI (`.github/workflows`) | — | — | **Ausente** |

---

## 2. Resultados Reais Executados na S01

> **Nota de ambiente (Windows Sandbox):** Durante a execução dentro do sandbox restrito do terminal, `npm run test` falhou 3 vezes com `EPERM: operation not permitted` ao gravar em `node_modules\.vite-temp\`, e `npm run test:e2e` falhou 3 vezes com `EPERM: operation not permitted` ao remover/gravar `test-results\.last-run.json`. Reexecutados fora do sandbox (`BypassSandbox: true`), todos os comandos completaram integralmente.

| Comando | Ambiente | Exit Code | Resultado Real | Duração |
|---|---|---|---|---|
| `npm run typecheck` | Sandbox | `0` | **PASS** — `@quicktone/shared`, `@quicktone/reader`, `@quicktone/midi`, `@quicktone/backend`, `@quicktone/frontend` (`tsc --noEmit` sem erros) | ~6 s |
| `npm run test` | `BypassSandbox: true` | `0` | **PASS** — Vitest `v3.2.7`: **12 arquivos (12/12)**, **141 casos (141/141)**, 0 falhas, 0 skips | `9.50s` |
| `npm run test:e2e` | `BypassSandbox: true` | `0` | **PASS** — Playwright (`chromium-mobile` / `Pixel 7` / `channel: 'chrome'`): **4 casos (4/4)** em `e2e/controller.spec.ts` | `4.4s` |
| Smoke manual físico (MG-300 + LAN offline) | — | — | **`PENDING`** — Hardware MG-300 e celular físico em rede sem internet não acoplados nesta sessão | — |

---

## 3. Inventário dos Arquivos de Teste Existentes

### 3.1 Vitest (`vitest.config.ts` — 12 arquivos, 141 testes)

| Arquivo | Pacote | Env | Casos | Escopo coberto | Mocks / Fakes usados |
|---|---|---|---|---|---|
| `packages/shared/src/__tests__/shared-contracts.test.ts` | `@quicktone/shared` | `node` | 14 | Alfabeto 72 chars, slots `0..71`, schemas Zod, SysEx builder/parser, captura real `3C`, catálogo 10 blocos, `compareStruct102Readback`, menção proibida de slot | Nenhum (puro) |
| `packages/quicktone-reader/src/__tests__/quicktone-reader.test.ts` | `@quicktone/reader` | `node` | 8 | Pasta inexistente, arquivos inválidos, `.nuxpreset` V1/V2/V4/bundle 36 slots, fallback de nome, duplicados, `watchDirectory`/`reload`, `parseNuxPresetWithStruct102` | Nenhum (usa buffers gerados + `fs` temp) |
| `packages/midi-service/src/__tests__/midi-service.test.ts` | `@quicktone/midi` | `node` | 26 | Auto-detecção `NUX NME-300`, `PORT_BUSY`, `DEVICE_NOT_FOUND`, `CC 0x3C`, `CC 0x40` exclusivo, bloqueio CC `1..10`, tri-state, reconexão, `0x0E` slots `0..35`, rotação de log, auto-recovery `mmresult=1` | `MockMidiAdapter`, stubs de `WinMmMidiAdapter` |
| `packages/backend/src/__tests__/backend.test.ts` | `@quicktone/backend` | `node` | 24 | Endpoints REST, validação Zod, erros 404/409/503, tri-state, segurança LAN `Host`/`Origin`/IP, `authToken`, WS `state_sync`/`ping`/`request_sync`, fluxo completo de `PairingManager` e `trusted-devices` | `MockMidiAdapter`, `app.inject`, IPs/headers simulados |
| `packages/backend/src/__tests__/integration.test.ts` | `@quicktone/backend` | `node` | 4 | `.nuxpreset` → REST/WS `presets_updated`, bytes exatos `[0xB0, 0x3C, slot]` e `[0xB0, 0x40, vol]`, sync multi-cliente WS, desconexão/reconexão automática | `MockMidiAdapter` |
| `packages/backend/src/__tests__/experimental-edit.test.ts` | `@quicktone/backend` | `node` | 14 | Flag `experimentalEdit`, load/edit/save `0x0E` com backup/ACK/readback, proteção Factory `36..71`, timeouts `identity`/`dump`/`ack`, concorrência, rollback `setBlockModel`, rate limit save, `createNewDraft`, `importNuxPreset` | `FakePedalAdapter` (extensão de `MockMidiAdapter`) |
| `packages/backend/src/__tests__/ai-tone.test.ts` | `@quicktone/backend` | `node` | 11 | `.env` loader, allowlist Gemini 4 modelos + cache + failover sem leak, retry HTTP 400 (`thinkingConfig`/`responseSchema`), `AiGearStore`, `AiToneService.applyTone`, calibração, `edit_existing`, readback STM32 bytes inativos | `FakePedalAdapter`, `fetchFn` mockada, `GeminiClientLike` fake |
| `packages/backend/src/__tests__/delay-ambience-policy.test.ts` | `@quicktone/backend` | `node` | 11 | 10 cenários obrigatórios (`it.each`) de política DLY/RVB (Metallica riff/solo, Pink Floyd, Slapback, Ambient, Clean, No-delay, Edit increase) + limites por modelo/orçamento conjunto | `FakePedalAdapter`, `GeminiClientLike` fake |
| `packages/frontend/src/__tests__/frontend.test.tsx` | `@quicktone/frontend` | `jsdom` | 18 | Renderização, filtros Usuário/Fábrica, volume slider/drag guard, `localStorage` merge/recuperação, QR `?pair=` sob `<StrictMode>`, editor 10 blocos, timers `<400ms`, sanitização HTML | `vi.fn()` em `fetch`, fake `WebSocket` |
| `packages/frontend/src/__tests__/ai-tone-ui.test.tsx` | `@quicktone/frontend` | `jsdom` | 5 | Botão IA em User/Factory, fluxo completo `AiToneModal`, cadastro inline de gear preservando prompt/slot, `ai-save-unverified-warning`, `SettingsModal` gear | `vi.fn()` em `fetch`, fake `WebSocket` |
| `packages/frontend/src/__tests__/stage-ui.test.tsx` | `@quicktone/frontend` | `jsdom` | 5 | `StageDisplay`, `StageFootswitchDeck`, busca na matriz, sincronia palco↔matriz, `DesktopPairingBanner` / `TrustedDevices` | `vi.fn()` em `fetch`, fake `WebSocket` |
| `packages/frontend/src/__tests__/lan-pairing-guard.test.tsx` | `@quicktone/frontend` | `jsdom` | 1 | Fail-closed em origem `192.168.1.20:3001` (`pairing-checking-shell` sem vazar `preset-grid` antes de `/api/pairing/status`) | `vi.fn()` em `fetch` |

### 3.2 Playwright E2E (`playwright.config.ts` — `e2e/controller.spec.ts`, 4 testes)
Configuração atual: `workers: 1`, `viewport: { width: 390, height: 844 }`, projeto único `chromium-mobile` (`Pixel 7`, `channel: 'chrome'`). Inicia `createBackendApp` na porta `0` em `127.0.0.1` com `MockMidiAdapter` e arquivos `.nuxpreset` gerados por `buildNuxPresetBinary`.
1. QuickTone `.nuxpreset` até UI → clique em `1B` → `command_sent_unconfirmed` → MIDI IN simulado → `confirmed`.
2. Dois clientes WS (`contextA` + `contextB`) sincronizando seleção de preset e volume `+5` + alternância Usuário/Fábrica e Palco/Matriz.
3. Desconexão inesperada no `MockMidiAdapter` → badge `reconnecting` → reconexão → `connected`.
4. `ToneEditorDrawer` em `375x812`: alvos táteis `>=44px`, zero overflow horizontal, focus trap (`Tab`/`Shift+Tab`), `Escape` em camadas e restauração de foco.

---

## 4. O Que Ainda NÃO É Testado (Mapa de Lacunas)

| Área | Lacuna identificada | Risco se não coberta |
|---|---|---|
| **WinMM real (`winmm.dll`)** | `WinMmMidiAdapter` nunca é exercitado ponta a ponta com `powershell.exe` + `Add-Type` + driver real nos testes automatizados; apenas `normalizeMidiBasePortName`, `WinMmSendAckError` e mocks de método são testados | Falha silenciosa em Windows limpo, bloqueio por AV/PowerShell policy ou divergência de buffer SysEx em hardware real |
| **Hardware NUX MG-300** | Escrita `0x0E` com persistência após desligar/religar, troca ao vivo `CC 1..10`, contenção com `QuickTone.exe` e hotplug USB físico não têm execução automatizada nem smoke atual validado | Regressões de protocolo/timing no STM32 não detectadas por `FakePedalAdapter` |
| **LAN física & Firewall** | Nenhum teste E2E usa IP real da LAN (`192.168.x.x`) em browser mobile real nem valida o fluxo completo QR → `request` → `approve` → `poll` → cookie `HttpOnly` → controle via Playwright | Quebra de cookie/CORS/WS em rede real ou bloqueio do Firewall do Windows |
| **Playwright Desktop, IA e Import** | `playwright.config.ts` testa apenas `Pixel 7` mobile em `127.0.0.1`; não há E2E para viewport desktop, `AiToneModal`, `PUT /api/ai/gear`, `import` de `.nuxpreset` ou `save` com readback | Regressões visuais/funcionais desktop e no fluxo IA passam despercebidas no E2E |
| **Gemini Real & Custo** | Todas as chamadas Gemini nos testes usam `fetchFn` ou `GeminiClientLike` mockados; não há teste de contrato com API real (nem medição de `usageMetadata` / latência) | Quebra quando modelo da allowlist é descontinuado ou excede `maxOutputTokens: 640` |
| **Build / Empacotamento / Electron** | Não existe teste de `npm run build` + `npm start` servindo estáticos reais no E2E, nem existe Electron, preload IPC, single-instance ou `userData` storage | Quebra ao migrar de `tsx` para app empacotado standalone |
| **Cloud / Auth / DB / Billing / Security** | Domínios de `S05`–`S08` ainda não existem no repositório | Cobertura zero |
| **Cobertura de código (coverage)** | Nenhum threshold ou relatório `lcov`/`v8` configurado | Impossível medir cobertura percentual real por módulo |

---

## 5. Checklist de Smoke Manual (`PENDING`)

Conforme `agy/01-AUDITORIA-BASELINE.md`, os cenários físicos abaixo permanecem **`PENDING`** até disponibilidade da pedaleira NUX MG-300 e celular na rede local:
- [ ] **PENDING:** Iniciar `npm run build && npm start` no PC Windows sem `QuickTone.exe` aberto e confirmar conexão USB-MIDI (`NUX NME-300`).
- [ ] **PENDING:** Ler presets do hardware via SysEx (`0x07 → 0x06`), alterar slot User (`0x0E`), validar readback e confirmar persistência após desligar/religar a MG-300.
- [ ] **PENDING:** Executar geração e aplicação de timbre via IA (`AiToneModal`) contra a pedaleira física e medir tokens/latência reais.
- [ ] **PENDING:** Parear celular físico via QR Code na mesma rede Wi-Fi **sem acesso à internet**, trocar presets e ajustar Master Volume em tempo real.
- [ ] **PENDING:** Desconectar e reconectar o cabo USB-MIDI com servidor rodando e validar recuperação automática na UI desktop e mobile.
