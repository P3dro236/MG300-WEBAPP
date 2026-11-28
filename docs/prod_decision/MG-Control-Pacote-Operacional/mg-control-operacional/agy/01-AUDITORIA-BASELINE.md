# S01 — Auditoria baseline
**Objetivo:** descobrir o estado real do monorepo antes de propor refatoração. Não implementar nesta etapa.

## Ações
1. Registrar branch, commit, Node/npm, Windows, arquitetura e comandos de execução.
2. Mapear workspaces, pastas, entrypoints, scripts, dependências e módulos nativos.
3. Ler `package.json` raiz e por pacote; identificar versões e scripts reais.
4. Rastrear UI → backend local → Gemini → preset → MIDI → MG-300.
5. Mapear endpoints HTTP, WebSocket, portas, bind, CORS, firewall e protocolo LAN.
6. Documentar fluxo celular→PC→pedaleira; testar rede sem internet.
7. Identificar storage local, formatos de preset, backups e caminhos Windows.
8. Localizar model ID Gemini exato, SDK, prompts, schema, tokens, retries e erros.
9. Auditar testes reais: cobertura, mocks, flakes, ambiente, E2E e hardware.
10. Revisar segurança: secrets, logs, auth local, exposição LAN, validação, dependências.
11. Inspecionar `mg300.vercel.app` e identificar repo/deploy, se acessível.
12. Não corrigir; registrar evidências e severidade P0–P3.

## Entregáveis
`docs/audit/BASELINE.md`, `TEST-MATRIX.md`, `DEPENDENCIES.md`, `RISKS.md`, `DECISIONS-NEEDED.md`; diagramas atual/local-cloud; instruções reproduzíveis.

## Regressão e gate
Rodar typecheck, Vitest e Playwright atuais. Smoke manual: iniciar, conectar MG-300, ler/escrever/readback preset, gerar/aplicar timbre, testar celular LAN, desconectar/reconectar e testar sem internet. Gate: baseline reproduzível; MIDI/LAN documentados; model ID identificado ou pendência explícita; lacunas mapeadas; nenhum arquivo funcional alterado; todos os testes automatizados PASS. Falha bloqueia S02.
