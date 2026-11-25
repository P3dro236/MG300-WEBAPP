# Inspeção Técnica: Edição e Gravação de Presets pelo Celular — MG300-WEBAPP

> **Tipo:** Relatório Técnico Investigativo (somente leitura)  
> **Equipamento-alvo:** **NUX MG-300 original (`NUX NME-300`, VID `0x1FC9`, PID `0x8260`, firmware `V4.02.23`)** — *não aplicável à MG-300 MKII nem à MG-30*  
> **Restrições respeitadas:** Nenhuma funcionalidade foi implementada, nenhum código-fonte da aplicação foi alterado e nenhum comando MIDI/SysEx de escrita foi enviado à pedaleira. *(Apenas `.gitignore` recebeu `docs/` e este relatório foi salvo em `docs/` conforme solicitado.)*

---

## 1. Resumo Executivo

**Sim — é tecnicamente viável permitir criar, editar em tempo real e gravar presets permanentemente na NUX MG-300 original a partir do celular via Wi-Fi local, sem depender do QuickTone aberto.**

A inspeção estática completa do repositório `NUXMG300-WEBAPP`, do firmware oficial `MG300_EN_V4.02.23.bin` (`STM32F103` + `NXP MIMXRT106x` + `TI TMS320C672x`, via `MG300-RE`) e do executável `QuickTone.exe` (`v2.4.12.27`) comprovou diretamente em código de máquina:

1. **O canal USB-MIDI atual (`WinMmMidiAdapter` + `EP 0x04 OUT` / `EP 0x83 IN`) já transporta todas as mensagens necessárias** (MIDI CC `0xB0` e SysEx longos `F0..F7` de até `4.096 B`).
2. **Nível B (tempo real volátil na RAM)** é suportado nativamente pelo `STM32F103` (`FUN_08038d04`): **`CC 1..10`** ligam/desligam e selecionam modelos dos 10 blocos, **`CC 11..58`** ajustam os 48 parâmetros individuais dos 8 blocos, **`CC 59..74`** ajustam filtro/volume de IR, preset, expressão, Master Volume e Patch Level, e os SysEx **`0x17`** (BPM) e **`0x26`** (nome do User IR) atualizam a RAM sem gravar em Flash.
3. **Nível C (gravação permanente na Flash interna do STM32)** existe nativamente em um único comando SysEx **`subcmd = 0x0E`** de **`113 bytes` (`0x71`)**, validado de forma cruzada tanto no transmissor/receptor do `QuickTone.exe` (`0x004A50C0` / `0x004A5080`) quanto no handler do firmware `STM32F103` (`FUN_080396fa` → `FUN_0803a51e` → `FUN_0803a23a`, Flash IAP de `2 KiB` com wear-leveling em `0x0803D800`/`0x0803E800`), retornando **ACK explícito de 10 bytes (`F0 00 11 22 66 00 70 0E <slot> F7`)**.
4. **Limitação honesta desta etapa (Regra Fundamental):** Como esta fase é estritamente somente leitura e nenhum comando de escrita foi disparado contra a pedaleira física, **a gravação permanente ainda NÃO pode ser classificada como `Confirmada`** — sua classificação oficial permanece **`Parcial` (comprovada em firmware + `QuickTone.exe`, pendente de teste controlado em hardware real com readback e ciclo de energia)**.
5. **Riscos críticos descobertos:** O frame `0x0E` **não possui checksum**, cada gravação apaga e regrava o banco completo de 36 presets (`3.672 B`) com interrupções desligadas (`cpsid i`) por ~`80–150 ms` (consumindo 1 ciclo de wear-leveling dos `10.000` ciclos por banco da Flash STM32), e User IRs (`8 KiB`) residem em outro chip (`NXP MIMXRT106x`, Flash NOR `0x607B8000`) usando protocolo separado (`0x50`/`0x58` com checksum de 14 e 28 bits).

---

## 2. Estado Atual da Arquitetura do `NUXMG300-WEBAPP`

Auditoria completa dos 5 pacotes do monorepo:

| Pacote | Arquivos-chave | Capacidades já existentes | Lacunas para edição e gravação de presets |
|---|---|---|---|
| **`@quicktone/shared`** | `packages/shared/src/mg300-protocol.ts`, `contracts.ts` | Identidade USB (`VID=0x1FC9`, `PID=0x8260`, `NUX NME-300`); tabela de 72 glifos (`MG300_CHAR_TABLE`); codec de nome 1..18 bytes (`+0x44..+0x56`); extração booleana dos 10 blocos (`+0x00..+0x09`); 13 CCs validados; 4 queries SysEx read-only (`0x00`, `0x19`, `0x07`, `0x13`) e parsers de resposta (`0x10`, `0x18`, `0x06`/`0x0E`/`0x12`); 36 presets de fábrica da ROM (`F1A..F9D`); contratos Zod REST/WS/Pareamento. | Não há catálogo tipado de modelos (COMP/EFX/AMP/EQ/NR/MOD/DLY/RVB/CAB/MIC), nem mapeamento dos 57 bytes de parâmetros (`+0x0B..+0x43`), nem codec de User IR name (`+0x57..+0x61`), nem construtores SysEx de escrita (`0x0E`, `0x17`, `0x23`, `0x26`, `0x29`, `0x2C`, `0x50`/`0x58`), nem contratos de editor/rascunho/gravação. |
| **`@quicktone/reader`** | `packages/quicktone-reader/src/parser.ts` | Leitor somente leitura de `.nuxpreset` V1 (`0x209F`), V2 (`0x20A0`), bundle `MG300AllPreset.nuxpreset` (`0x49664`/`0x49688`) e JSON; `buildPresetFromStruct102`; fixtures de teste `buildMg300Struct102` / `buildNuxPresetBinary`. | `buildPresetFromStruct102` descarta o `struct102` bruto e os 57 bytes de parâmetros (mantém apenas nome, `patchVolume`, `irVolume` e booleanos de cadeia); `buildMg300Struct102` usa defaults fixos e não serializa parâmetros editados nem preserva o bloco de `8.237`/`8.241 B` de IR WAV. |
| **`@quicktone/midi`** | `packages/midi-service/src/midi-service.ts`, `winmm-adapter.ts` | Bridge C# WinMM (`bridge.dll` em cache) com suporte completo a **short MIDI TX/RX e SysEx longo TX/RX (`midiOutLongMsg` + 8 buffers de 4.096 B)**; pareamento duplex IN/OUT; seleção de preset (`CC 60`); Master Volume (`CC 64`); queries read-only (`0x00`, `0x19`, `0x07`, `0x13`); reconexão automática; trava `strictMg300Safety`. | `strictMg300Safety` **bloqueia intencionalmente** `CC 1..10`, `CC 11..59` e **todo SysEx de escrita** (`0x0E`, `0x17`, `0x23`, `0x26`, `0x29`, `0x2C`, `0x50`, `0x58`); não há fila transacional de comandos, espera por ACK SysEx com timeout/retry nem mutex de gravação exclusiva. |
| **`@quicktone/backend`** | `packages/backend/src/app.ts`, `state-manager.ts`, `pairing-manager.ts`, `network-security.ts` | Fastify HTTP + `ws` WebSocket; pareamento obrigatório por QR Code com aprovação no desktop; sessão cookie `HttpOnly; SameSite=Strict`; limite rigoroso de 1 celular controlador; proteção contra DNS rebinding (Host/Origin/IP privado); `syncHardwareState()` read-only (`0x00`, `0x19`, `0x13`, `0x07`); controle de preset e Master Volume. | Não retém os `struct102` brutos nem os parâmetros detalhados dos presets sincronizados; sem rotas/eventos para edição em tempo real, backup pré-sobrescrita, gravação transacional em slot ou validação pós-escrita. |
| **`@quicktone/frontend`** | `packages/frontend/src/App.tsx`, `components/StageDisplay.tsx`, `VolumeSlider.tsx`, `PresetGrid.tsx`, `utils/storage.ts` | Interface responsiva desktop/mobile; `StageDisplay` exibe os 9 blocos em modo somente leitura; `VolumeSlider` restrito ao Master Volume; `PresetGrid` (`Usuário` / `Fábrica`); persistência local versionada (`mg300_webapp_storage_v1`) com merge não-destrutivo e recuperação de corrupção; fluxo de pareamento QR. | Zero interface de criação/edição de presets, sem rascunhos de edição, sem controles de parâmetros de amp/cab/efeitos, sem importação/exportação no navegador e sem fluxo assistido de confirmação de slot e progresso de gravação. |

### Topologia de Hardware Comprovada (3 Processadores — `MG300-RE`, `EV-0001..EV-0057`)

```
Celular (Wi-Fi LAN) ──HTTP/WS──► Backend Fastify + MidiService (PC Windows / WinMM)
                                          │ USB 2.0 ("NUX NME-300", VID=0x1FC9, PID=0x8260)
                                          │ IF3 USB-MIDI: EP 0x04 Bulk OUT / EP 0x83 Bulk IN
                                          ▼
                         [1] NXP MIMXRT106x (Stream 0x05, Cortex-M7 @ 600 MHz)
                             • Ponte transparente USB-MIDI ◄──► LPUART1 (115.200 bps)
                             • Intercepta localmente: 0x00 (ID), 0x05, 0x25, 0x50/0x58/0x59 (User IR)
                             • NOR Flash 8 MiB: 36 User IRs de 8 KiB em 0x607B8000..0x607FFFFF
                             • DSP: Amp TSAC-HD (28 modelos) + Cab FIR IR 1.024-tap
                                          │
                                          │ UART 115.200 bps (MIDI 0xB0 CC + SysEx F0..F7)
                                          ▼
                         [2] STM32F103xC/D/E (Stream 0x03, Cortex-M3 @ 72 MHz)
                             • DONO DOS PRESETS, UI LCD E ESTADO GLOBAL (RAM 0x20000000)
                             • Preset ativo em RAM: state[0x40A..0x46F] (102 bytes = 0x66)
                             • CC RX: FUN_08038d04 (RAM volátil) | SysEx RX: FUN_080396fa
                             • 36 Factory Presets em ROM (0x0801917C) + defaults (0x08018F80)
                             • 36 User Presets em Flash interna (36×102 = 3.672 B, páginas 2 KiB):
                               Banco A 0x0803D804 (contador ciclos 0x0803D800) / Banco B 0x0803E800
                                          │
                                          │ SPI bit-banged 128 B @ 50 Hz (SysEx subcmd 0x51)
                                          ▼
                         [3] TI TMS320C672x (Stream 0x02, VLIW FP DSP + SDRAM >= 8 MiB)
                             • Executa COMP, EFX, EQ, NR, MOD, DLY, RVB, Tuner, Drum e Looper
```

---

## 3. Análise Detalhada dos Três Níveis de Edição

### Nível A — Edição Local (Sem Escrever na Pedaleira)

| Capacidade | Viabilidade Atual | Dados Conhecidos (Evidência Direta) | Dados Ainda Pendentes de Extração/Definição |
|---|---|---|---|
| **Criar preset novo no celular** | Alta | Estrutura binária exata `struct102` (102 B) + tabela ROM de defaults `0x08018F80` (`508 B`) contendo o preset-base inicial (`+0x1D9..+0x1FB`) e os 7 bytes padrão de cada modelo de cada bloco. | Converter os 508 B da tabela ROM + JSONs embarcados no `QuickTone.exe` (`MG300_DisplayConfig.json`, `MG300_AmpCabinetDisplayConfig.json`, `MG300_MicDisplayConfig.json`) em catálogo JSON limpo no projeto. |
| **Alterar nome do preset** | Completa | Offset `+0x44` (comprimento `1..18`) + `+0x45..+0x56` (`18 B`), codificados pela tabela validada de 72 caracteres `MG300_CHAR_TABLE` (`0x00='A'`, `0x3E=' '`, nunca null-terminated). | Nenhum bloqueio técnico (validação de caracteres permitidos na UI). |
| **Escolher amplificadores, gabinetes e microfones** | Alta | Offsets `+0x03` (`AMP`: 28 modelos `1..25` guitarra + `26..28` baixo/acústico incl. `Stageman`, com remapeamento de IDs `0x28..0x3B` e `0x3C..0x63` em `FUN_080396fa`/`FUN_00010ad8`), `+0x09` (`CAB/IR`: `0` bypass, `1..25` fábrica, extras, `0x64` User IR), `+0x0A` (`MIC`: `1..4` — SM57, U87, C414, R121), `+0x43` (`IR Hi/Lo Cut`: `0..2`), `+0x62` (`IR Volume`: `0..40`). | Extrair a lista nominal exata de todos os 28 IDs de Amp (incluindo os códigos exatos para baixos/acústicos) e de todos os IDs de Cab do `MG300_AmpCabinetDisplayConfig.json` e `MG300_MicDisplayConfig.json` (evitando misturar entradas da `MG300MK2` e `MG400`). |
| **Configurar blocos de efeito e parâmetros (COMP, EFX, EQ, NR, MOD, DLY, RVB, WAH)** | Alta | Contagem exata na ROM `0x08018F80`: **1 COMP** (2 params), **12 EFX** (até 4 params; modelo 12 tem chave `0xF0 >= 0x80`), **28 AMP** (4–6 params), **1 EQ** (6 bandas `0..100`), **1 NR** (2 params: Sens/Decay), **13 MOD** (até 5 params com chaves `>= 0x80`: Sync/Subdiv/Mode), **6 DLY** (até 6 params com chaves `0xB7`/`0x91`), **4 RVB** (Room, Hall, Plate, Spring; 2–4 params). Estrutura de 7 bytes/bloco em `+0x0B..+0x42` (byte 0 = contagem/tipo UI + bytes 1..6 = parâmetros 1..6). | Mapear nominalmente cada um dos 6 parâmetros de cada um dos 66 modelos (rótulo, unidade, mínimo/máximo e valores discretos para bytes cujo default ROM tem bit 7 ligado `>= 0x80`). |
| **Expressão / Wah / BPM / Patch Level / User IR Metadata** | Alta | `+0x00` Wah/Pedal, `+0x57` User IR Name Len (`0..10` válido; `0x10 = 16` ausente), `+0x58..+0x61` User IR Name (`10 B`), `+0x62` IR Volume (`0..40`), `+0x63` Time/Tap Flag (`0..1`), `+0x64` BPM (`uint8`), `+0x65` Patch Level (`0..100`). | Confirmar fórmula exata de escala do byte BPM em `+0x64` (ex.: `0x78 = 120` BPM observado em todos os 5 factory presets — confirmar faixa min/max e offset se houver) e mapeamento de atribuição do pedal de expressão (se estiver no byte 0 de cada bloco ou em `+0x00`). |
| **Salvar rascunhos no navegador e biblioteca pessoal** | Completa | `localStorage` já implementado e versionado (`mg300_webapp_storage_v1`), bastando estender o schema (v2) para armazenar rascunhos com `struct102` + metadados sem afetar os presets da pedaleira. | Apenas implementação da camada de dados e UI (respeitando cota do `localStorage` caso armazene IRs WAV de 8 KiB — para biblioteca grande com IRs, preferir IndexedDB). |
| **Exportar e importar presets (`.nuxpreset` / JSON)** | Alta | Formato binário `"MG300 Preset Data"` V1 (`8.380 B`) e V2 (`8.381 B`) + bundle 36 presets (`300.673`/`300.709 B`) já totalmente decodificados em `@quicktone/reader`. | Serializador completo que embute o `struct102` editado + chunk IR WAV de `8.237`/`8.241 B` (vazio/zerado quando usa Cab de fábrica, ou WAV 48 kHz 1024-tap quando usa User IR). |

---

### Nível B — Alteração em Tempo Real (Sem QuickTone)

Comprovado diretamente na desmontagem de **`FUN_08038d04`** (`0x08038D04..0x08039680`, `Stream 0x03`): **é possível alterar todos os blocos, modelos e parâmetros individuais em tempo real a partir do celular via backend**, usando MIDI CC (`0xB0`) e dois SysEx voláteis (`0x17`, `0x26`).

#### Mapeamento Completo de MIDI CC (`FUN_08038d04`)

| Faixa / Número CC (Dec / Hex) | Alvo em RAM STM32 (`0x20000000`) | Função Exata no Firmware | Faixa / Observações | Suportado hoje no projeto? |
|---|---|---|---|---|
| `CC 1..10` (`0x01..0x0A`) | `state[0x40B..0x414]` (`struct102[1..10]`) | Seleciona modelo ou desativa (`0` = bypass) os 10 blocos: `1`=COMP, `2`=EFX, `3`=AMP, `4`=EQ, `5`=NR, `6`=MOD, `7`=DLY, `8`=RVB, `9`=CAB/IR, `10`=MIC | **Efeito colateral crítico**: ao enviar `val > 0` em `CC 1..8`, o STM32 copia os 7 bytes do cache RAM daquele modelo (`state[0x18F..]`) para os parâmetros ativos (`0x415..`)! Enviar `CC 3 = 0` (AMP off) também zera `CAB` (`0x413`). Enviar `CC 9 = 0x64` (User IR) é ignorado se `state[0x461] >= 11` (sem User IR). | **Bloqueado** por `strictMg300Safety` |
| `CC 11..16` (`0x0B..0x10`) | `state[0x416..0x41B]` | 6 parâmetros do bloco **COMP** | `0..100` (ou `val & 0x0F` se byte RAM `>= 0x80`) | **Bloqueado** |
| `CC 17..22` (`0x11..0x16`) | `state[0x41D..0x422]` | 6 parâmetros do bloco **EFX** | `0..100` (ou nibble se `>= 0x80`) | **Bloqueado** |
| `CC 23..28` (`0x17..0x1C`) | `state[0x424..0x429]` | 6 parâmetros do bloco **AMP** (Gain, Level, Bass, Mid, Treble, Bias) | `0..100` — encaminhados ao NXP (`0x20006270[1..6]`) com suavização IIR (`alpha=0.0204`) | **Bloqueado** |
| `CC 29..34` (`0x1D..0x22`) | `state[0x42B..0x430]` | 6 bandas do bloco **EQ** | `0..100` | **Bloqueado** |
| `CC 35..40` (`0x23..0x28`) | `state[0x432..0x437]` | 6 parâmetros do bloco **NR** (Noise Gate) | `0..100` (Sens, Decay) | **Bloqueado** |
| `CC 41..46` (`0x29..0x2E`) | `state[0x439..0x43E]` | 6 parâmetros do bloco **MOD** | `0..100` (ou nibble em chaves Sync/Mode `>= 0x80`) | **Bloqueado** |
| `CC 47..52` (`0x2F..0x34`) | `state[0x440..0x445]` | 6 parâmetros do bloco **DLY** | `0..100` (ou nibble em Subdiv/Sync `>= 0x80`); mexer em `CC 47` (Time) zera `TimeFlag` (`0x46D`) | **Bloqueado** |
| `CC 53..58` (`0x35..0x3A`) | `state[0x447..0x44C]` | 6 parâmetros do bloco **RVB** | `0..100` | **Bloqueado** |
| `CC 59` (`0x3B`) | `state[0x44D]` | Filtro High/Low Cut do **CAB/IR** | `0`, `1` ou `2` | **Bloqueado** |
| `CC 60` (`0x3C`) | `state[0x002]` + `FUN_0803b1bc` | Seleção de preset (`0..35` Usuário, `36..71` Fábrica) | Carrega da Flash/ROM descartando edições não salvas na RAM | **Sim (validado)** |
| `CC 61` (`0x3D`) | `state[0x012]` | Posição do Pedal de Expressão | `0..100` | Mapeado, fora da UI |
| `CC 62` (`0x3E`) | `state[0x000]` + zera `0x40A` | Pedal Bypass / Wah switch | `0..1` | Mapeado, fora da UI |
| `CC 64` (`0x40`) | `state[0x009]` | **Master Volume** global | `0..100` | **Sim (validado, único fader ativo)** |
| `CC 66` (`0x42`) | `state[0x143]` | Bloco focado no LCD | `0..8` ou `0x14` (`9` = P.LVL) | Mapeado, fora da UI |
| `CC 67..69` (`0x43..0x45`) | `state[0x3FD, 0x3FB, 0x3FC]` | USB Audio Routing, Record Level, Playback Level | `0..2`, `0..100`, `0..100` | Mapeado, fora da UI |
| `CC 70` (`0x46`) | `state[0x461] = 0x10`, desativa `0x413` se `0x64` | Limpa metadados de User IR na RAM | **Atenção:** operação destrutiva de metadado de User IR | **Bloqueado** |
| `CC 71` (`0x47`) | `state[0x46C]` | IR Cab Volume | `0..40` | Mapeado, fora da UI |
| `CC 74` (`0x4A`) | `state[0x46F]` | Patch Level (`P.LVL`) do preset ativo | `0..100` | Mapeado, bloqueado em `setVolume` |

#### Diferença Fundamental: Tempo Real (Volátil) vs. Gravação Permanente

- **NENHUM MIDI CC (`0xB0`) aciona escrita em Flash (`FUN_0803a23a`)**. Todos os CCs acima alteram exclusivamente a RAM ativa (`0x20000000`), propagando-se em ~`15 ms` ao NXP (`subcmd = 0x02`) e em `20 ms` ao TI DSP (`subcmd = 0x51`).
- **SysEx voláteis complementares (RAM apenas):**
  - `subcmd = 0x17` (`12 B`): altera BPM (`state[0x46E]`) e ativa `TimeFlag = 1` (`state[0x46D]`) na RAM.
  - `subcmd = 0x26` (`21 B`): atualiza os 11 bytes de nome de User IR (`state[0x461..0x46B]`) na RAM.
- **Limitação do Nível B:** Alterar o **nome do preset** não possui CC dedicado (requer SysEx `0x0E`). Além disso, ao trocar de preset (`CC 60`) ou desligar a pedaleira, **todas as alterações feitas por CC/RAM são perdidas**.

---

### Nível C — Gravação Permanente na Pedaleira (Ponto Principal)

A desmontagem cruzada do **`STM32F103` (`FUN_080396fa` @ `0x08039772..0x08039ACE` → `FUN_0803a51e` → `FUN_0803a23a`)** e do **`QuickTone.exe` (`0x004A50C0` e `0x004A5080`)** revelou a mecânica completa da gravação permanente na NUX MG-300 original.

#### 1. Estrutura Binária Completa do Preset (`struct102` = `102 bytes` = `0x66`)

| Offset `struct102` | Offset no SysEx `0x06`/`0x0E` (113 B) | Tamanho | Campo | Codificação / Regras Comprovadas |
|---|---:|---:|---|---|
| `+0x00..+0x0A` | `[9..19]` | `11 B` | Estados/Modelos dos blocos | `[0]` Pedal/Wah, `[1]` COMP, `[2]` EFX, `[3]` AMP, `[4]` EQ, `[5]` NR, `[6]` MOD, `[7]` DLY, `[8]` RVB, `[9]` CAB/IR ID (`0x64` = User IR), `[10]` MIC ID (`1..4`). |
| `+0x0B..+0x42` | `[20..75]` (`0x14..0x4B`) | `56 B` | Parâmetros dos 8 blocos (`8 × 7 B`) | Cada bloco ocupa 7 bytes: `byte 0` = contagem/tipo UI + `bytes 1..6` = parâmetros `1..6`. **Regra crítica 7-bit SysEx:** no TX (`FUN_080174d6`), bytes `>= 0x80` são mascarados com `& 0x0F`; no RX (`FUN_080396fa`), o STM32 pré-carrega os 7 bytes do modelo na ROM (`0x08018F80`) e, onde o byte ROM for `>= 0x80`, preserva o nibble alto (`rom & 0xF0`) e aplica `rx & 0x0F`. |
| `+0x43` | `[76]` (`0x4C`) | `1 B` | Filtro Cab IR (Hi/Lo Cut) | `0`, `1` ou `2` (biquads em `FUN_00005124`). |
| `+0x44` | `[77]` (`0x4D`) | `1 B` | Comprimento do nome | `1..18` (`0x01..0x12`). |
| `+0x45..+0x56` | `[78..95]` (`0x4E..0x5F`) | `18 B` | Caracteres do nome | Índices `0x00..0x47` em `MG300_CHAR_TABLE` (`0x00='A'`, `0x3E=' '`; nunca usar `0x00` como terminador nulo). |
| `+0x57` | `[96]` (`0x60`) | `1 B` | Comprimento do nome do User IR | `0..10` (`0x00..0x0A`) = User IR presente; **`0x10` (`16`) = sem User IR**. |
| `+0x58..+0x61` | `[97..106]` (`0x61..0x6A`) | `10 B` | Nome do User IR | Até 10 caracteres codificados pela mesma tabela de glifos. |
| `+0x62` | `[107]` (`0x6B`) | `1 B` | IR Volume | `0..40` (`0x00..0x28`). |
| `+0x63` | `[108]` (`0x6C`) | `1 B` | Time / Tap Tempo Flag | `0` (ms) ou `1` (sync BPM). |
| `+0x64` | **`[109]` e `[110]`** (`0x6D..0x6E`) | `1 B` *(2 B no fio)* | BPM codificado | No SysEx (113 B) é dividido em **2 nibbles MIDI-safe**: `[109] = bpm >> 4`, `[110] = bpm & 0x0F`. No STM32 é recomposto: `(msg[0x6D] << 4) \| msg[0x6E]`. |
| `+0x65` | `[111]` (`0x6F`) | `1 B` | Patch Level (`P.LVL`) | `0..100` (padrão `50 = 0x32`). |

#### 2. Inventário Completo dos Comandos SysEx (Leitura vs. Escrita Permanente)

Cabeçalho comum: **`F0 00 11 22 66 00 70 <subcmd> ... F7`** (`00 11 22` = Cherub/NUX, `66 00` = Product ID MG-300, `70` = tag de comando).

| Operação | `subcmd` | Frame TX (Host → Pedal) | Tamanho TX | Resposta / ACK (Pedal → Host) | Persiste após desligar? | Checksum? |
|---|---|---|---:|---|---|---|
| Identidade | `0x00` (`[6]=0x00`) | `F0 00 11 22 66 00 00 F7` | `8 B` | `48 B` (`[6]=0x10`, `"V01_20191106"`, `"NUX_MG1X"`) | Leitura | Não |
| Status global | `0x19` | `F0 00 11 22 66 00 70 19 F7` | `9 B` | `17 B` (`[7]=0x18`) | Leitura | Não |
| Ler 1 preset | `0x07` | `F0 00 11 22 66 00 70 07 <slot:0..71> F7` | `10 B` | `113 B` (`[7]=0x06`, `<slot>`, payload, `F7`) | Leitura | Não |
| Ler todos (36 user) | `0x13` | `F0 00 11 22 66 00 70 13 F7` | `9 B` | `36 × 113 B` (`[7]=0x06`) | Leitura | Não |
| **Gravar preset completo (commit imediato em Flash STM32)** | **`0x0E`** | `F0 00 11 22 66 00 70 0E <slot:0..35> <103B payload 7-bit> F7` | **`113 B`** *(aceita 112 B legado)* | **`10 B` ACK explícito**: `F0 00 11 22 66 00 70 0E <slot> F7` | **SIM** (`FUN_0803a51e` → `FUN_0803a23a` Flash IAP) | **NÃO** |
| Gravar só nome User IR (11 B) em Flash STM32 | `0x23` | `F0 00 11 22 66 00 70 23 <slot:0..35> <11B> F7` | `21 B` | Sem ACK dedicado | **SIM** (`FUN_0803a5fc` → `FUN_0803a23a`) | Não |
| Trocar (Swap) 2 slots de usuário em Flash STM32 + IR NXP | `0x2C` | `F0 00 11 22 66 00 70 2C <slotA:0..35> <slotB:0..35> F7` | `11 B` | **`11 B` Eco ACK**: `F0 00 11 22 66 00 70 2C <slotA> <slotB> F7` | **SIM** (`FUN_0803a36e` + NXP `0x02` swap) | Não |
| Copiar User IR entre slots (NXP NOR Flash) | `0x29` | `F0 00 11 22 66 00 70 29 <src> <dst> F7` | `11 B` | Sem ACK direto STM32 | **SIM** (NXP `FUN_0000fb3c`) | Não |
| **Upload/Commit de User IR WAV (`8 KiB`) no NXP** | **`0x50` / `0x58`** | Sequência de pacotes `128 B`: `0x50` init (`slot 0..35`) → `84×` `0x58` (`14×7=98 B` + checksum 14-bit) → `0x58` (`0x7F7F7F` soma 28-bit) → `0x50` (`0x1FFFFF` commit Flash) | `128 B / pkt` | ACK por pacote: `0x66` OK, `0x44` erro checksum, `0x76` commit OK | **SIM** (`FUN_00012014` → `FUN_0000fb3c` em `0x607B8000`) | **SIM** (14-bit/pkt + 28-bit global) |

#### 3. Restrições Críticas de Endereçamento, Timing, Integridade e Desgaste de Flash

- **Endereçamento de slots:** Apenas **slots de usuário `0..35` (`1A..9D`)** são graváveis. Em `FUN_080396fa` (`0x08039790: cmp r0, #0x24; bge exit`), qualquer tentativa com `slot >= 36` (`F1A..F9D`, que estão em ROM `0x0801917C`) é descartada silenciosamente sem gravação e sem ACK.
- **Comando único de escrita + commit:** Para os 102 bytes do preset no STM32, **não há comando separado de "staging" e "commit"** — o próprio `subcmd = 0x0E` carrega o preset na RAM ativa, apaga as 2 páginas de `2 KiB` do banco ativo de Flash (`0x0803D800` ou `0x0803E800`), regrava todos os 36 presets (`3.672 B`) em Flash e emite o ACK `10 B` somente **depois** que `FUN_0803a51e` retorna.
- **Tempo de bloqueio de Flash e intervalo entre mensagens:** `FUN_0803a23a` executa `cpsid i` (desabilita todas as interrupções do STM32) durante o apagamento de 2 páginas (`40–80 ms`) e programação de ~`1.838` meias-palavras (`40–65 ms`), totalizando ~**`80–150 ms` de bloqueio real de UART/DMA**. Por isso:
  - O `QuickTone.exe` aguarda ACK com **timeout de `1.000 ms` (`0x3E8`)**.
  - **Nunca** enviar dois frames `0x0E` consecutivos sem receber o ACK de 10 bytes do anterior e respeitar folga de segurança (`>= 200 ms`) antes do readback `0x07`.
- **Desgaste de Flash (Wear-Leveling):** O STM32 conta gravações em `*(uint32*)0x0803D800` até `10.000` (`0x2710`), migrando então para o Banco B (`0x0803E800`) para mais `10.000` ciclos. **Edição interativa de knobs jamais pode enviar `0x0E`** — deve usar exclusivamente MIDI CC (Nível B) e disparar `0x0E` apenas sob ação explícita de "Salvar" do músico.
- **Ausência de checksum em `0x0E`:** Como o protocolo `0x0E` não valida CRC nem soma de verificação, um byte corrompido ou truncado seria gravado sem rejeição. Portanto, **todo `0x0E` exige obrigatoriamente pós-validação via `0x07 → 0x06`** comparando os 102 bytes lidos da Flash com o `struct102` enviado (respeitando a máscara 7-bit `& 0x0F` nos bytes `>= 0x80`!).
- **Risco de queda de energia durante `0x0E`:** Como o STM32 apaga e reescreve os 36 presets no mesmo banco em Flash, queda de energia exatamente durante os ~`100 ms` de `FUN_0803a23a` pode zerar/corromper o banco de usuário — reforçando a obrigatoriedade de backup completo dos 36 slots antes da primeira gravação da sessão.

---

## 4. Engenharia Reversa do QuickTone e Procedimento Controlado de Captura

### 4.1. Separação Rigorosa de Evidências

| Categoria | O que está provado hoje |
|---|---|
| **Documentado / Verificado em Firmware (`MG300_EN_V4.02.23.bin`) e Binário (`QuickTone.exe` v2.4.12.27)** | Arquitetura de 3 chips; USB `VID=0x1FC9/PID=0x8260` (`"NUX NME-300"`); layout completo `struct102` (102 B); `CC 0x01..0x4A` em `FUN_08038d04`; SysEx `0x00`, `0x02`, `0x05`, `0x06`, `0x07`, `0x0E` (113 B + ACK 10 B), `0x13`, `0x17`, `0x18`, `0x19`, `0x23`, `0x25`, `0x26`, `0x29`, `0x2C`, `0x50`/`0x58`/`0x59` (User IR 8 KiB); `QuickTone.exe` `0x004A50C0` (`0x0E` 113 B) e `0x004A5080` (ACK 10 B); JSONs embarcados (`MG300_DisplayConfig.json`, `MG300_AmpCabinetDisplayConfig.json`, `MG300_MicDisplayConfig.json`). |
| **Observado em Capturas ao Vivo na Pedaleira Física (`NUX NME-300`)** | Leitura de identidade (`0x00 → 0x10`: `NUX_MG1X · V01_20191106`), status global (`0x19 → 0x18`), leitura completa dos 36 slots de usuário (`0x07 → 0x06`, 113 B, comprovando nome de 18 bytes `"Metallica Kirk H."` no slot `3C` e campo User IR len em `+0x57`), troca de preset (`CC 60`) e Master Volume (`CC 64`). |
| **Hipotético / Pendente de Validação Empírica ao Vivo** | Sequência exata de mensagens auxiliares que o QuickTone envia **antes e depois** de clicar "Save" (ex.: se envia `0x23`, `0x26` ou `0x17` em conjunto com `0x0E`); comportamento ao vivo de `CC 1..59` sobre o áudio/LCD sem travar; comportamento do subcomando `0x73` (presente em `FUN_080396fa` como no-op de retorno rápido); fórmula exata de todos os valores discretos `>= 0x80` nos blocos EFX/MOD/DLY; comprovação física de escrita `0x0E` + readback `0x07` + **persistência após desligar e religar a MG-300**. |

### 4.2. Ferramentas Adequadas no Windows (Armadilha Crítica do WinMM!)

> **Atenção crítica no Windows:** A API `winmm.dll` abre a porta `"NUX NME-300"` em **modo exclusivo** — apenas 1 processo pode usá-la por vez. Logo, ferramentas comuns como MIDI-OX ou Pocket MIDI **não conseguem escutar passivamente** o tráfego enquanto o QuickTone está conectado!

1. **Ferramenta Principal Recomendada: Wireshark + USBPcap (captura passiva a nível de kernel USB)**
   - Captura 100% do tráfego USB real entre `QuickTone.exe` e `"NUX NME-300"` sem interferir no acesso exclusivo WinMM e sem risco de corromper timing.
   - Filtro de exibição Wireshark: `usb.endpoint_address == 0x04 || usb.endpoint_address == 0x83` (Interface 3 USB-MIDI: Bulk OUT `0x04` e Bulk IN `0x83`), onde cada evento USB-MIDI tem 4 bytes `[CIN, b0, b1, b2]`.
   - Um script Python simples remove o byte `CIN` de cada pacote de 4 bytes e reconstrói integralmente os frames `0xB0` e `F0..F7` com timestamp em microssegundos!
2. **Ferramentas Auxiliares (testes isolados sem QuickTone):**
   - **Pocket MIDI** ou **MIDI-OX**: úteis apenas para inspeção manual de respostas read-only ou replay controlado de um único frame após fechar o QuickTone.
   - **loopMIDI** (Tobias Erichsen): útil apenas para testes offline/simulados, pois o QuickTone filtra dispositivos pelo nome `"NUX NME-300"` e não se conecta a portas virtuais arbitrárias sem renomeação.

### 4.3. Procedimento Controlado de Captura em 10 Passos (Para Execução Futura Autorizada)

1. **Backup total obrigatório:** Com o QuickTone oficial aberto (ou via nosso `queryAllPresets` read-only), exportar `MG300AllPreset.nuxpreset` (todos os 36 slots de usuário + User IRs) e salvar cópia com hash SHA-256 em local seguro.
2. **Escolher um slot descartável:** Selecionar o último slot de usuário não personalizado — ex.: **`9D` (`slotIndex = 35 = 0x23`)**, verificando antes que contém apenas cópia de fábrica (`EmotiveBallad`).
3. **Iniciar captura passiva:** Abrir Wireshark com USBPcap no hub USB da `"NUX NME-300"`, iniciar gravação `.pcapng` com filtro `EP 0x04 / 0x83`.
4. **Capturar leitura baseline:** No QuickTone, selecionar o slot `9D` e registrar o tráfego inicial (`CC 60`, `0x07 → 0x06`, `0x19 → 0x18`).
5. **Capturar edição de 1 parâmetro contínuo:** Alterar apenas **Amp Gain** (ex.: de `50` para `65`) e anotar timestamp — validar `B0 17 41` (`CC 23 = 65`) e ausência de escrita em Flash.
6. **Capturar troca de modelo de bloco e parâmetro discreto (`>= 0x80`):** Alternar um modelo de Delay/Modulação e alterar sua subdivisão/sync — confirmar `CC 6`/`CC 7` e o valor 7-bit enviado para bytes discretos.
7. **Capturar edição de nome + clique em "Save" no slot `9D`:** Renomear o slot `9D` para `"TESTE SAVE 9D"` e clicar em **Save**. Registrar **todos** os frames TX/RX, sua ordem, intervalos em ms e o ACK `F0 00 11 22 66 00 70 0E 23 F7`.
8. **Capturar troca de slot + retorno (teste de persistência em RAM/Flash):** Trocar para `9C` e voltar para `9D`, verificando se a edição permaneceu e se `0x07 23` devolve exatamente o mesmo `struct102`.
9. **Teste de persistência em ciclo de energia (Power Cycle):** Fechar QuickTone, desligar fisicamente a fonte da MG-300 por 10 s, religar, abrir apenas consulta read-only `0x07 23` e comparar byte-a-byte o `struct102` retornado.
10. **Restauração e análise:** Comparar os `.pcapng` capturados contra o modelo derivado do firmware (`FUN_080396fa` / `FUN_08038d04`), validar 100% dos bytes e restaurar o slot `9D` original a partir do backup do Passo 1.

---

## 5. Compatibilidade com a Arquitetura Mobile Existente

O fluxo arquitetural do `NUXMG300-WEBAPP` é **100% compatível** com edição e gravação pelo celular, desde que respeite a fronteira de autoridade já estabelecida:

```
[Celular (Browser)] ──HTTPS/HTTP+WS (Sessão única QR + Cookie HttpOnly)──► [Backend Fastify (PC)]
                                                                                 │
                                                            [PresetEngine + WriteTransactionLock]
                                                                                 │
                                                                    [MidiService + Fila FIFO]
                                                                                 │
                                                                       [WinMM -> NUX NME-300]
```

**Requisitos obrigatórios de segurança e confiabilidade para o ambiente Wi-Fi mobile:**

1. **Celular nunca envia MIDI/SysEx bruto:** O celular envia apenas intenções semânticas validadas por Zod (ex.: `PATCH /api/editor/param`, `POST /api/presets/save` com `{ slotIndex, draftPreset, confirmOverwriteSlot }`). O backend constrói, valida faixas e serializa os bytes MIDI/SysEx — mantendo `strictMg300Safety` ativo com allowlist explícita.
2. **Controle de concorrência (Sessão única + Mutex de escrita):**
   - O `PairingManager` já garante **no máximo 1 celular controlador por vez**.
   - Ainda assim, o desktop local e o celular pareado coexistem! Toda operação de gravação (`0x0E`/`0x2C`/`0x50`) deve adquirir um **`DeviceTransactionLock`** exclusivo no backend, pausando `syncHardwareState()`, bloqueando trocas de preset (`CC 60`) concorrentes e notificando todos os clientes via WebSocket (`device_busy_saving`).
3. **Fila de comandos MIDI com duas prioridades:**
   - **Fila de Tempo Real (Nível B — CC):** coalescência (*coalescing/throttling* a cada `25–35 ms` por CC) para arrasto suave de sliders no celular sem enfileirar centenas de CCs na UART de `115.200 bps`.
   - **Fila Transacional (Nível C — SysEx):** execução estritamente sequencial (1 transação em voo), aguardando ACK `10 B` (`timeout = 1.500 ms`) + pausa mínima de `200 ms` antes do readback.
4. **Proteção contra queda de Wi-Fi no meio da operação:**
   - A gravação é enviada do celular em uma **única requisição HTTP atômica** contendo o preset completo validado (`idempotencyKey`). Uma vez recebida e validada pelo backend no PC (ligado via USB à pedaleira), **uma queda de Wi-Fi do celular não interrompe o pacote USB-MIDI de 113 bytes** nem deixa a Flash pela metade; ao reconectar o WS, o celular recebe o resultado final (`saved_verified` ou `error`).
5. **Backup automático pré-sobrescrita:** Antes de emitir `0x0E` para um slot `S`, o backend lê o slot atual via `0x07 S` (`113 B`), salva um snapshot datado em disco local (`backups/<timestamp>_slot_<S>.bin` + JSON) e mantém um histórico de restauração de 1 clique.
6. **Confirmação explícita de slot destino:** A API e a UI mobile **rejeitam `slotIndex >= 36` (`F1A..F9D`)** e exigem confirmação explícita mostrando o nome atual do slot a ser sobrescrito (ex.: *"Sobrescrever slot `4C` ('Solo Crunch') por 'Lead Novo'?"*).
7. **Recuperação de erro e validação pós-gravação obrigatória:**
   - Sequência fechada: `Lock` → `Backup (0x07)` → `Write (0x0E)` → `Aguardar ACK 10B (timeout 1.5s)` → `Aguardar 200ms` → `Readback (0x07)` → `Comparação byte-a-byte dos 102B (normalizando máscara 7-bit)`.
   - Se o ACK expirar ou o readback divergir, o backend reporta falha explícita (`WRITE_VERIFICATION_FAILED`), preserva o backup capturado e oferece botão explícito de "Restaurar backup" ou "Tentar novamente" (sem retry cego infinito para não desgastar a Flash).

---

## 6. Diferenças de Firmware e Modelo de Hardware

Esta investigação e todos os offsets/comandos acima aplicam-se **EXCLUSIVAMENTE à NUX MG-300 original (`NUX NME-300`)**. A inspeção de `QuickTone.exe` v2.4.12.27 e do firmware `MG300_EN_V4.02.23.bin` comprova incompatibilidades estruturais com os modelos irmãos:

| Característica | **NUX MG-300 Original** *(Alvo deste projeto)* | **NUX MG-300 MKII** *(Incompatível)* | **NUX MG-30** *(Incompatível)* |
|---|---|---|---|
| **USB Product Name** | **`NUX NME-300`** | `NUX MG-300V2` | `NUX MG-30` |
| **USB VID / PID (operação)** | `0x1FC9` (NXP) / `0x8260`, `bcdDevice=0x0100` | Diferente | Diferente |
| **USB VID / PID (DFU HID)** | `0x9527` / `0xC157` (`MG-300`) | Diferente | Diferente |
| **SysEx Product ID (`msg[4]`)** | **`0x66`** (`F0 00 11 22 66 00 ...`) | Outro Product ID | Outro Product ID |
| **Identidade SysEx (`0x00 → 0x10`)** | `NUX_MG1X · V01_20191106` *(nota: esta string fixa vem do `M7APP` do firmware `V4.02.23`!)* | Outra string | Outra string |
| **Arquitetura de hardware** | 3 chips: `NXP MIMXRT106x` + `STM32F103xC/D/E` + `TI TMS320C672x` | Hardware/plataforma revisada com suporte a Scenes (`Scene_Button_Copy`), mais blocos/IRs | Hardware diferente (display 4", dual DSP/NXP, Scenes) |
| **Formato de preset** | `"MG300 Preset Data"`, `.nuxpreset`, `102 B` (`0x66`) + `8 KiB` IR, 36 User (`1A..9D`) + 36 Factory (`F1A..F9D`) | `MG300MK2AllPatch.mg300MK2patch`, `MG300MK2_DisplayConfig.json`, suporte a Scenes e coleção separada `IRCollection` | Formato próprio MG-30 |
| **Variação entre firmwares da própria MG-300 original** | Firmware `V4.02.23` usa frames `0x0E`/`0x06` de **113 B** (com `PatchLevel` em `[111]` e `Stageman`/novos IRs) e mantém compatibilidade retroativa com frames legados de **112 B** (sem `PatchLevel` e `CAB=0x1A` → `0x64`). Firmwares muito antigos (`v1.x`/`v2.x`) podem não possuir o amp `Stageman` (`#28`) ou os IRs de baixo/violão adicionados na `V3/V4`. | — | — |

**Regra de segurança obrigatória antes de habilitar escrita:** O backend deve exigir **verificação de identidade positiva** (`porta = NUX NME-300` + resposta SysEx `0x10` contendo `NUX_MG1X` + resposta `0x06` de `113 bytes`), bloqueando automaticamente qualquer escrita caso detecte outro modelo ou resposta inesperada.

---

## 7. Classificação Técnica da Viabilidade

> **Regra Fundamental aplicada:** Nenhuma operação de gravação permanente pode ser declarada **`Confirmada`** sem demonstração prática em hardware real com escrita efetiva, releitura (`readback`) e verificação de persistência após desligar e religar a pedaleira. Como esta fase é estritamente investigativa/somente leitura, os itens de escrita permanecem em **`Parcial`**.

| Capacidade | Classificação | Justificativa Técnica Baseada em Evidências |
|---|---|---|
| **Criar preset localmente** | **`Parcial`** | Layout completo de `102 B` (`struct102`), tabela ROM de defaults (`0x08018F80`) e formato `.nuxpreset` V1/V2 são conhecidos; falta extrair/estruturar o catálogo nominal completo dos 66 modelos/parâmetros a partir dos JSONs embarcados no `QuickTone.exe` e implementar o modelo de domínio. |
| **Editar parâmetros localmente** | **`Parcial`** | Todos os offsets de blocos (`+0x00..+0x0A`), 57 bytes de parâmetros (`+0x0B..+0x43`), nome (`+0x44..+0x56`), User IR name (`+0x57..+0x61`), IR Vol, TimeFlag, BPM e PatchLevel estão mapeados no firmware; falta o catálogo de metadados de UI/faixas e o editor no frontend. |
| **Alterar parâmetros em tempo real** | **`Parcial`** | O firmware `FUN_08038d04` comprova 100% dos CCs (`0x01..0x4A`) e os SysEx voláteis (`0x17`, `0x26`), e `CC 60`/`CC 64` já estão **confirmados** em hardware real; porém `CC 1..59` ainda estão bloqueados por `strictMg300Safety` e não foram testados ao vivo na pedaleira. |
| **Enviar preset completo** | **`Parcial`** | O frame SysEx `subcmd = 0x0E` de `113 B` (`F0 00 11 22 66 00 70 0E <slot> <103B> F7`) está 100% verificado estaticamente em ambos os lados (`QuickTone.exe` `0x004A50C0` e `STM32` `FUN_080396fa`), mas ainda **não foi transmitido nem validado em hardware real**. |
| **Gravar permanentemente em um slot** | **`Parcial`** *(NÃO confirmada em hardware)* | O caminho completo de persistência na Flash interna do `STM32F103` (`0x0E` → `FUN_0803a51e` → `FUN_0803a23a` → ACK `10 B`) está provado em código de máquina, **mas ainda não foi comprovado empiricamente via escrita real + readback + ciclo de energia (desligar/religar) em slot descartável**. |
| **Ler novamente e validar a gravação** | **`Parcial`** | A leitura read-only `0x07 → 0x06` (`113 B`) já está **confirmada em hardware real** nos 36 slots da MG-300; falta validar o ciclo integrado de comparação pós-gravação (incluindo normalização dos nibbles 7-bit de parâmetros `>= 0x80` e checagem após power-cycle). |

---

## 8. Lacunas Remanescentes e Riscos Técnicos

1. **Catálogo exato de parâmetros por modelo (66 modelos):** Os JSONs embarcados no `QuickTone.exe` (`MG300_DisplayConfig.json`, `MG300_AmpCabinetDisplayConfig.json`, `MG300_MicDisplayConfig.json`) existem e já foram localizados no binário, mas precisam ser extraídos em tabela limpa e separados das entradas de `MG300MK2` e `MG400`, mapeando especialmente cada parâmetro discreto cujo default ROM tem bit 7 ligado (`>= 0x80`).
2. **Validação empírica ao vivo (Wireshark + USBPcap em slot descartável `9D`):** Confirmar se o QuickTone envia algum frame auxiliar ao salvar (ex.: `0x23` ou `0x17`) e comprovar persistência física após desligar/religar a pedaleira.
3. **Sem checksum em `0x0E` + apagamento de banco inteiro em Flash:** Exige política rigorosa de backup pré-escrita, bloqueio de gravações concorrentes, validação rígida de faixas `< 0x80` em todos os 103 bytes de payload e readback obrigatório após cada save.
4. **Wear-leveling finito (`20.000` ciclos totais na Flash STM32):** Qualquer bug de loop/autosave disparando `0x0E` repetidamente danificaria a Flash interna; implementar rate-limiter de gravação no backend (ex.: cooldown mínimo + exigência de ação explícita do usuário).
5. **User IRs (`8 KiB`) separados do `struct102`:** Salvar um preset com `CAB = 0x64` (User IR) só reproduzirá o timbre correto se o arquivo WAV IR correspondente já estiver no mesmo slot `0..35` da NOR Flash do NXP (`0x607B8000`) ou for enviado via `0x50`/`0x58` + nome via `0x23`/`0x0E`.
6. **Limites de compatibilidade entre firmwares da MG-300 original:** Tratar explicitamente se a pedaleira conectada rodar firmware anterior à `V4.x` (ex.: validar tamanho `112 B` vs `113 B` nas respostas `0x06` antes de habilitar escrita).

---

## 9. Proposta de Arquitetura para Implementação Futura (Sem Implementar Agora)

### 9.1. Novo Pacote Independente: `packages/preset-engine/` (`@quicktone/preset-engine`)

Para manter `@quicktone/shared` enxuto e preservar o isolamento de responsabilidades:

```
packages/preset-engine/
├── src/
│   ├── catalog/
│   │   ├── mg300-models.json        # Catálogo versionado extraído do MG-300 V4 (COMP/EFX/AMP/EQ/NR/MOD/DLY/RVB/CAB/MIC)
│   │   ├── rom-defaults.ts          # Templates 7B da ROM 0x08018F80 (incl. flags >= 0x80 para round-trip seguro)
│   │   └── index.ts                 # Lookup tipado de modelos, parâmetros, faixas e rótulos
│   ├── model/
│   │   ├── editable-preset.ts       # Schema Zod rico (EditablePreset, BlockConfig, DraftPreset)
│   │   └── factory.ts               # createBlankPreset(), cloneFromHardwarePreset()
│   ├── codec/
│   │   ├── struct102-decoder.ts     # Uint8Array(102) -> EditablePreset (preservando rawBytes para round-trip sem perdas)
│   │   ├── struct102-encoder.ts     # EditablePreset -> Uint8Array(102) com validação estrita de faixas
│   │   ├── sysex-codec.ts           # Builders/parsers 0x0E (113B + 7-bit masking), ACK 0x0E (10B), 0x17, 0x23, 0x26, 0x2C
│   │   └── nuxpreset-exporter.ts    # Exportação/importação .nuxpreset V1/V2 e JSON
│   ├── realtime/
│   │   ├── cc-mapper.ts             # Traduz alteração de bloco/parâmetro -> sequência segura de CC 0x01..0x4A / SysEx 0x17
│   │   └── cc-coalescer.ts          # Coalescência/throttle (25-35 ms) para sliders mobile sem saturar UART 115.200 bps
│   ├── transactions/
│   │   ├── save-coordinator.ts      # Máquina de estados: Lock -> Backup(0x07) -> Write(0x0E) -> ACK -> Wait(200ms) -> Readback(0x07) -> Verify
│   │   └── verifier.ts              # Comparação byte-a-byte tolerante à máscara 7-bit de switches ROM >= 0x80
│   └── backup/
│       └── backup-store.ts          # Persistência em disco local de backups pré-sobrescrita + restauração 1-clique
└── tests/
    └── roundtrip-and-sysex.test.ts  # Testes unitários e de caracterização contra dumps reais da MG-300
```

### 9.2. Proposta de UI Mobile (Editor Touch-First)

1. **Cadeia de sinal interativa no topo** (evolução do `StageDisplay`): 10 blocos horizontais roláveis com toque para selecionar e toggle rápido liga/desliga (`CC 1..10`).
2. **Painel de edição do bloco selecionado**: seletor de modelo em drawer/bottom-sheet + faders horizontais largos (`48px` de alvo tátil, sem knobs minúsculos difíceis no dedo) com feedback de valor numérico e badge visual **`Modificado (não salvo na pedaleira)`**.
3. **Biblioteca de Rascunhos Locais (Nível A):** aba `Rascunhos` salva em `localStorage` (ou IndexedDB se incluir User IRs), com ações **Novo**, **Duplicar do Pedal**, **Exportar `.nuxpreset`/JSON** e **Importar**.
4. **Modo "Preview ao Vivo" (Nível B):** toggle explícito que envia alterações em tempo real via MIDI CC para a RAM da pedaleira (com aviso claro de que trocar de preset descarta alterações não salvas).
5. **Assistente de Gravação Segura em 3 Passos (Nível C):**
   - *Passo 1:* Editar nome (máx. 18 chars validados em `MG300_CHAR_TABLE`) e escolher slot destino **`1A..9D` apenas** (slots `F1A..F9D` exibidos como bloqueados/ROM).
   - *Passo 2:* Confirmação explícita mostrando **Slot atual a sobrescrever** + checkbox/indicador *"Backup automático será salvo no PC antes de gravar"*.
   - *Passo 3:* Barra de progresso das etapas reais (`Backup → Gravando Flash → Aguardando ACK → Verificando leitura`), exibindo **`Salvo e validado na pedaleira`** somente após readback byte-a-byte aprovado.

---

## 10. Roadmap Priorizado e Estimativa de Complexidade

| Fase | Escopo | Dependência | Complexidade | Risco de Hardware |
|---|---|---|---|---|
| **Fase 0 — Validação Empírica (Obrigatória antes de escrever código de gravação)** | Extrair catálogo limpo dos JSONs do `QuickTone.exe` + executar captura controlada de 10 passos (Wireshark + USBPcap) no slot descartável `9D`, comprovando escrita `0x0E`, readback `0x07` e persistência após power-cycle. | Pedaleira física + Wireshark/USBPcap | **Baixa–Média** (1–2 dias) | **Baixo** (slot descartável + backup prévio) |
| **Fase 1 — Nível A (`@quicktone/preset-engine` + Editor Local + Import/Export)** | Criar `packages/preset-engine`, preservar `struct102` nos presets sincronizados, biblioteca de rascunhos locais, edição offline completa e importação/exportação `.nuxpreset`/JSON. | Fase 0 (catálogo) | **Média** (3–5 dias) | **Zero** (100% local, sem escrita MIDI) |
| **Fase 2 — Nível B (Edição em Tempo Real via MIDI CC + `0x17`)** | Evoluir `strictMg300Safety` com modo explícito `allowRealtimeBlockAndParamCcs` (allowlist `CC 1..59`, `71`, `74` + coalescer 30 ms), endpoints/WS de preview ao vivo e indicador de "estado modificado em RAM". | Fase 1 | **Média** (2–4 dias) | **Baixo** (RAM volátil apenas, sem Flash) |
| **Fase 3 — Nível C (Gravação Permanente `0x0E` com Backup e Readback)** | Implementar `DeviceTransactionLock`, `BackupStore`, `SaveCoordinator` (`0x07 → 0x0E → ACK 10B → 200ms → 0x07 → Diff`), gate estrito de identidade (`NUX NME-300` / `NUX_MG1X`) e assistente mobile em 3 passos. | Fase 0 (persistência comprovada) + Fase 2 | **Média–Alta** (4–6 dias) | **Moderado** (mitigado por backup, lock, ACK e readback) |
| **Fase 4 — Opcional: Gestão de User IR (`0x50`/`0x58` + `0x23`/`0x29`) e Swap (`0x2C`)** | Upload/cópia de arquivos WAV IR (conversão 48 kHz 1024-tap `8 KiB` + pacotes `128 B` com checksum 14/28-bit) e reorganização de slots via `0x2C`. | Fase 3 | **Alta** (5–8 dias) | **Moderado–Alto** (grava NOR Flash NXP) |

---

## 11. Recomendação Final

**Prosseguir de forma incremental e orientada por evidência:**

1. **Não habilitar escrita permanente (`0x0E`) antes de concluir a Fase 0** (captura passiva Wireshark + USBPcap de um *Save* real do QuickTone no slot descartável `9D` + teste físico de persistência ao desligar e religar a MG-300). Embora a engenharia reversa do firmware e do `QuickTone.exe` já tenha desvendado 100% da estrutura de `0x0E`, do ACK de 10 bytes e da Flash IAP do STM32, a validação física em bancada é o único critério técnico aceitável para promover a gravação permanente de **`Parcial`** para **`Confirmada`**.
2. **Entregar valor imediato e com risco zero primeiro (Fases 1 e 2):** criar `packages/preset-engine` com o catálogo oficial extraído do MG-300 original, liberar edição/rascunhos locais + exportação `.nuxpreset` (Nível A) e edição em tempo real na RAM via MIDI CC (Nível B).
3. **Ativar o Nível C (`0x0E`) apenas por trás de salvaguardas inegociáveis:** verificação de modelo/identidade `NUX NME-300`, bloqueio estrito de slots de fábrica (`>= 36`), backup pré-sobrescrita persistido no PC, mutex exclusivo, espera por ACK `10 B`, readback obrigatório `0x07 → 0x06` e rate-limit de proteção da Flash STM32.
