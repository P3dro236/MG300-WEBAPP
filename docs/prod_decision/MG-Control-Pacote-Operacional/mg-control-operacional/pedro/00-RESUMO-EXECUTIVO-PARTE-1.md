# Resumo executivo — Parte 1 (agy/)
Os agentes executam `agy/01` a `agy/11` em ordem. Cada etapa termina com evidência e gate. Falha em typecheck, Vitest unit/integration ou Playwright bloqueia avanço.

| Etapa | Trabalho | Entrega que você acompanha |
|---|---|---|
| 01 Auditoria | Inspecionar código real, testes, MIDI, LAN, IA e site | Baseline, matriz de testes, riscos |
| 02 Arquitetura | Fronteiras local/cloud, contratos e ADRs | Diagramas e plano de migração |
| 03 Electron | Shell standalone e lifecycle do core | App sem terminal, sem processo órfão |
| 04 MIDI/LAN | Empacotar MIDI, preservar QuickTone/LAN | Evidência em MG-300 e rede offline |
| 05 Cloud | Fastify, PostgreSQL, Auth e devices | API, migrations, backup/restore |
| 06 IA | Proxy Gemini, ledger e feedback | Geração paga segura |
| 07 Segurança | Threat model, DPAPI, LGPD e abuso | Relatório e controles |
| 08 Billing | Cartão/Pix, webhooks e portal | Compra testada e portal separado |
| 09 Distribuição | Instalador, assinatura, CI e update notice | Build Windows testado |
| 10 Site | Auditoria e ajustes `mg300.vercel.app` | Landing PT/EN e links válidos |
| 11 Release | Teste integrado e Go/No-Go | Relatório de prontidão |

Não permitir: refactor antes da auditoria; reimplementar LAN; mover MIDI para cloud; exigir login para local; expor chave Gemini; criar cloud presets/assinatura/comunidade no MVP; declarar MIDI pronto só com mocks.

Relatório por etapa: escopo, arquivos, ADRs, testes adicionados, comandos/resultados, evidências físicas, riscos, gate PASS/BLOCKED e próxima etapa autorizada.
