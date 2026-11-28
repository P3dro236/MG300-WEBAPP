# Dependências, Nativos e Acoplamentos Externos — MG Control

> **Etapa:** S01 — Auditoria Baseline
> **Data:** 2026-11-28

---

## 1. Dependências Declaradas por Pacote (`package.json`)

### 1.1 Raiz (`quicktone-web-controller@1.0.0`)
| Pacote | Versão declarada | Tipo | Papel atual |
|---|---|---|---|
| `react` / `react-dom` | `^19.0.0` | devDependency (hoisted) | UI React 19 |
| `fastify` | `^5.2.1` | devDependency (hoisted) | Servidor HTTP local |
| `ws` | `^8.18.0` | devDependency (hoisted) | Servidor WebSocket local |
| `zod` | `^3.24.2` | devDependency (hoisted) | Validação de contratos e schemas |
| `vite` / `@vitejs/plugin-react` | `^6.1.0` / `^4.3.4` | devDependency | Bundler do frontend |
| `tailwindcss` / `@tailwindcss/vite` | `^4.0.0` / `^4.0.0` | devDependency | Estilização Tailwind v4 |
| `typescript` / `tsx` | `^5.7.3` / `^4.19.2` | devDependency | Typecheck e execução TS direta do backend |
| `vitest` / `jsdom` / `@testing-library/*` | `^3.0.5` / `^26.0.0` / `^16.2.0` | devDependency | Testes unitários e de integração |
| `@playwright/test` | `^1.51.0` | devDependency | Testes E2E browser |
| `@types/node`, `@types/react`, `@types/react-dom`, `@types/ws` | `^22.13.0`, `^19.0.8`, `^19.0.3`, `^8.5.14` | devDependency | Tipagens TypeScript |

### 1.2 Workspaces (`packages/*`)
| Workspace | Dependências runtime (`dependencies`) | Observação |
|---|---|---|
| `@quicktone/shared` | `zod ^3.24.2` | Zero dependências nativas |
| `@quicktone/reader` | `@quicktone/shared *` | Apenas `node:fs`, `node:os`, `node:path` |
| `@quicktone/midi` | `@quicktone/shared *` | Apenas `node:child_process`, `node:crypto`, `node:fs`, `node:os`, `node:path`, `node:readline` + `powershell.exe`/`winmm.dll` em runtime |
| `@quicktone/backend` | `@quicktone/shared *`, `@quicktone/reader *`, `@quicktone/midi *`, `fastify ^5.2.1`, `ws ^8.18.0`, `zod ^3.24.2` | Sem `@google/genai`, sem `dotenv`, sem driver DB; usa `fetch` nativo do Node |
| `@quicktone/frontend` | `@quicktone/shared *`, `react ^19.0.0`, `react-dom ^19.0.0`, `lucide-react ^0.475.0`, `@fontsource/inter ^5.1.0`, `@fontsource/jetbrains-mono ^5.1.0` | Fontes empacotadas offline para LAN sem internet |

---

## 2. Auditoria do Lockfile (`package-lock.json`)

Inspeção direta de `package-lock.json`:
- **Total de pacotes resolvidos:** `344`
- **Pacotes com `hasInstallScript` ou pistas nativas (`node-gyp`, `prebuild-install`, `node-addon-api`):**
  1. `node_modules/esbuild@0.28.2`
  2. `node_modules/vite/node_modules/esbuild@0.25.12`
  3. `node_modules/fsevents@2.3.3` (macOS optional)
- **Conclusão importante:** Não há **nenhum** addon C/C++ nativo (`node-midi`, `easymidi`, `usb`, `serialport`, `better-sqlite3`, etc.) instalado no `node_modules`.

---

## 3. Dependências de Sistema Operacional (Windows) e Impacto em Electron

Embora o `node_modules` não possua addons nativos Node-API, o acesso ao USB-MIDI depende de uma ponte Windows personalizada em [winmm-adapter.ts](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/midi-service/src/winmm-adapter.ts):
1. **`powershell.exe`:** Executado via `child_process.execFile` (listagem de portas) e `child_process.spawn` (worker persistente de I/O).
2. **.NET Framework / `Add-Type` (`csc.exe`):** Compila `WINMM_CSHARP_SOURCE` em `%TEMP%\quicktone-winmm-<hash>\bridge.dll` na primeira execução.
3. **`winmm.dll`:** P/Invoke direto para `midiInOpen`, `midiOutOpen`, `midiOutShortMsg`, `midiOutLongMsg`, `midiInAddBuffer` etc.
4. **Implicação para S03/S04/S09:**
   - Vantagem: não sofre quebra de ABI (`NODE_MODULE_VERSION`) entre Node 24 e Electron, pois não é um `.node` nativo carregado em processo.
   - Riscos: compilação C# em tempo de execução em `%TEMP%` pode sofrer bloqueio de Windows Defender / SmartScreen / AppLocker / políticas corporativas; execução de `powershell.exe -ExecutionPolicy Bypass` em app desktop empacotado gera alertas heurísticos e risco de processo filho órfão se o Main/Core encerrar abruptamente.

---

## 4. Serviços Externos e Acoplamentos Atuais

| Serviço / Binário | Uso atual | Evidência | Status para arquitetura-alvo |
|---|---|---|---|
| Google Gemini API (`generativelanguage.googleapis.com/v1beta`) | Geração de timbre (`AiToneService`) e validação de guitarra (`AiGearStore`) | [gemini-client.ts](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/backend/src/ai/gemini-client.ts#L80) | Deve migrar 100% para Cloud (`S06`) com chave exclusivamente server-side |
| Google Chrome (canal local) | Execução do Playwright E2E (`channel: 'chrome'`) | [playwright.config.ts](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/playwright.config.ts#L20) | Requer Chrome instalado no ambiente de testes |
| `files/quicktone/QuickTone.exe` e `files/nuxpreset/` | Referência local (gitignored via `files/`) | [discovery.ts](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/quicktone-reader/src/discovery.ts), [tone-calibrator.ts](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/backend/src/ai/tone-calibrator.ts#L288) | `QuickTone.exe` trava porta `NUX NME-300` se aberto simultaneamente |
| Fontes web (`@fontsource/inter`, `@fontsource/jetbrains-mono`) | Bundled pelo Vite | [packages/frontend/package.json](file:///C:/Users/pedro/Desktop/mg/NUXMG300-WEBAPP/packages/frontend/package.json#L13-L14) | Compatível com LAN offline |

---

## 5. Dependências Faltantes para Etapas Futuras (`S03`–`S09`)

Ainda **não instaladas** (e não devem ser instaladas antes dos ADRs de S02):
- **S03/S09 (Desktop):** `electron`, empacotador Windows (`electron-builder` ou `electron-forge`), eventual helper WinMM pré-compilado se decidido em ADR.
- **S05/S07 (Cloud & Segurança):** driver/query builder/ORM PostgreSQL (`pg`, `drizzle-orm` ou `prisma`), migrações, envio de e-mail transacional, hashing de senha (`argon2` / `scrypt`), JWT/assinatura, DPAPI binding no Windows (PowerShell/N-API/Electron `safeStorage`).
- **S08 (Billing):** SDKs/clientes Stripe e Mercado Pago.
- **Qualidade/CI:** ESLint, Prettier, `@vitest/coverage-v8`, GitHub Actions.
