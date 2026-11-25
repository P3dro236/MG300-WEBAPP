# Registro de Decisões Técnicas — QuickTone Web Controller

## ADR-001: Parser Binário Somente Leitura para `.nuxpreset` (`MG300 Preset Data`)
- **Contexto**: A investigação dos arquivos reais no computador (`EaglesDF Crunch.nuxpreset`, `SCORPIONS.nuxpreset` e `QuickTone.exe` `0x004A6A80..0x004A7620`) comprovou que o QuickTone armazena presets da MG-300 em containers binários com magic `"MG300 Preset Data"`, contendo structs de `102` bytes (`0x66 B`) e nomes codificados em uma tabela proprietária de 72 glifos (`0x00..0x47`).
- **Decisão**: Implementar parser binário estrito e somente leitura que decodifica tanto arquivos `.nuxpreset` individuais (`8.380`/`8.381 B`) quanto pacotes completos `MG300AllPreset.nuxpreset` (`300.673`/`300.709 B`) e arquivos JSON auxiliares, com fallback configurável manualmente e catálogo dos 36 presets de fábrica (`F1A..F9D`) extraídos de `0x0801917C`.

## ADR-002: Proteção contra Mensagens MIDI Não Validadas e Mapeamento Real da MG-300
- **Contexto**: No firmware da MG-300 (`FUN_08038d04`), `CC 1..10` controlam a seleção/bypass dos blocos de efeito (`CC 7` altera o bloco de Delay `state[0x411]`), enquanto a troca de presets usa `CC 0x3C` (`60`, valores `0..71`) e os volumes usam `CC 0x40` (`64`, Master Volume `0..100`), `CC 0x4A` (`74`, Patch Level `0..100`) e `CC 0x3D` (`61`, Expression Pedal `0..100`).
- **Decisão**: Bloquear o envio de CCs de blocos de efeito (`CC 1..10`) como comandos de volume no modo seguro MG-300, usar `CC 0x3C` (`0..71`) para seleção nativa de preset na MG-300 (mantendo suporte explícito na abstração `IMidiAdapter` para `Program Change 0xC0` e `Bank Select MSB 0x00 / LSB 0x20`), e restringir os valores de volume da MG-300 à faixa validada `0..100`.

## ADR-003: Modelo Tri-State de Sincronização com o Dispositivo
- **Contexto**: O envio de uma mensagem MIDI OUT não garante que a pedaleira executou a alteração; somente uma mensagem MIDI IN vinda da pedaleira confirma o estado real do hardware.
- **Decisão**: Separar estritamente `confirmedState` (atualizado apenas por eventos MIDI IN da pedaleira), `lastSentCommand` (atualizado ao transmitir via MIDI OUT) e `syncStatus` (`'confirmed' | 'command_sent_unconfirmed' | 'unknown'`).

## ADR-004: Segurança Mínima para Operação em Rede Local (LAN)
- **Contexto**: O servidor Fastify escuta em `0.0.0.0` para permitir acesso por celulares e tablets na mesma rede Wi-Fi.
- **Decisão**: Implementar validação de cabeçalho `Origin` (permitindo apenas origens locais/RFC1918 ou explicitamente autorizadas) e middleware de autenticação simples configurável via token/PIN (`QUICKTONE_AUTH_TOKEN` validado pelo header `X-QuickTone-Token` ou `Authorization: Bearer`) em todas as rotas de controle (`POST`/`PUT`).
