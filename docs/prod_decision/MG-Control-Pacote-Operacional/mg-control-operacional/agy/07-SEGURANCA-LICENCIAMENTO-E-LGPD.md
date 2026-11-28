# S07 — Segurança, licenciamento e LGPD
**Escopo:** revisão transversal S05/S06/S08; segurança equilibrada, sem DRM agressivo.

## Threat model
Roubo/replay token; brute force; enumeração; saldo forjado; abuso Gemini; prompt injection; webhook falso/replay; secrets; renderer/IPC compromise; CORS/CSRF/IDOR; LAN exposta; supply chain.

## Controles
TLS; secrets em secret manager/env; rotação; nunca bundle/log. Electron contextIsolation, nodeIntegration false, CSP, IPC allowlist, validação e navegação restrita. Access curto + refresh rotativo. Autorização server-side. Device key DPAPI, 3 dispositivos, revogação. Recursos locais livres/offline; licença só cloud/IA. AI schema estrito, catálogo de parâmetros, token cap, timeout e kill switch; modelo sem acesso a DB/billing/secrets/hardware. Webhook assinado + idempotência. DB least privilege, backup criptografado e restore. LAN/firewall documentados. Minimização de dados, retenção definida, feedback voluntário e política LGPD.

## Testes/gate
Unit permission/sanitization; integração tenant/account/webhook; E2E sessão expirada, device revogado, limite de device e local offline; security XSS/CSP/IPC/CORS/CSRF/IDOR/rate limit/replay/secret scan. Typecheck + Vitest + Playwright + security checks PASS. Vulnerabilidade crítica/alta bloqueia release.
