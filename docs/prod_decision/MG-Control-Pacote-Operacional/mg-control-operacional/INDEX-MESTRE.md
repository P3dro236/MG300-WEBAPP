# MG Control — Índice Mestre
Versão 1.0 | Pacote documental operacional | Nenhum código de implementação incluído.

## Ordem obrigatória
1. `agy/00-MASTER-PLAN.md` — regras globais e sequência.
2. `agy/01-AUDITORIA-BASELINE.md` — auditar o repositório real; não implementar.
3. `agy/02-ARQUITETURA-CONTRATOS-E-MIGRACAO.md` — ADRs, limites e contratos.
4. `agy/03-ELECTRON-SHELL-E-ORQUESTRACAO.md` — Electron standalone.
5. `agy/04-MIDI-QUICKTONE-E-LAN.md` — USB-MIDI, QuickTone e LAN existente.
6. `agy/05-CLOUD-BACKEND-AUTH-DB.md` — Fastify cloud, PostgreSQL, Auth e dispositivos.
7. `agy/06-IA-GEMINI-CREDITOS-E-FEEDBACK.md` — proxy Gemini, geração, ledger e feedback.
8. `agy/07-SEGURANCA-LICENCIAMENTO-E-LGPD.md` — threat model e controles.
9. `agy/08-BILLING-PORTAL-E-WEBHOOKS.md` — Stripe/Mercado Pago, cartão/Pix e portal.
10. `agy/09-BUILD-DISTRIBUICAO-E-CICD.md` — instalador, assinatura, update notice e CI.
11. `agy/10-LANDING-PAGE-VERCEL.md` — auditoria/evolução de `mg300.vercel.app`.
12. `agy/11-VALIDACAO-INTEGRADA-E-RELEASE.md` — validação e Go/No-Go.
13. `pedro/00-RESUMO-EXECUTIVO-PARTE-1.md` — acompanhamento das etapas.
14. `pedro/01-URGENTE-ACOES-IMEDIATAS.md` — ações pessoais que destravam o trabalho.
15. `pedro/02-DECISOES-ESTRATEGICAS.md` — escolhas de custo-benefício adiáveis.
16. `pedro/03-REQUISITOS-MINIMOS-INFRA-E-SITE.md` — requisitos e faixas de dimensionamento.

## Grafo de dependências
`S01 Auditoria → S02 Arquitetura → S03 Electron → S04 MIDI/LAN`.
`S02 → S05 Cloud → S06 IA/créditos`.
`S05 + S06 + S08 → S07 Segurança`.
`S05 → S08 Billing/portal`.
`S03 + S04 + S05–S08 → S09 Build/distribuição`.
`S08 + S09 → S10 Landing`.
`S01–S10 → S11 Release`.

## Decisões consolidadas
- MG Control é marca independente; não sugerir vínculo oficial com NUX.
- Escopo inicial: NUX MG-300; outras pedaleiras após consolidação.
- Electron standalone Windows x64; Main orquestra núcleo local Fastify/WebSocket + MIDI USB + QuickTone Reader.
- Preload/IPC restrito; Renderer sem acesso Node.
- LAN celular↔PC em tempo real já existe; preservar, não reimplementar. Funciona sem internet.
- MIDI, presets locais e LAN sem login/licença/internet.
- Cloud: Auth, DB, dispositivos, billing, créditos e proxy IA. Sem biblioteca/sync de presets cloud no MVP.
- Gemini primeiro provedor, sem BYOK; somente geração de timbres no lançamento.
- 3 créditos gratuitos após e-mail verificado; expiram em 30 dias. Comprados não expiram.
- 1 crédito por geração concluída; reservar, consumir em sucesso, liberar em falha; idempotência.
- Preço de referência R$9,90 / US$2,99 por 10 créditos: hipótese a validar.
- Sem assinatura no lançamento; arquitetura preparada para futuro.
- Feedback de geração voluntário; sem telemetria geral.
- Até 3 dispositivos/conta; múltiplas sessões permitidas. DPAPI + registro cloud; fingerprint não é fator único.
- Stripe prioritária; Mercado Pago para Pix se Stripe não liberar. Cartão + Pix obrigatórios no Brasil.
- Portal web separado; Electron local sem login.
- Update inicial: aviso de versão + botão/link download; sem auto-update no lançamento.
- Download direto inicial; Windows. macOS futuro.
- Site atual `mg300.vercel.app`; domínio próprio futuro, sem compra/deploy sem autorização.
- VPS própria preferida; teto aproximado R$150/mês; sizing precisa ser pesquisado.
- Repositório privado e acessado pelo Agy local. Auditoria do código real obrigatória.
- Stack de testes informada: `npm run typecheck`, `npm run test` (Vitest), `npm run test:e2e` (Playwright).

## Regras globais
- Auditar antes de decidir/refatorar. Não assumir que o contexto substitui inspeção.
- Nenhum código nesta etapa documental.
- Não alterar firmware; não degradar LAN; não mover MIDI para cloud.
- Nunca expor Gemini/gateway/DB/JWT/signing secrets no renderer, bundle, repo ou logs.
- Não confiar em saldo/plano/licença enviado pelo cliente.
- Não criar microservices sem necessidade medida.
- Não contratar, comprar domínio, publicar deploy/release sem autorização.
- Cada mudança futura inclui testes na mesma tarefa e atualização documental/ADR.
- Sem presets cloud, comunidade, análise/melhoria IA ou assinatura no MVP.

## Test gate global bloqueante
Toda função, endpoint, módulo ou feature alterada exige testes correspondentes na mesma tarefa:
- Vitest unitário para lógica/funções; Vitest integração para serviços, DB e endpoints.
- Playwright/Electron E2E para fluxos críticos.
- Executar `npm run typecheck`, `npm run test`, `npm run test:e2e`.
- Se scripts não cobrirem todos os workspaces/Electron, corrigir orquestração de testes antes de declarar PASS.
- Falha em typecheck, unit, integração ou E2E = STOP; não avançar de etapa.
- Não mascarar falhas com skip, mocks excessivos ou asserções enfraquecidas.
- Testes físicos indisponíveis ficam explicitamente pendentes; não declarar validação física concluída.
- Relatório por etapa: escopo, arquivos, comandos, resultados, evidências, riscos, gate PASS/BLOCKED.

## Definition of Done global
Instalador sem terminal; MIDI real em instalação limpa e PC secundário; LAN offline preservada; cloud segura; cartão/Pix; portal separado; backup/restore testado; nenhum segredo no cliente; landing com claims verificados; todos os gates aprovados; Pedro autoriza release.
