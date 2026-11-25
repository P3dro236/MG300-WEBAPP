# Registro de Decisões Técnicas — QuickTone Web Controller

## ADR-001: Formato de Nomes de Presets de até 18 Bytes (`0x44..0x56`)
- **Contexto**: A captura SysEx real do slot `10` (`3C`) na NUX MG-300 comprovou o nome `"Metallica Kirk H."` com comprimento `17` em `+0x44` e glifos em `+0x45..+0x55`, e slot `14` (`4C`) com bytes residuais até `+0x56` antes do próximo campo em `+0x57`.
- **Decisão**: Atualizar `MG300_FILE_FORMAT.MAX_NAME_LENGTH` para `18` (`0x45..0x56`) mantendo intactos os demais bytes da estrutura de `102 bytes`.

## ADR-002: Controle Exclusivo de Master Volume (`CC 0x40`)
- **Contexto**: Para operação segura e direta ao vivo sem seletores de fader nem confusão com `Patch Level` ou `Expression`, todo controle de volume na interface e na API deve atuar exclusivamente no Master Volume.
- **Decisão**: Restringir `UpdateVolumeRequestSchema`, `UpdateVolumeTargetRequestSchema`, `ControllerStateManager` e `MidiService.setVolume`/`setVolumeTarget` ao alvo `master_cc64` (`CC 64`), preservando as definições de protocolo internas no pacote compartilhado para compatibilidade de baixo nível.

## ADR-003: Persistência Local Versionada via `localStorage` e Classificação Usuário/Fábrica
- **Contexto**: Exigir configuração de pastas do QuickTone gerava alertas desnecessários e não persistia o catálogo no navegador; além disso, placeholders (`User 1A..9D`) e cópias de fábrica nos slots `4D..9D` poluíam a lista de presets do usuário.
- **Decisão**: Remover a dependência de pastas do fluxo principal, persistir presets e preferências em `localStorage` (`mg300_webapp_storage_v1`) com merge não-destrutivo e recuperação de dados corrompidos, ocultar placeholders e classificar presets em apenas duas categorias (`Usuário` e `Fábrica`) usando metadados e normalização de nomes.

## ADR-004: Pareamento Mobile Obrigatório via QR Code, Sessão Única e Proteção contra DNS Rebinding
- **Contexto**: Um PIN opcional em texto aberto permitia acesso por IP na LAN e suportava múltiplos controladores simultâneos sem aprovação explícita.
- **Decisão**: Implementar `PairingManager` no backend com desafios QR temporários de uso único, aprovação obrigatória no desktop com código de 6 dígitos, sessões em cookie `HttpOnly; SameSite=Strict`, limite rigoroso de 1 celular controlador (revogando imediatamente sessões anteriores), expiração, revogação manual, rate limiting e validação estrita de `Host`, `Origin` e IPs privados.

## ADR-005: Estabilidade de Inicialização MIDI/WS e Fader de Volume
- **Contexto**: `<StrictMode>` causava reconexão WS imediata no boot, recompilações repetidas do bridge C# atrasavam a inicialização WinMM, e badges dinâmicos + ecos WebSocket em voo faziam o indicador de volume piscar.
- **Decisão**: Adicionar cache de `bridge.dll` no `WinMmMidiAdapter`, mutex `connectInFlight` no `MidiService`, deduplicação de sockets no `QuickToneWsManager`, larguras fixas sem transições nos badges do `VolumeSlider` e guarda `isDraggingVolumeRef` contra retrocesso de volume durante arrasto.
