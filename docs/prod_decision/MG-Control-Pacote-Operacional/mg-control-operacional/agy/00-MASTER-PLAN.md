# MASTER PLAN — MG Control
## Sequência estrita
S01 Auditoria → S02 Arquitetura → S03 Electron → S04 MIDI/LAN → S05 Cloud/Auth/DB → S06 IA/créditos → S07 Segurança → S08 Billing/portal → S09 Build/CI → S10 Landing → S11 Release. Dependências cruzadas: S07 revisa S05/S06/S08; S09 depende de S03–S08; S10 depende de S08/S09; S11 depende de todas.

## Arquitetura-alvo
- Electron Main: lifecycle e orquestração do núcleo local.
- Preload/IPC: API nativa allowlist, tipada e validada.
- Renderer: React UI sem Node integration.
- Núcleo local existente: Fastify + WebSocket + USB-MIDI + QuickTone Reader.
- Cloud: Fastify modular + PostgreSQL; Auth, Device, Credit, AI proxy, Payment.
- Portal separado. Sem cloud preset sync/library no MVP.
- Gemini server-side; provider adapter; sem BYOK.
- Windows x64 primeiro.

## Regras de negócio
- Local MIDI/presets/QuickTone/LAN offline e sem conta.
- LAN em tempo real já existe; preservar protocolo/fluxo.
- IA requer internet, e-mail verificado e crédito.
- 3 trial credits/conta, expiram em 30 dias; comprados sem vencimento.
- 1 crédito por geração bem-sucedida; reserva/consumo/liberação idempotentes.
- R$9,90 / US$2,99 por 10 créditos é hipótese.
- Sem assinatura inicial; sem telemetria geral; feedback voluntário.
- Máximo 3 dispositivos; múltiplas sessões permitidas.
- DPAPI + registro servidor; fingerprint auxiliar.
- Stripe primeiro; Mercado Pago Pix fallback; cartão + Pix no Brasil.
- Portal separado; update aviso + link download.

## Regras de agente
- S01 é auditoria sem implementação; código real prevalece sobre contexto.
- Não reescrever LAN/MIDI sem evidência e ADR.
- Não bloquear recursos locais por login/licença.
- Não colocar secrets no cliente/repo/logs.
- Não confiar em valores de billing enviados pelo cliente.
- Sem microservices sem necessidade comprovada.
- Sem compra, contratação, DNS, deploy ou release sem autorização.
- Mudança futura deve ser pequena, testada, revisada e documentada.

## Gate obrigatório
Para cada mudança: adicionar testes na mesma tarefa. Vitest unit + integração; Playwright/Electron E2E para fluxos críticos. Rodar `npm run typecheck`, `npm run test`, `npm run test:e2e`. Qualquer falha bloqueia próxima etapa. Sem skips/mocks que escondam falhas. Testes físicos pendentes devem ser identificados como bloqueios. Agente entrega evidência dos comandos e resultados e aguarda autorização/etapa seguinte.
