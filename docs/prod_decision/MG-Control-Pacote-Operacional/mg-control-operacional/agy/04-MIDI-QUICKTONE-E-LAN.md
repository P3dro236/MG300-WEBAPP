# S04 — MIDI, QuickTone e LAN
**Invariantes:** preservar USB-MIDI/adapter atual (confirmar nome em S01), QuickTone Reader e LAN celular↔PC em tempo real. Tudo local funciona offline e sem login. Não alterar firmware.

## Tarefas
- Auditar dependências nativas e compatibilidade ABI/runtime Electron.
- Empacotar/rebuild módulo MIDI; validar seleção, hotplug, timeout e reconexão.
- Validar leitura, escrita e readback de preset.
- Preservar endpoints/eventos WebSocket LAN; testar firewall e bind.
- Definir descoberta/endereço celular e instruções Windows Firewall.
- MOCK isolado: nunca declarar conexão real nem enviar MIDI.
- Diagnóstico exportável sem segredos.

## Regressão
MG-300 antes/depois de abrir; desconectar/reconectar; múltiplos dispositivos; read/write/readback; fixtures QuickTone válidas/inválidas; celular mesma LAN; alteração mobile refletida no PC/pedaleira; roteador sem internet; restart/sleep/resume/porta ocupada; MOCK sem hardware.

## Testes/gate
Vitest parser/serializer/adapter/state; integração MIDI mock + real quando disponível; Playwright Electron; E2E LAN/WS/reconexão. Exigir instalação limpa e segundo PC Windows. Typecheck + Vitest + Playwright PASS. Sem hardware real, declarar bloqueio físico; não afirmar pronto.
