# S02 — Arquitetura, contratos e migração
**Pré-requisito:** S01 aprovado.

## Alvo
Electron Main gerencia lifecycle do núcleo local; Preload expõe IPC allowlist; Renderer sem Node. Núcleo Fastify/WS + MIDI + QuickTone permanece local. Cloud Fastify modular + PostgreSQL. Portal web separado. Cloud não acessa localhost nem armazena presets no MVP.

## Tarefas
- Diagramas C4 atual/alvo e ownership de cada módulo.
- ADRs: Electron packaging, IPC, lifecycle, storage, portas, cloud hosting, DB, Auth, billing, provider IA, update.
- Contratos versionados: IPC, REST `/v1`, WebSocket LAN, schema IA, erros e eventos.
- Plano de migração incremental, compatibilidade, rollback e preservação de dados.
- Definir configuração por ambiente, migrations forward-safe e política de versões.
- Definir limites: Main/orquestração; Local Core/hardware+LAN; Renderer/UI; Cloud/conta+créditos+IA+pagamento; Portal/conta+checkout.

## Testes
Unit schema/validators; integração REST/WS; contract tests Local Core↔Electron, Electron↔Cloud, Portal↔Cloud; E2E regressão de controle e LAN; migração com cópia anonimizada.

## Gate
ADRs, diagramas, contratos, compatibilidade e rollback aprovados; typecheck + Vitest unit/integration + Playwright E2E PASS. Não iniciar refactor/cloud sem gate.
