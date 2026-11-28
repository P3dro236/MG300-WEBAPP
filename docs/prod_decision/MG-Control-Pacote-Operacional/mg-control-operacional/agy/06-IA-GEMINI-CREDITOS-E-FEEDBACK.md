# S06 — Proxy Gemini, geração e créditos
**Regras:** Gemini primeiro provider; sem BYOK; chave só cloud. Confirmar model ID exato em S01; não presumir “Gemini 3.5 Flash”. IA só gera timbres no MVP. Não grava preset diretamente: JSON estruturado→schema→compilador determinístico→validador→serializer→fluxo atual de aplicação.

## Créditos
3 grátis após e-mail verificado, expiram em 30 dias; comprados sem vencimento. 1 crédito por geração concluída com sucesso. Reservar antes; consumir no sucesso; liberar em falha; idempotência. R$9,90/US$2,99 por 10 créditos é hipótese, não hardcode.

## Tarefas
Medir tokens input/output/thinking, chamadas, retries, latência, sucesso/falha e custo. Mover prompt/API key para cloud. Limites por conta/device/IP, concorrência, timeout, token cap, retries controlados, orçamento diário/mensal e kill switch. Preservar fluxo automático atual até preset aplicado. Feedback voluntário: avaliação + sugestão; sem telemetria geral.

## Testes/gate
Unit provider/schema/compiler/validator/ledger/cost; integração transações/concorrência; falha de Gemini/JSON inválido/MIDI/timeout/cancelamento; idempotência; E2E sucesso consome 1, falha libera; feedback somente sob envio voluntário. Typecheck + Vitest + Playwright PASS. Sem custo medido e ledger seguro, não abrir IA paga.
