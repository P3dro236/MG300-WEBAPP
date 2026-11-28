# Decisões estratégicas — itens que podem esperar

## Fixadas; não reabrir sem evidência
MG Control independente da NUX; MG-300 inicial; Electron standalone Windows; Main orquestra núcleo local Fastify/WS + MIDI + QuickTone; LAN já existe e deve ser preservada; cloud Auth/DB/devices/billing/AI proxy; sem cloud preset sync; local sem login; Gemini sem BYOK e somente geração; 3 créditos trial/30 dias; comprados sem vencimento; 1 crédito por sucesso; R$9,90/US$2,99 por 10 como hipótese; sem assinatura inicial; feedback voluntário; sem telemetria geral; 3 devices/conta e múltiplas sessões; Stripe prioritária + Mercado Pago Pix fallback; cartão+Pix; portal separado; aviso+download; VPS preferida e teto ~R$150/mês; download direto inicial; Windows x64.

## A decidir por pesquisa, não por preferência
1. **VPS vs PaaS/serverless:** comparar preço total, patching, backup, SLA, suporte, egress e esforço operacional. VPS é preferência atual, mas transfere operação a Pedro.
2. **PostgreSQL self-hosted vs gerenciado:** self-hosted pode caber no teto; gerenciado reduz manutenção e pode custar mais. Migrar quando HA/restore/tempo operacional justificar.
3. **Storage/CDN de instaladores:** comparar Vercel Blob, R2, S3-compatible e storage do host; exigir HTTPS, checksum, versionamento, egress previsível e URLs estáveis.
4. **E-mail transacional:** comparar Resend, Postmark, Brevo, SES; SPF/DKIM/DMARC, entregabilidade, API, limites e preço.
5. **Observabilidade:** logs técnicos mínimos e métricas operacionais; comparar Sentry/GlitchTip/OpenTelemetry/Grafana. Não ativar analytics de comportamento.
6. **Code Signing:** cotar OV/EV, requisitos de validação, guarda de chave, preço anual e integração CI.
7. **Gateway:** confirmar elegibilidade Stripe Pix, taxas, moedas, settlement, chargeback; Mercado Pago Pix fallback.
8. **Unit economics:** medir tokens input/output/thinking, retries, falhas, gateway, impostos, suporte e créditos trial; ajustar preço com dados.
9. **Aquisição:** vídeos reais de geração/aplicação; SEO, comunidades e criadores primeiro. Tráfego pago só como experimento com CAC e ativação medidos. Comunidade/presets compartilhados fora do MVP.

## Critério de escolha
Comparar custo inicial + renovação + egress + impostos + suporte + risco + lock-in + custo humano. Manter operação dentro de ~R$150/mês ou pedir aprovação para ultrapassar. Toda cotação deve registrar fonte oficial, data, moeda, limites e plano de saída.
