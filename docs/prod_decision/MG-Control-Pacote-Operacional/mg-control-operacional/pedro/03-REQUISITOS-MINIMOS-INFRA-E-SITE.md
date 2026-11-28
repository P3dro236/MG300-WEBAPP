# Requisitos mínimos — infra, backend, site e distribuição
**Nota:** faixas abaixo são parâmetros preliminares para cotação/teste, não capacidade medida nem garantia. Substituir por auditoria, teste de carga e métricas reais.

## Requisitos objetivos
**Site/portal:** HTTPS, domínio próprio, PT/EN, responsivo, acessível; landing pública e portal autenticado separados; portal com conta/saldo/compras/devices; secrets nunca no frontend; CDN para assets; instaladores em object storage/CDN com SHA-256; SEO/sitemap/robots/OG; termos, privacidade, suporte, compatibilidade e instruções. Vercel pode hospedar frontend; API pode ficar na VPS. Sem analytics geral.

**Backend:** Fastify modular + PostgreSQL; `/v1`; TLS; migrations; health/readiness; e-mail verificado; access curto/refresh rotativo; limite 3 devices; DPAPI; ledger transacional e idempotente; webhook assinado; proxy Gemini server-side; rate limits IP/conta/device; timeout/token cap/retry limitado; budget cap/kill switch; backups externos criptografados e restore testado; logs sanitizados; sem presets cloud.

**Distribuição:** Electron Windows x64 standalone; MIDI nativo compatível com runtime; instalador assinado quando viável; checksum; download HTTPS; manifest de versão + aviso/link; dados preservados; testes em Windows limpo e PC secundário.

## Faixas iniciais para cotação e teste
MAU = usuários ativos mensais; carga cloud é menor que MAU sugere porque controle local pode operar offline.

| Dimensão | 0–100 MAU | 100–1.000 MAU | 1.000+ MAU |
|---|---|---|---|
| API | 2 vCPU / 4 GB RAM como baseline de teste | 2–4 vCPU / 8 GB ou separar DB conforme métricas | App horizontal; dimensionar por teste e SLO |
| PostgreSQL | Mesma VPS; SSD/NVMe | Separar DB se CPU/IO/risco justificar; 2–4 vCPU / 4–8 GB inicial | Gerenciado/HA se disponibilidade/receita justificar |
| Disco DB | 40–80 GB inicial | 80–160 GB conforme retenção | Escalar pelo crescimento medido |
| Banda | Cotar 1 TB/mês inicial | Cotar 1–3 TB/mês | Medir egress; CDN para binários |
| Storage installer | 5–20 GB | 20–50 GB | Object storage + CDN + lifecycle |
| Latência API | p95 <500 ms operações comuns, excluindo Gemini/gateway | Meta p95 <500 ms | SLO medido por endpoint |
| DB | p95 <100 ms queries simples como alvo | Índices/pool; p95 <100–200 ms | Pooler/tuning/read replica se necessário |
| Concorrência API | Teste 10–25 requests simultâneas | Teste 25–100 | Degraus 100+ conforme tráfego |
| IA | 1–3 gerações simultâneas inicialmente | Fila e limite global | Workers/fila escaláveis e quota |
| Backup | Diário; retenção 7–30 dias; fora da VPS | Diário + PITR se viável; 14–30 dias | PITR/HA; RPO/RTO definidos |

Não assumir que 1.000 MAU exige cluster: frequência, concorrência, tokens e downloads determinam carga.

## IA e limites
Confirmar model ID exato e preços/limites oficiais atuais. Medir tokens input/output/thinking, chamadas, retries, latência, custo e falha por geração. Limitar tokens, timeout, concorrência, retries e custo. Quotas por conta/device/IP; orçamento diário/mensal, alerta e kill switch. Assinatura Gemini pessoal não substitui API comercial. Revisar política de dados do provedor. Sem BYOK. Validar saída com schema e catálogo determinístico MG-300.

Custo por geração = soma de tokens por chamada × preço vigente + retries + chamadas auxiliares. Acrescentar falhas, taxas gateway, impostos, chargebacks e trial. Não usar preço/modelo antigo não verificado; “Gemini 3.5 Flash” deve ser confirmado no código e docs oficiais.

## Infra inicial para cotar
VPS Linux LTS 2 vCPU/4 GB/40–80 GB SSD como ponto inicial; firewall, SSH key, patching, TLS, backup fora da VPS, monitoramento e alertas. PostgreSQL não exposto publicamente, usuário least-privilege, migrations e restore periódico. E-mail com SPF/DKIM/DMARC. Logs sanitizados, métricas de uptime/latência/erro/DB/IA/billing; sem analytics geral.

## Orçamento
Teto declarado ~R$150/mês. Estimativa anterior: VPS R$50–80, backup R$10–15, domínio provisionado R$5–15, monitoramento R$0–10 — hipóteses, não cotações atuais. API Gemini, e-mail, storage/egress, gateway, impostos e certificado podem elevar custo. Assinaturas Gemini pessoais são custo de desenvolvimento, não API de produção. Se total exceder teto, apresentar cenários e pedir autorização.

## Checklist fornecedor
Registrar preço e renovação, moeda/impostos, CPU/RAM/disco/banda/egress, limites, região/latência Brasil, SLA/backups/suporte/restore, política de dados, lock-in/plano de saída, fonte oficial e data da cotação.

## Fora do MVP
Cloud presets, comunidade/compartilhamento, assinatura, análise/melhoria IA, outras pedaleiras/macOS, auto-update completo, telemetria geral.
