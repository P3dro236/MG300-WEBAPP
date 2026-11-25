# Guia de Conexão USB-MIDI com a NUX MG-300 — QuickTone Web Controller

Este documento descreve como conectar a pedaleira **NUX MG-300** por USB ao computador host que executa o backend do **QuickTone Web Controller**, detalhando o protocolo MIDI real validado no firmware (`V4.02.23`) e as regras de segurança operacional.

---

## 1. Identificação do Dispositivo USB-MIDI

Ao conectar a NUX MG-300 ao computador por cabo Micro-USB de dados:
- O processador NXP `MIMXRT106x` da pedaleira enumera um dispositivo composto USB 2.0 High-Speed (`VID = 0x1FC9`, `PID = 0x8260`, fabricante `"NUX"`):
  - **Interfaces 0..2**: USB Audio Class 2.0 (`48.000 Hz`, 24-bit stereo).
- **Interface 3**: **USB MIDI Streaming** (`EP 0x04` Bulk OUT / `EP 0x83` Bulk IN), exposta no Windows (`winmm.dll`) em dois endpoints separados que o `WinMmMidiAdapter` emparelha automaticamente como porta `duplex`:
  - **`"NUX NME-300 MIDI IN"`** + **`"NUX NME-300 MIDI OUT"`** → exibida no controlador como **`"NUX NME-300"`** (direction: `duplex`).

> **Importante — Exclusividade da Porta MIDI e Recuperação do `MidiSrv.exe` no Windows**:  
> O driver USB-MIDI padrão do Windows (`winmm.dll` / `wdmaud.drv` / serviço `MidiSrv.exe`) permite apenas **um aplicativo por vez** mantendo `"NUX NME-300"` aberto. Se o aplicativo desktop **NUX QuickTone** (ou uma DAW como REAPER) estiver aberto, o Windows retornará `MMSYSERR_ALLOCATED (4)` (`PORT_BUSY`). Feche o QuickTone desktop antes de clicar em **Conectar MIDI**. Caso um encerramento abrupto de processo deixe um lock residual no serviço Windows `MidiSrv.exe` (impedindo `midiInOpen`/`midiOutOpen` de responder), desconecte e reconecte o cabo USB da pedaleira (ou desligue/religue a MG-300).

---

## 2. Mapeamento MIDI Baseado em Evidências (Sem Presunções)

A análise do firmware da NUX MG-300 (`FUN_00010b86` no NXP `MIMXRT106x`, `FUN_08039c3c`, `FUN_08038d04` e `FUN_08017c34` no `STM32F103xC/D/E`) comprovou diferenças cruciais em relação ao MIDI GM padrão:

### 2.1. Numeração QuickTone (`1A..9D` / `F1A..F9D`) vs Valores MIDI (`0..71`)
- A interface da pedaleira e do QuickTone organiza os 72 presets em **9 bancos de 4 letras (`A, B, C, D`)**:
  - **Bancos de Usuário (`1A` a `9D`)**: índice MIDI interno **`0` a `35` (`0x00..0x23`)**, onde:
    $$\text{slotIndex} = (\text{banco} - 1) \times 4 + \text{indiceLetra} \quad (\text{A}=0, \text{B}=1, \text{C}=2, \text{D}=3)$$
  - **Bancos de Fábrica (`F1A` a `F9D`)**: índice MIDI interno **`36` a `71` (`0x24..0x47`)**, onde:
    $$\text{slotIndex} = 36 + (\text{banco} - 1) \times 4 + \text{indiceLetra}$$
- **Como a MG-300 troca de preset via USB-MIDI**:
  - Embora os parsers `FUN_00010b86` e `FUN_08039c3c` reconheçam o byte de status `0xC0` (Program Change), **não há chamada de despacho para `0xC0`** no firmware V4.02.23 da MG-300 original.
  - Em vez disso, a troca de preset entre o QuickTone e a MG-300 utiliza **`Control Change CC 0x3C` (`CC 60`)**:
    ```
    [0xB0, 0x3C, slotIndex]   // slotIndex = 0..35 (1A..9D) ou 36..71 (F1A..F9D)
    ```
  - Quando o músico troca de preset nos footswitches físicos da pedaleira, o `STM32F103` (`FUN_08017c34`) também transmite `[0xB0, 0x3C, slotIndex]` de volta ao PC via MIDI IN!

### 2.2. Controle de Volume Master vs Patch Level vs Pedal de Expressão
- **Por que `CC 7` é bloqueado por segurança no modo MG-300**:
  - Na função receptora `FUN_08038d04` (`0x08038D04`), os Control Changes **`CC 1` a `CC 10` (`0x01..0x0A`)** controlam a **seleção de modelo e bypass dos 10 blocos de efeito** (`state[0x40A + cc]`). Especificamente, **`CC 7` altera o modelo do bloco de Delay (`DLY`, `state[0x411]`)**!
  - Enviar `CC 7` como se fosse volume master corromperia o efeito de Delay do preset ativo. Por isso, o `MidiService` bloqueia `CC 1..10` como comandos de volume.
- **CCs Reais de Volume Validados no Firmware da MG-300 (`0..100`)**:

| Alvo de Volume | Mensagem MIDI (`Canal 1`) | Campo no `STM32F103` | Destino no DSP | Evidência no Firmware |
|---|---|---|---|---|
| **Master Volume Global (`master_cc64`)** | `[0xB0, 0x40, 0..100]` (`CC 64`) | `state[0x09]` | Frame SPI `tx[0x51]` (`TI TMS320C672x`) | `FUN_08038d04` (`uVar5 == 0x40`), `FUN_08017c34`, `FUN_08016b54` (leitura ADC0 do knob físico `MASTER`). |
| **Patch Level do Preset (`patch_cc74`)** | `[0xB0, 0x4A, 0..100]` (`CC 74`) | `state[0x46F]` (byte `+0x65` do preset) | Frame SPI `tx[0x64]` (`TI TMS320C672x`) | `FUN_08038d04` (`uVar5 == 0x4A`), `FUN_08017c34`, `FUN_08016728` (Bloco 9 `P.LVL`), `FUN_08009c00`. |
| **Pedal de Expressão (`expression_cc61`)** | `[0xB0, 0x3D, 0..100]` (`CC 61`) | `state[0x12]` | Frame SPI `tx[0x4E]` (TI) e SysEx `0x02` `frame[0x1A]` (NXP) | `FUN_08038d04` (`uVar5 == 0x3D`), `FUN_08016d76` (calibração ADC3 do pedal físico). |

---

## 3. Modelo Tri-State de Confirmação do Dispositivo

O QuickTone Web Controller diferencia rigorosamente três estados de sincronismo (`syncStatus`):
1. **`unknown` (Estado Desconhecido)**: Estado inicial antes de receber telemetria da pedaleira ou logo após uma desconexão.
2. **`command_sent_unconfirmed` (Último Comando Enviado)**: Um comando MIDI foi transmitido pelo computador via MIDI OUT (`lastSentCommand`), mas a pedaleira ainda não ecoou/confirmou a alteração via MIDI IN. A interface exibe o selo âmbar **"COMANDO ENVIADO (aguardando confirmação)"** e nunca afirma que o hardware executou a troca sem retorno real.
3. **`confirmed` (Confirmado pela Pedaleira)**: A pedaleira transmitiu uma mensagem MIDI IN (`[0xB0, 0x3C, slot]`, `[0xB0, 0x40|0x4A|0x3D, vol]` ou resposta SysEx read-only `0x18`/`0x06`) confirmando o estado real em execução no hardware (`confirmedState`). A interface exibe o selo verde **"CONFIRMADO"**.

---

## 4. Consultas SysEx Read-Only Suportadas (Protocolo QuickTone)

Além dos CCs `60`, `61`, `64` e `74`, o `MidiService` envia exclusivamente frames SysEx **read-only** validados por `isSafeReadOnlyMg300SysEx` (bloqueando subcomandos de escrita em Flash `0x02`, `0x50`, `0x58`):

| Consulta | Bytes SysEx Transmitidos | Resposta da Pedaleira | Dados Extraídos |
|---|---|---|---|
| **Identidade (`0x00`)** | `F0 00 11 22 66 00 00 F7` | 48 B (`subcmd = 0x10`) | Nome do dispositivo e versão do firmware |
| **Status Global (`0x19`)** | `F0 00 11 22 66 00 70 19 F7` | 17 B (`subcmd = 0x18`) | Slot ativo (`0..71`), Pedal Bypass, Master Volume (`0..100`) |
| **Preset Único (`0x07`)** | `F0 00 11 22 66 00 70 07 <slot> F7` | 113 B (`subcmd = 0x06`) | Nome, Patch Level (`+0x65`), BPM e cadeia de sinal |
| **Todos Presets Usuário (`0x13`)** | `F0 00 11 22 66 00 70 13 F7` | Dumps 113 B (`0x06`/`0x0E`/`0x12`) | Sincronização completa dos slots `1A..9D` |
