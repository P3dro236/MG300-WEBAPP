# S03 — Electron shell e orquestração
**Objetivo:** app standalone Windows, sem terminal/browser manual.

- Main: lifecycle, single instance, spawn/stop/health-check/restart do Local Core, shutdown limpo e logs sanitizados.
- Preload: contextBridge, API mínima tipada, validação; nunca expor IPC genérico.
- Renderer: React UI; `contextIsolation=true`, `nodeIntegration=false`, CSP e sandbox quando compatível.
- Resolver paths dev/prod, assets, binários, storage persistente e logs via ADR.
- Bloquear navegação inesperada; links externos controlados.
- Não duplicar servidor nem estado; Main apenas orquestra o core existente.
- Criar instalador de teste, não publicar.

## Testes
Unit lifecycle/path/IPC; integração spawn, health, shutdown, crash, restart, porta ocupada; Playwright Electron abrir/fechar/reabrir/persistência; segurança renderer/IPC/navigation; regressão UI, presets, geração e LAN.

## Gate
Abre por atalho sem terminal; Main gerencia core; sem processo órfão; dados preservados; segurança Electron validada; typecheck + Vitest + Playwright PASS. Falha bloqueia S04.
