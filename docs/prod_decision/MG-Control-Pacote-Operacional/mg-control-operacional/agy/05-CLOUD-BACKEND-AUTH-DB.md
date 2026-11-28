# S05 — Cloud, Auth e PostgreSQL
**Stack-alvo:** Fastify modular + PostgreSQL; VPS preferida, sizing após auditoria/cotação; TLS, migrations e backup externo. Monólito modular, sem microservices.

## Domínios
Auth, Account, Device, Credit, Payment, AI Proxy, Security/Audit. Tabelas candidatas: users, email_verifications, refresh_sessions, devices, trial_grants, credit_ledger/reservations, payment_orders, webhook_events, generation_requests, voluntary_feedback. Não criar cloud presets.

## Regras
- E-mail verificado para IA.
- Access token curto; refresh rotativo, revogável e armazenado hashed.
- Respostas não enumeram e-mails.
- Limite 3 dispositivos/conta, aplicado atomicamente; múltiplas sessões permitidas.
- DPAPI device key; perda/formatação exige novo registro e possível remoção de device antigo.
- Fingerprint é sinal auxiliar, nunca único fator.
- Cliente não define saldo, plano, licença ou pagamento.

## API candidata
`/v1/auth/register|login|verify-email|refresh|logout`, `/v1/account`, `/v1/devices`, `/v1/credits`, `/v1/ai/generate`, `/v1/payments/checkout`, `/v1/webhooks/:provider`.

## Testes/gate
Unit token/device/validators; integração migrations/transactions/constraints; API auth/refresh/revoke/rate limit; security brute force/enumeration/IDOR/replay; E2E register→verify→login→device→account; backup/restore. Typecheck + Vitest + Playwright PASS. Não habilitar IA/billing sem gate.
