# Relatório de Limitações Conhecidas e Estado de Validação de Hardware

Este documento registra com transparência as limitações técnicas do protocolo da **NUX MG-300 (`NUX NME-300`, firmware V4.02.23)**, do ambiente Windows local e o status atual da validação com o hardware físico.

---

## 1. Status da Validação Física com a Pedaleira Real (`NUX MG-300`)

Validação física executada e aprovada com uma **NUX MG-300 real (`NUX NME-300`, `VID=0x1FC9, PID=0x8260`)** conectada via USB ao Windows (`winmm.dll`):
- **Portas WinMM detectadas e emparelhadas (`duplex`)**: `NUX NME-300 MIDI IN` (`MID=0x0001, PID=0x0019`) + `NUX NME-300 MIDI OUT` (`MID=0x0001, PID=0x001A`) → exibida como **`"NUX NME-300"`**.
- **Identidade de Firmware via SysEx (`0x00` → `0x10`)**: **`NUX_MG1X · V01_20191106`**.
- **Sincronização Read-Only da Memória via SysEx (`0x19` → `0x18`, `0x13`/`0x07` → `0x06`)**:
  - Leitura completa dos **36 presets de usuário** gravados na pedaleira (`1A`..`9D`, ex.: `1A "SYSTEM IR"`, `1B "Slash"`, `1C "Black Sa"`, `1D "DAVID GILMOUR"`), incluindo `Patch Level (P.LVL)` e cadeia de sinal.
  - Leitura e confirmação do preset ativo e do Master Volume global (`0..100`).
- **Troca Real de Presets (`CC 0x3C` / `CC 60`) e Volume Master (`CC 0x40` / `CC 64`)**:
  - Validado fluxo completo **Interface/API REST → MIDI OUT (`[0xB0, 0x3C, slot]` e `[0xB0, 0x40, vol]`) → `command_sent_unconfirmed` → readback SysEx `0x18` → `confirmed` via WebSocket `state_sync`**, tanto em presets de usuário (`1D` ↔ `1B`) quanto em presets de fábrica (`F1A`) e ajuste reversível de Master Volume (`24% → 26% → 24%`).
- **Observação empírica sobre `Patch Level` (`CC 0x4A` / `CC 74`)**:
  - O comando `[0xB0, 0x4A, val]` altera o nível em execução na RAM da pedaleira, porém a consulta SysEx de slot (`0x07 → 0x06`) lê o registro armazenado do patch (sem persistência automática em Flash), mantendo o estado em `command_sent_unconfirmed` até que o usuário salve o preset ou receba confirmação via MIDI IN — comportamento fiel à regra de não falsificar confirmação.

---

## 2. Limitações Técnicas Conhecidas da NUX MG-300 e do QuickTone

1. **Acesso Exclusivo à Porta USB-MIDI no Windows (`winmm.dll`)**:
   - O subsistema Windows Multimedia (`winmm.dll`) não permite que dois processos abram simultaneamente a porta `"NUX NME-300"`. Se o software desktop NUX QuickTone estiver aberto, o `QuickTone Web Controller` detectará e reportará o erro `PORT_BUSY` (`Porta MIDI ocupada`).
2. **Confirmação Unidirecional vs Bidirecional (`confirmedState` vs `lastSentCommand`)**:
   - No firmware `V4.02.23` (`FUN_08017c34` e `FUN_08038d04`), quando o músico gira um knob ou pisa em um footswitch **na própria pedaleira**, o `STM32F103` envia imediatamente `[0xB0, 0x3C, slot]` ou `[0xB0, 0x40|0x4A, vol]` para o PC via MIDI IN.
   - Contudo, quando o **PC envia** `[0xB0, 0x3C, slot]` ou `[0xB0, 0x40, vol]` para a pedaleira, a rotina `FUN_08038d04` atualiza simultaneamente o valor atual (`state[2]` / `state[9]`) e o registrador de espelho (`state[0x13A]` / `state[0x13C]`), de modo que o `STM32F103` **não ecoa automaticamente** o mesmo `0xB0` de volta pela UART/USB após receber um CC do host (a menos que uma consulta de status SysEx `subcmd = 0x18` / `0x19` seja solicitada ou o usuário interaja com o pedal).
   - Por fidelidade estrita à regra da Seção 4 (*"Não apresente um comando enviado como confirmação de que a pedaleira executou a alteração"*), o aplicativo mantém o comando como **`command_sent_unconfirmed` ("Comando enviado")** até que uma mensagem real chegue pelo canal MIDI IN da pedaleira.
3. **Ausência de Pasta Padrão Fixa de Presets no QuickTone**:
   - O QuickTone salva apenas `com.nux.quicktone.cfg` (`30 B`) em `Documents\NUX`; os arquivos `.nuxpreset` ficam na pasta escolhida pelo usuário ao exportar (neste computador, encontrados em `CrossDevice\S25+ de Pedro\storage\Download\EaglesDF Crunch.nuxpreset` e `SCORPIONS.nuxpreset`). Quando um arquivo `.nuxpreset` individual formato V1 (`0x209F` B) é exportado isoladamente, ele não grava obrigatoriamente o banco de destino (`1A..9D`), sendo alocado sequencialmente nos slots de usuário disponíveis ou conforme ordenação da pasta.
4. **Program Change Padrão (`0xC0`) Não Despachado no Firmware Original V4.02.23**:
   - A MG-300 original usa `CC 0x3C` (`CC 60`, valores `0..71`) para seleção de preset via USB-MIDI; mensagens `0xC0` puras são ignoradas por `FUN_00010b86` / `FUN_08039c3c`. O `MidiService` implementa ambos (`selectMg300Preset` com `CC 60` por padrão e `sendProgramChange` / `sendBankSelect` na abstração `IMidiAdapter`).
