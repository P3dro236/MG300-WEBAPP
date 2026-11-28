# S09 — Build, distribuição e CI/CD
Windows x64; download direto inicial. Repo GitHub privado não é distribuição pública. Atualização inicial = aviso + botão/link de download; auto-update completo fora do MVP. Code Signing recomendado, contratação exige aprovação.

## Tarefas
Escolher Electron Builder/Forge via ADR; empacotar módulo MIDI nativo na ABI correta; separar app/dados/logs/cache; build reproduzível; versionamento; assinatura se certificado disponível; checksum SHA-256; storage/CDN HTTPS; manifest de versão; aviso/link; rollback manual; CI typecheck/test/build; secrets protegidos. Upgrade/desinstalação preservam dados conforme política.

## Testes/gate
Build clean; instalar em Windows limpo sem Node/npm; MIDI em PC secundário; paths com espaços/acentos; usuário sem admin quando possível; upgrade preserva presets/config; uninstall; hash/manifest inválido; E2E instalar→abrir→MIDI→LAN→update manual→reabrir. Typecheck + Vitest + Playwright + build PASS. Não publicar sem MIDI no pacote real.
