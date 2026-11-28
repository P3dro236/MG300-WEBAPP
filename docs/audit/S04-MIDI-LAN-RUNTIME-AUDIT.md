# Auditoria S04 — MIDI, QuickTone, LAN e Runtime Empacotado

**Data:** 2026-11-28  
**Branch:** `feat/s04-midi-quicktone-lan`  
**Escopo:** Cumprimento da etapa `S04` (`04-MIDI-QUICKTONE-E-LAN.md`) — compatibilidade de dependências nativas/ABI no Electron, hardening do `WinMmMidiAdapter`, isolamento estrito do modo `mock`, leitura/escrita/readback, descoberta/firewall LAN e matriz de bloqueios físicos.

---

## 1. Auditoria de Dependências Nativas e ABI/Runtime Electron

| Pacote / Integração | Mecanismo real no runtime | Binário nativo `.node`? | Necessita `electron-rebuild`? | Comportamento no runtime empacotado (`win-unpacked/MG Control.exe`) |
|---|---|---|---|---|
| `winmm.dll` via `@quicktone/midi` (`WinMmMidiAdapter`) | Child processes `powershell.exe` compilando/carregando bridge C# (`Add-Type` P/Invoke em `winmm.dll`) em `os.tmpdir()/quicktone-winmm-<hash>` | Não (P/Invoke gerenciado .NET/WinMM) | Não | Validado em execução real do `MG Control.exe`: não escreve em `Program Files`, usa `os.tmpdir()` com escrita atômica `.tmp-<pid>-<uuid>` e direciona `midi-diagnostics.log` para `%APPDATA%\MG Control\logs\`. |
| `fastify` + `ws` (`@quicktone/backend`) | JS puro empacotado via `esbuild` em `resources/core/local-core.cjs` e executado com `ELECTRON_RUN_AS_NODE=1` (Node v22.16.0 embutido no Electron 35.7.5) | Não | Não | Confirmado compatível em `smoke-packaged.mjs` (`isPackaged=true`, HTTP `/api/health` 200 e WebSocket ativos). |
| `@quicktone/reader` (`fs.watch` + parser binário `.nuxpreset`) | APIs padrão Node `node:fs` (`DataView` / `Uint8Array`) | Não | Não | 100% compatível sem módulos nativos; preserva compatibilidade V1 (8.380 B), V2 (8.381 B) e `MG300AllPreset.nuxpreset` (36 slots). |
| `electron` `safeStorage` (`@quicktone/desktop`) | API nativa embutida do próprio Electron 35.7.5 (DPAPI no Windows) | Embutido no Electron | Não | Sem fallback em texto claro; testado em `e2e/electron.spec.ts`. |

**Conclusão ABI:** Não há dependências `.node` de terceiros (C++/N-API) que quebrem entre versões de ABI do Electron; portanto `@electron/rebuild` no `electron-builder` finaliza limpo e o uso de `WinMmMidiAdapter` independe da versão do módulo Node nativo.

---

## 2. Isolamento Estrito do Modo `MOCK`

- `IMidiAdapter.isMock` (`true` em `MockMidiAdapter`, `false` em `WinMmMidiAdapter`) propaga `midiAdapterMode: 'mock' | 'hardware'` até `ControllerState` (`GET /api/status` e WebSocket `state_sync` / `state_updated`).
- Em runtime empacotado (`MG_IS_PACKAGED=1`), `resolveMidiAdapterSelection()` bloqueia `QUICKTONE_MIDI_ADAPTER=mock` automaticamente e força `WinMmMidiAdapter`, a menos que o modo de teste explícito `MG_ALLOW_PACKAGED_MOCK=1` esteja ativo (usado apenas em testes automatizados).
- Na interface ([ConnectionBadge.tsx](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/frontend/src/components/ConnectionBadge.tsx)), o estado conectado via simulador exibe alerta âmbar explícito **`Modo Simulação (MOCK) · Sem hardware USB`** (`data-midi-mode="mock"`), jamais exibindo `MG-300 Conectada`.

---

## 3. Descoberta LAN, Sleep/Resume e Instruções Windows Firewall

- **Priorização de IPs LAN (`selectPrioritizedLanAddresses`):** filtra loopback (`127.*`) e link-local APIPA (`169.254.*`), prioriza placas físicas (`192.168.*` -> `10.*` -> `172.16-31.*`) acima de adaptadores virtuais (`vEthernet (WSL)`, `Hyper-V`, `Docker`, `VMware`, `VirtualBox`, `Tailscale`, `ZeroTier`, `Hamachi`, `TUN/TAP`), usando interfaces virtuais apenas como fallback caso não exista adaptador físico ativo.
- **Atualização automática de QR e retomada do Windows:**
  - `POST /api/pairing/challenge` atualiza `refreshLanUrls(port)` antes de gerar o QR Code.
  - Electron `powerMonitor.on('resume', ...)` aciona a rota desktop-only `POST /api/system/resume` (`403 DESKTOP_ONLY` para clientes remotos) para reavaliar IPs LAN e reconexão USB-MIDI preservando sessões móveis já autorizadas.
- **Instruções ao usuário final ([SettingsModal.tsx](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/frontend/src/components/SettingsModal.tsx)):**
  - Lista sempre os URLs LAN detectados com botão de cópia + porta TCP ativa.
  - Inclui guia expansível de solução de problemas (mesmo Wi-Fi offline sem internet, permissão para `MG Control` em redes Privadas no Windows Defender Firewall e bloqueio de AP Isolation / VPN).

---

## 4. Itens Pendentes de Hardware Físico (`PENDING` — Bloqueio Físico)

Conforme regra explícita de integridade factual (`04-MIDI-QUICKTONE-E-LAN.md`), nenhum resultado abaixo é marcado como validado sem evidência física real:

| Cenário físico exigido pela S04 | Status | Motivo do bloqueio / O que validar presencialmente |
|---|---|---|
| NUX MG-300 plugada via USB **antes e depois** de abrir o `MG Control.exe` empacotado | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Pedaleira física não conectada durante a execução automatizada; validar seleção `NUX NME-300`, `PORT_BUSY` se QuickTone estiver aberto e desconexão/reconexão do cabo USB com `WinMmMidiAdapter`. |
| Gravação 0x0E + readback real no hardware (`ExperimentalEditService`) | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Validado apenas com `MockMidiAdapter` em testes automatizados; confirmar ACK e bytes reais no slot 4D em hardware físico. |
| Celular real conectado ao mesmo roteador **sem internet** + firewall Windows real | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Fluxo LAN HTTP/WS validado em loopback Playwright/Fastify (`localhost` / `X-Forwarded-For`); falta testar leitura real de QR Code pela câmera de celular em Wi-Fi local isolado e prompt real do Windows Defender Firewall. |
| Smoke em instalação limpa do Windows e **segundo PC Windows** + sleep/resume físico | **PENDING (`BLOCKED_BY_PHYSICAL_HARDWARE`)** | Disponibilidade apenas de uma máquina de desenvolvimento nesta sessão; testar [MG Control Setup 1.0.0.exe](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/desktop/release/MG%20Control%20Setup%201.0.0.exe) em Windows limpo / 2º PC Windows após suspensão física. |
