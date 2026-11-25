# Guia de Configuração do NUX QuickTone — QuickTone Web Controller

Este guia documenta como o **QuickTone Web Controller** descobre e interpreta os arquivos locais de presets do software **NUX QuickTone** para a pedaleira **NUX MG-300 (`NUX NME-300`)**, incluindo as evidências técnicas do formato real de arquivo.

---

## 1. Descoberta e Configuração da Pasta de Presets

O software oficial **NUX QuickTone (`v2.4.12.27`)** utiliza dois tipos de arquivos no computador:

1. **Arquivo de Configuração Global (`com.nux.quicktone.cfg`)**:
   - Localizado por padrão em `C:\Users\<usuário>\Documents\NUX\com.nux.quicktone.cfg` (`30 bytes`).
   - Possui cabeçalho container binário com a assinatura `"QuickTone Config"` (`16 bytes`) e `2 bytes` de preferência de idioma/tema (`00 ff`).
2. **Arquivos de Presets da MG-300 (`*.nuxpreset` e `MG300AllPreset.nuxpreset`)**:
   - O QuickTone não mantém um banco de dados oculto de presets em `AppData`: os presets residem na Flash interna da pedaleira (`STM32F103` `0x0803D804` / `0x0803E800` para os 36 presets de usuário `1A..9D` e ROM `0x0801917C` para os 36 presets de fábrica `F1A..F9D`) e são exportados/importados pelo usuário como arquivos **`.nuxpreset`** na pasta escolhida no Windows Explorer.

### Como configurar a pasta no QuickTone Web Controller:
- **Ordem de busca automática**:
  1. Variável de ambiente `QUICKTONE_PRESETS_DIR` (se definida ao iniciar o backend).
  2. `C:\Users\<usuário>\Documents\NUX`
  3. `C:\Users\<usuário>\CrossDevice\S25+ de Pedro\storage\Download` (e subpasta `Telegram`, onde foram localizados arquivos `.nuxpreset` reais neste computador).
  4. `C:\Users\<usuário>\Downloads`
- **Configuração Manual pela Interface Web ou API**:
  - Clique no botão **Configurações** na barra superior do controlador web e informe o caminho completo da pasta onde seus arquivos `.nuxpreset` ou `MG300AllPreset.nuxpreset` estão salvos (ou envie `POST /api/presets/config` com `{ "directoryPath": "C:\\caminho\\dos\\presets" }`).
  - Caso a pasta configurada não exista (`directory_not_found`), o sistema exibe um alerta claro na interface e mantém os **36 Presets de Fábrica (`F1A..F9D`)** disponíveis caso a opção de presets de fábrica esteja habilitada.
- **Operação 100% Somente Leitura**:
  - O parser e o monitor de arquivos (`fs.watch`) operam estritamente em modo **somente leitura**, garantindo que nenhum arquivo original do QuickTone seja modificado, truncado ou sobrescrito.

---

## 2. Evidências do Formato Binário Real `.nuxpreset` (`MG300 Preset Data`)

A estrutura abaixo foi comprovada pela inspeção direta dos arquivos reais encontrados neste computador (`EaglesDF Crunch.nuxpreset` e `SCORPIONS.nuxpreset`, ambos com `8.380 bytes = 0x20BC B`) e das rotinas de exportação/importação do executável `QuickTone.exe` (`0x004A6A80..0x004A7620`):

| Offset (Hex) | Tamanho | Tipo | Valor / Descrição |
|---|---|---|---|
| `0x00..0x03` | `4 B` | `uint32 LE` | Tamanho total do arquivo (`8.380` = `0x20BC` ou `8.381` = `0x20BD` para preset único; `300.673` ou `300.709` para `MG300AllPreset.nuxpreset`). |
| `0x04..0x07` | `4 B` | `uint32 LE` | Comprimento da string mágica = `17` (`0x00000011`). |
| `0x08..0x18` | `17 B` | `ASCII` | Assinatura exata: **`"MG300 Preset Data"`**. |
| `0x19..0x1C` | `4 B` | `uint32 LE` | Tamanho do payload (`totalSize - 29`: `0x209F` = `8.351 B` ou `0x20A0` = `8.352 B` para preset único; `0x49664` = `300.644 B` ou `0x49688` = `300.680 B` para `MG300AllPreset.nuxpreset`). |
| `0x1D..0x20` | `4 B` | `uint32 LE` | Versão do formato = `1` (`0x00000001`, validada em `0x004A74B2` — erro `"Preset Error Version"` se `!= 1`). |
| `0x21..0x28` | `8 B` | `uint32 LE × 2` | No formato V1 (`0x209F`): `[subver/slot, productId = 0x66 (102)]`. No formato V2 (`0x20A0`): `0x21..0x24` é `productId = 0x66` (`102`, validado em `0x004A71A0` — erro `"Preset Error Product"` se `!= 0x66`) e `0x25` é o índice do slot (`0..35`). |
| `0x29..0x8E` (V1) / `0x26..0x8B` (V2) | `102 B` (`0x66 B`) | `struct` | **Estrutura de `102 bytes` (`0x66 B`) do Preset da NUX MG-300** (idêntica à estrutura em RAM `state[0x40A..0x46F]` e Flash `0x0803D804` no `STM32F103`). |
| `0x8F..EOF` | `8.237 B` | `bytes` | Dados opcionais de User IR (`.wav` / coeficientes de gabinete customizado atrelados ao preset). |

### Estrutura Interna dos `102 Bytes` (`0x66 B`) do Preset e Tabela de 72 Caracteres
Dentro do bloco de `102 bytes` (`offset 0x00..0x65`):
- `+0x00..+0x0A` (`11 B`): Estado (enable/modelo) dos blocos `WAH`, `COMP`, `EFX`, `AMP`, `EQ`, `NR`, `MOD`, `DLY`, `RVB`, `CAB_ID`, `MIC_ID`.
- `+0x0B..+0x43` (`57 B`): Parâmetros dos 8 blocos de efeito e filtro de gabinete (`+0x43`).
- **`+0x44` (`1 B`)**: **Comprimento do nome do preset (`1..16`)**.
- **`+0x45..+0x54` (`16 B`)**: **Caracteres do nome do preset**, codificados com índices **`0x00..0x47` (`0..71`)** correspondentes à tabela de 72 glifos RLE da ROM LCD do `STM32F103` (`0x08035126` / `FUN_08010dfc` / `FUN_0800dbb2`):
  - `0x00..0x19` (`0..25`): `'A'..'Z'`
  - `0x1A..0x33` (`26..51`): `'a'..'z'`
  - `0x34..0x3D` (`52..61`): `'0'..'9'`
  - `0x3E` (`62`): `' '` (Espaço)
  - `0x3F..0x47` (`63..71`): `'?'`, `'!'`, `'-'`, `"'"`, `':'`, `'&'`, `'@'`, `','`, `'.'`
  - Exemplo real (`EaglesDF Crunch.nuxpreset`): comprimento `0x0F` (`15`), bytes `04 1a 20 25 1e 2c 03 05 3e 02 2b 2e 27 1c 21` → **`"EaglesDF Crunch"`**.
  - Exemplo real (`SCORPIONS.nuxpreset`): comprimento `0x09` (`9`), bytes `12 02 0e 11 0f 08 0e 0d 12` → **`"SCORPIONS"`**.
- **`+0x62` (`1 B`)**: Nível de volume do IR (`0..40`).
- **`+0x65` (`1 B`)**: **Patch Level (`P.LVL`, `0..100`, padrão `50` = `0x32`)**.
