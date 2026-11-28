# S11 — Validação integrada e Go/No-Go
## Cenários críticos
1. Instalação Windows limpa sem Node/npm/terminal.
2. Local offline: MIDI, presets, QuickTone.
3. LAN celular↔PC em rede sem internet.
4. Hotplug/reconnect e restart.
5. Verificação e-mail, login, registro de device; 4º device bloqueado; revogação e substituição.
6. IA: sucesso consome 1; falha libera; retry não duplica.
7. Trial expira em 30 dias; comprado não expira.
8. Compra cartão e Pix; webhook duplicado; refund e conciliação.
9. Portal separado; cross-account negado.
10. Aviso/download de update preserva dados.
11. Cloud indisponível não derruba local.
12. Backup/restore; security suite.

## Gate
Rodar typecheck, Vitest unit/integration, Playwright web/Electron, build/installer, hardware matrix, API security e restore. Runbooks: Gemini/gateway/DB/VPS/e-mail indisponível, rollback e incidente. Logs mínimos; budget alert/kill switch.

**GO:** gates S01–S10 PASS; sem P0/P1; MIDI/LAN em hardware real e PC secundário; cartão+Pix; ledger idempotente; restore; instalador; políticas publicadas; Pedro aprova.  
**NO-GO:** falha crítica, segredo exposto, perda de preset, cobrança incorreta ou internet exigida para uso local.
