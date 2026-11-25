# Guia de Conexão USB-MIDI com a NUX MG-300 — QuickTone Web Controller

Este documento descreve a comunicação USB-MIDI com a pedaleira **NUX MG-300** no Windows e o protocolo validado no firmware (`V4.02.23`).

---

## 1. Identificação e Estabilidade de Conexão WinMM

- Ao conectar a NUX MG-300 por USB, o Windows expõe os endpoints **`NUX NME-300 MIDI IN`** e **`NUX NME-300 MIDI OUT`**, pareados pelo `WinMmMidiAdapter` como porta `duplex` **`NUX NME-300`**.
- **Cache do bridge nativo**: o assembly C# WinMM é compilado e armazenado em cache (`bridge.dll`) no diretório temporário, evitando recompilações repetidas e timeouts na inicialização.
- **Trava contra conexões simultâneas**: o `MidiService` deduplica chamadas concorrentes de `connect()` e evita conflitos entre conexão manual e loop automático de reconexão.
- **Exclusividade WinMM**: o Windows permite que apenas um programa mantenha a porta aberta por vez; feche o **NUX QuickTone** antes de conectar pelo controlador.

---

## 2. Mapeamento MIDI Utilizado pelo Controlador

- **Seleção de Preset (`CC 0x3C` / `60`)**:
  - `[0xB0, 0x3C, slotIndex]` com `slotIndex = 0..35` (`1A..9D`) e `36..71` (`F1A..F9D`).
- **Controle Exclusivo de Volume Master (`CC 0x40` / `64`)**:
  - `[0xB0, 0x40, 0..100]` altera exclusivamente o **Master Volume global** da pedaleira.
  - O backend rejeita qualquer alvo de volume diferente de `master_cc64` (`400 VALIDATION_ERROR`), e mensagens recebidas de outros CCs (como `CC 74` ou `CC 61`) não sobrescrevem o valor confirmado do Master Volume.
  - Mensagens `CC 1..10` (incluindo `CC 7`, que altera o bloco de Delay na MG-300) permanecem bloqueadas quando o editor de presets está desativado (`QUICKTONE_EXPERIMENTAL_EDIT=0`).
- **Editor de Presets de 10 Blocos (ativo por padrão, desativável com `QUICKTONE_EXPERIMENTAL_EDIT=0`)**:
  - Habilita a allowlist validada `CC 1..10` (seleção/bypass dos 10 blocos `COMP..MIC`), `CC 11..58` (parâmetros por bloco), `CC 59` (`IR Cut`), `CC 71` (`IR Volume`) e `CC 74` (`Patch Level`). `CC 70` (limpar nome de User IR) permanece estritamente bloqueado.
  - Gravação permanente via SysEx `0x0E` restrita exclusivamente a slots de Usuário (`0..35` / `1A–9D`), com bloqueio rígido em slots de Fábrica (`36..71`), backup automático pré-sobrescrita, espera por ACK `0x0E` e verificação por readback `0x07 → 0x06`.

---

## 3. Modelo Tri-State e Separação MIDI vs. WebSocket

- A barra superior separa de forma independente o estado da **conexão com o servidor (WebSocket)** do estado da **conexão com a pedaleira (MIDI)**:
  - Quando apenas o WebSocket oscila ou está desconectado, a interface não atribui falha falsa ao cabo MIDI.
  - Quando o servidor está online (`WS Online`) e a pedaleira não está conectada, a interface exibe `MIDI Desconectado` de forma transparente.
- Os comandos mantêm o modelo tri-state (`unknown` → `command_sent_unconfirmed` → `confirmed`) baseado exclusivamente nas confirmações reais recebidas da pedaleira via MIDI IN.
