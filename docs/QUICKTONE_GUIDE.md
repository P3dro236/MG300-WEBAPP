# Guia de Leitura de Presets e Persistência Local — QuickTone Web Controller

Este documento registra a estrutura binária real dos presets da **NUX MG-300 (`NUX NME-300`)**, a classificação entre **Usuário** e **Fábrica**, e como o controlador persiste a biblioteca localmente via `localStorage`.

---

## 1. Persistência Local via `localStorage` (Sem Dependência de Pastas)

O controlador não exige que o usuário configure pastas do QuickTone no disco:
- Os presets sincronizados da pedaleira (e os 36 presets de fábrica da ROM) são armazenados localmente no navegador sob a chave versionada **`mg300_webapp_storage_v1`**.
- **Proteção contra sobrescrita**: respostas vazias ou desconexões transitórias da pedaleira nunca apagam os presets já salvos no `localStorage`. Novas leituras da pedaleira são mescladas por slot preservando dados válidos existentes.
- **Recuperação segura**: caso algum registro armazenado esteja corrompido ou o JSON seja inválido, o leitor descarta apenas os itens inválidos ou restaura padrões limpos sem quebrar a aplicação.
- **Preferências persistidas**: filtro selecionado (`Usuário` ou `Fábrica`), modo de visualização (`Modo palco` ou `Matriz`) e último nível de Master Volume são restaurados ao atualizar ou reabrir o navegador.

*(O serviço de leitura `.nuxpreset` em `@quicktone/reader` permanece disponível internamente para cenários explícitos de teste/importação.)*

---

## 2. Classificação da Biblioteca: Usuário vs. Fábrica

A biblioteca exibe **exclusivamente duas categorias**:
- **Usuário**: apenas presets reais personalizados (ex.: slots `1A..4C` customizados pelo músico).
- **Fábrica**: os 36 presets originais de fábrica da MG-300 (`F1A..F9D`).

Regras aplicadas:
- **Ocultação de presets padrão/placeholder**: entradas artificiais (`User 1A..User 9D`) nunca são exibidas.
- **Classificação consistente por nome normalizado e metadados**: na MG-300 física, slots de usuário não modificados (por exemplo `4D..9D`) mantêm cópias idênticas dos presets de fábrica (`VT Dist lead`, `RG J. Mayer`, `EmotiveBallad`). O classificador identifica essas cópias pelo nome normalizado e metadados, evitando exibi-las na aba **Usuário** ou duplicá-las na aba **Fábrica**.

---

## 3. Evidências do Formato Binário dos Nomes (Inclui Correção do Slot `3C`)

A leitura direta da memória da NUX MG-300 física via SysEx (`0x07 → 0x06`, `113 bytes`) revelou que o campo de nome dentro da estrutura de `102 bytes` (`0x66 B`) comporta até **18 caracteres** (e não 16):

- **`+0x44` (`1 B`)**: Comprimento do nome (`1..18`).
- **`+0x45..+0x56` (`18 B`)**: Caracteres do nome codificados pela tabela de 72 glifos (`0x00..0x47`, onde `0x00 = 'A'`, nunca terminador nulo).
- **`+0x57+`**: Próximos parâmetros internos do preset (preservados intactos).

**Caso real capturado no slot `10` (`3C`)**:
- Comprimento em `+0x44`: **`17`** (`0x11`).
- Bytes `+0x45..+0x55`: `[12, 30, 45, 26, 37, 37, 34, 28, 26, 62, 10, 34, 43, 36, 62, 7, 71]` → **`"Metallica Kirk H."`**.
- Byte `+0x56`: `0` (18º byte do campo de nome), seguido pelo campo em `+0x57 = 16`.
