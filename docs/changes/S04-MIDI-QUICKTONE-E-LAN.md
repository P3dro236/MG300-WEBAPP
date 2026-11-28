# Etapa S04 — MIDI, QuickTone e LAN (`feat/s04-midi-quicktone-lan`)

**Data:** 2026-11-28  
**Branch:** `feat/s04-midi-quicktone-lan` (baseada em `main` @ `38a7ca4`)  
**Status do Gate S04:** **PASS nas validações automatizadas, empacotamento Windows x64 e Code Review independente (2ª rodada `APROVADO`); cenários com hardware físico NUX MG-300, celular real em Wi-Fi isolado e 2º PC Windows permanecem `PENDING (BLOCKED_BY_PHYSICAL_HARDWARE)`**

---

## 1. Resumo Executivo

A Etapa S04 consolidou a camada de transporte USB-MIDI (`WinMmMidiAdapter`), o isolamento estrito do modo `MOCK`, a cobertura de fixtures QuickTone (`V1`, `V2`, `MG300AllPreset` 36 slots, User IR e arquivos corrompidos), a priorização de interfaces LAN físicas para pareamento offline e o fluxo de recuperação pós-suspensão do Windows (`powerMonitor.on('resume')` -> `POST /api/system/resume`).

Não houve alteração no protocolo MIDI da pedaleira, no firmware da NUX MG-300 nem introdução de login obrigatório ou dependência de internet para os fluxos locais.

---

## 2. Alterações Arquiteturais e Arquivos Criados/Modificados

### 2.1 Contratos e Hardening USB-MIDI / WinMM (`@quicktone/shared`, `@quicktone/midi`)
- **`packages/shared/src/contracts.ts`:** Inclusão de `MidiAdapterModeSchema` (`'hardware' | 'mock'`) e campo opcional `midiAdapterMode` em `ControllerStateSchema`.
- **`packages/midi-service/src/types.ts`, `packages/midi-service/src/mock-adapter.ts`, `packages/midi-service/src/midi-service.ts`:**
  - Propriedade `readonly isMock?: boolean` em `IMidiAdapter` (`true` em `MockMidiAdapter`, `false` em `WinMmMidiAdapter`) propagada para `MidiService.isMockAdapter()` e `MidiServiceStateSnapshot.midiAdapterMode`.
  - Novo método `MidiService.triggerReconnectAttempt()` que dispara uma tentativa imediata via `tryReconnectOnce` somente quando `connectionState === 'reconnecting'`, sem encerrar o loop de reconexão nem transicionar para `'error'` caso o USB ainda esteja enumerando.
- **`packages/midi-service/src/winmm-adapter.ts`:**
  - Escrita atômica idempotente dos arquivos de bridge PowerShell/C# em `os.tmpdir()/quicktone-winmm-<hash>` (`writeBridgeFileAtomicIfMissing` com sufixo `.tmp-${process.pid}-${randomUUID()}`), `WINMM_BRIDGE_SCRIPT_VERSION = 'v2'` no hash e `try/catch` em `Add-Type -Path` com fallback de compilação de `bridge.cs` em caso de corrida concorrente.
  - Extração de `groupWinMmRawPorts(raw, allowSystemSynth)` descartando entradas vazias/espaços e `Microsoft GS Wavetable Synth` (por padrão), pareando IN/OUT em portas `duplex` e priorizando dispositivos MG-300 no topo.
  - Listener `'error'` em `child.stdin` logo após o `spawn`, guarda `current.exitCode === null` em `cleanupWorker()`, encerramento gracioso de `stdin` e suporte a `powershellArgsBuilder` em `WinMmMidiAdapterOptions` para testabilidade determinística de worker filho.

### 2.2 Isolamento MOCK, Descoberta LAN e Wake/Resume (`@quicktone/backend`, `@quicktone/desktop`)
- **`packages/backend/src/state-manager.ts` & `packages/backend/src/index.ts`:**
  - Helper `resolveMidiAdapterSelection()` aplicado tanto em `startBackendServer()` quanto no construtor de `ControllerStateManager`: em runtime empacotado (`MG_IS_PACKAGED=1`), bloqueia `QUICKTONE_MIDI_ADAPTER=mock` e força `WinMmMidiAdapter`, a menos que `MG_ALLOW_PACKAGED_MOCK=1` esteja explícito.
  - `selectPrioritizedLanAddresses()`: filtra loopback e link-local APIPA (`169.254.*`), prioriza placas físicas (`192.168.*` -> `10.*` -> `172.16-31.*`) acima de interfaces virtuais (`vEthernet`, `WSL`, `Hyper-V`, `Docker`, `VMware`, `VirtualBox`, `Tailscale`, `ZeroTier`, `Hamachi`, `TUN/TAP`), usando interfaces virtuais apenas como fallback.
  - `ControllerStateManager.refreshLanUrls(port)` e `ControllerStateManager.handleSystemResume(port)` para atualizar IPs LAN e acionar `triggerReconnectAttempt()` (quando `'reconnecting'`), `connect()` ou `discoverPorts()` preservando sessões móveis já pareadas.
- **`packages/backend/src/app.ts`:**
  - Inclusão de `/api/system/resume` em `DESKTOP_ONLY_PAIRING_ROUTES` (`403 DESKTOP_ONLY` para clientes remotos) e atualização dinâmica de `lanUrls` em `POST /api/pairing/challenge` preservando `serverPort` quando `fastify.server.address()` é `null` (ex.: `app.inject()`).
- **`packages/desktop/src/core-supervisor.ts` & `packages/desktop/src/main.ts`:**
  - Propagação de `MG_IS_PACKAGED` para o Local Core e listener `'error'` em `child.stdin`.
  - Registro de `powerMonitor.on('resume', onPowerResume)` após `await app.whenReady()` (com remoção segura no `before-quit`) notificando `POST /api/system/resume` (incluindo `X-QuickTone-Token` se `QUICKTONE_AUTH_TOKEN` estiver definido).

### 2.3 Transparência MOCK, Ajuda de Firewall e Diagnóstico (`@quicktone/frontend`)
- **`packages/frontend/src/App.tsx`, `packages/frontend/src/components/TopBar.tsx`, `packages/frontend/src/components/ConnectionBadge.tsx`:**
  - Propagação de `midiAdapterMode` até `ConnectionBadge` (`data-midi-mode`). Quando em modo `mock` conectado, exibe aviso âmbar explícito **`Modo Simulação (MOCK) · Sem hardware USB`**, sem exibir `MG-300 Conectada`.
  - `App.tsx` passa `controllerState.lanUrls` ao `SettingsModal` após `hasLoadedInitialState`, refletindo atualizações via WebSocket `state_sync` pós-`resume`/troca de rede.
- **`packages/frontend/src/components/SettingsModal.tsx`:**
  - Lista de URLs LAN detectados com porta TCP ativa e botão de cópia, guia expansível de solução de problemas (`Celular não conecta? Rede LAN e Windows Firewall` cobrindo Wi-Fi offline, Windows Defender Firewall em redes Privadas e AP Isolation/VPN) e botão `Exportar diagnóstico` (desktop-only via `window.mgControl.exportDiagnostics()`).

### 2.4 Suítes de Teste e Auditoria S04
- **`packages/midi-service/src/__tests__/s04-midi-hardening.test.ts`:** Agrupamento multi-device e filtro de entradas vazias em `groupWinMmRawPorts`, isolamento `mock` vs `hardware`, `PORT_BUSY`/falha de envio/hotplug/auto-reconnect, validação `0x0E` com bloqueio de slot Factory e detecção de divergência em readback, e ciclo real de worker filho em `WinMmMidiAdapter` (graceful `stdin -> close`, fallback `kill()` por timeout e saída abrupta sem crash por `EPIPE`).
- **`packages/quicktone-reader/src/__tests__/s04-fixtures.test.ts`:** Fixtures binárias `V1` (`8380 B`), `V2` (`8381 B`), `MG300AllPreset` (36 slots), metadados de User IR, resiliência a arquivos vazios/truncados/magic inválido/JSON inválido e live reload.
- **`packages/backend/src/__tests__/s04-lan-offline-resume.test.ts`:** Priorização de IPs LAN, guard de runtime empacotado em `resolveMidiAdapterSelection` e diretamente em `ControllerStateManager`/`createBackendApp`, pareamento LAN offline, isolamento `403 DESKTOP_ONLY` em `/api/system/resume`, preservação de `'reconnecting'` durante enumeração USB pós-wake e preservação de `serverPort` em `/api/pairing/challenge`.
- **`packages/frontend/src/__tests__/frontend.test.tsx`:** Teste 19 validando atualização de `lan-url-item` no `SettingsModal` após `state_sync` via WebSocket.
- **`packages/desktop/scripts/smoke-packaged.mjs` & `e2e/electron.spec.ts`:** Verificação no executável empacotado `win-unpacked/MG Control.exe` do guard contra `QUICKTONE_MIDI_ADAPTER=mock` sem `MG_ALLOW_PACKAGED_MOCK=1` (`midiAdapterMode === 'hardware'`), badge `MOCK` sem afirmar conexão física, guia de Firewall, exportação de diagnóstico e sincronização LAN em tempo real entre navegador mobile pareado e app Electron.
- **`docs/audit/S04-MIDI-LAN-RUNTIME-AUDIT.md`:** Auditoria de dependências nativas/ABI no Electron, isolamento `MOCK`, descoberta LAN e matriz de bloqueios físicos.

---

## 3. Resultados de Validação (Pós-Última Edição)

| Verificação | Comando | Resultado | Observação |
|---|---|---|---|
| Build | `npm run build` | **PASS** | `local-core.cjs` (`2.228.519 B`, `0` warnings), `frontend/dist`, `main.js` (`232.868 B`), `preload.js` (`183.037 B`) |
| Typecheck | `npm run typecheck` | **PASS** | `tsc --noEmit` sem erros |
| Unitários + Integração | `npm run test` | **PASS** | **20/20 arquivos, 176/176 testes** |
| E2E Web + Electron | `npm run test:e2e` | **PASS** | Web (`controller.spec.ts`): **4/4**; Electron (`electron.spec.ts`): **4/4** |
| Instalador Windows x64 (teste) | `npm run dist:win:test` | **PASS** | `MG Control Setup 1.0.0.exe` (**87.861.342 B**), `win-unpacked/MG Control.exe` |
| Smoke no executável empacotado | `npm --workspace=@quicktone/desktop run smoke:packaged` | **PASS** | `isPackaged=true`, `hardware-guard=verified`, zero `.map`, zero PID órfão |
| Hardware USB NUX MG-300 físico (antes/depois do boot, hotplug `WinMmMidiAdapter`, `PORT_BUSY`) | Validação presencial | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Ver `docs/audit/S04-MIDI-LAN-RUNTIME-AUDIT.md` |
| Gravação `0x0E` + readback real no hardware | Validação presencial | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Ver `docs/audit/S04-MIDI-LAN-RUNTIME-AUDIT.md` |
| Celular real em Wi-Fi local isolado sem internet + Windows Defender Firewall real | Validação presencial | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Ver `docs/audit/S04-MIDI-LAN-RUNTIME-AUDIT.md` |
| Smoke em instalação limpa do Windows e 2º PC Windows + sleep/resume físico | Validação presencial | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Ver `docs/audit/S04-MIDI-LAN-RUNTIME-AUDIT.md` |

---

## 4. Code Review Independente (`code-reviewer`, somente leitura)

- **1ª Rodada:** Veredito `REPROVADO` — identificados `3 ALTO` (`App.tsx` priorizando `pairingStatus.lanUrls` estático sobre `controllerState.lanUrls` atualizado por `state_sync`; `handleSystemResume` interrompendo loop `'reconnecting'` caso a porta USB ainda estivesse enumerando; ausência de listener `'error'` em `child.stdin` no `WinMmMidiAdapter` e `LocalCoreSupervisor`), `3 MÉDIO` (`ControllerStateManager` aceitando `mock` quando instanciado fora de `startBackendServer`; `/api/pairing/challenge` assumindo porta `3001` sem socket bound e `onPowerResume` sem `X-QuickTone-Token`; race em `Add-Type -Path` e falta de testes unitários diretos do worker `WinMmMidiAdapter`) e `2 BAIXO` (`powerMonitor.on('resume')` antes de `app.whenReady()`; `groupWinMmRawPorts` sem filtrar strings vazias e `cleanupWorker` sem checar `exitCode === null`).
- **2ª Rodada (após correções, novos testes de regressão e reexecução integral das validações):** Veredito **`APROVADO`** (`0 CRÍTICO`, `0 ALTO`, `0 MÉDIO`, `0 BAIXO`).
