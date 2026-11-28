# S08 — Billing, portal e webhooks
**Comercial:** Stripe prioritária; se Pix não elegível, Mercado Pago para Pix. Cartão + Pix obrigatórios no Brasil. Créditos apenas; sem assinatura. Créditos comprados sem vencimento. Nunca conceder crédito por redirect do browser.

## Portal separado
Login/verificação, saldo, compras, dispositivos e conta. PT/EN e responsivo. Não controla MIDI nem hospeda presets. Electron local continua sem login.

## Tarefas
Verificar elegibilidade, taxas, moedas, settlement e requisitos Stripe/Pix atuais; fallback Mercado Pago. Criar PaymentProvider adapter. Checkout server-side; webhook com assinatura, replay protection, event ID e idempotência. Validar valor/moeda/order e confirmar server-to-server. Tratar Pix pending/paid/expired, cartão recusado, refund/chargeback. Crédito só após confirmação. E-mail transacional. Sandbox antes de produção.

## Testes/gate
Unit provider/state/signature; integração webhook duplicado/fora de ordem, pagamento atrasado, Pix, refund; E2E compra cartão e Pix; segurança forged/replay/amount mismatch/IDOR; conciliação gateway↔orders↔ledger. Typecheck + Vitest + Playwright PASS. Não vender sem cartão, Pix e conciliação aprovados.
