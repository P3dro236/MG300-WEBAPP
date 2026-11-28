# Arquitetura C4, Ownership e Limites — MG Control

> **Etapa:** S02 — Arquitetura, Contratos e Migração
> **Data:** 2026-11-28
> **Versão:** 1.0 (`contracts-v1`)

---

## 1. C4 Nível 1 — Contexto (Atual vs. Alvo)

### 1.1 Contexto Atual (Baseline S01)

```mermaid
flowchart TD
  Musician["Músico (Browser Desktop localhost:3001)"] -->|HTTP / WS| LocalWebApp["MG Control Webapp Local (Fastify + React via tsx)"]
  Phone["Celular na mesma LAN Wi-Fi"] -->|"HTTP / WS /ws (QR Pairing)"| LocalWebApp
  LocalWebApp -->|"USB-MIDI (WinMM via PowerShell C#)"| MG300["Pedaleira NUX MG-300 (NUX NME-300)"]
  LocalWebApp -->|"Leitura .nuxpreset"| QuickToneFiles["Pasta QuickTone / Disco Local"]
  LocalWebApp -->|"HTTPS REST + API Key em .env local"| Gemini["Google Gemini API v1beta"]
```

### 1.2 Contexto Alvo (`S03`–`S10`)

```mermaid
flowchart TD
  Musician["Músico no Windows x64"] -->|"App Standalone sem terminal"| ElectronApp["MG Control Desktop (Electron Standalone)"]
  Phone["Celular na LAN Wi-Fi (Offline sem login)"] -->|"HTTP / WS /ws (QR Pairing)"| ElectronApp
  ElectronApp -->|"USB-MIDI Local (Offline sem login)"| MG300["Pedaleira NUX MG-300"]
  ElectronApp -->|"Leitura .nuxpreset / Storage userData"| LocalDisk["Disco Local (%APPDATA%\\MG Control)"]
  ElectronApp -->|"HTTPS /v1 (JWT + Device Key DPAPI)"| CloudAPI["MG Control Cloud API (Fastify + PostgreSQL)"]
  PortalUser["Músico no Browser (Portal Web Separado)"] -->|"HTTPS (Conta, Créditos, Devices, Checkout)"| PortalWeb["Portal Web MG Control (PT/EN)"]
  PortalWeb -->|"HTTPS /v1"| CloudAPI
  Visitor["Visitante / Músico"] -->|"HTTPS"| Landing["Landing Page (mg300.vercel.app)"]
  CloudAPI -->|"HTTPS Server-side (API Key protegida)"| Gemini["Google Gemini API"]
  CloudAPI <-->|"Checkout + Webhooks Assinados"| Gateways["Stripe (Cartão/Pix) / Mercado Pago (Pix fallback)"]
  CloudAPI -->|"SMTP/API Transacional"| EmailProvider["Provedor de E-mail (Verificação/Recibos)"]
  ElectronApp -.->|"Check versão HTTPS (sem auto-update)"| CDN["Object Storage / CDN (Instaladores + SHA-256 + Manifest)"]
  Landing -->|"Download direto + SHA-256"| CDN
```

---

## 2. C4 Nível 2 — Containers

```mermaid
flowchart TD
  subgraph Desktop["PC Windows x64 (100% Operacional Offline para Local)"]
    Renderer["Container: Electron Renderer (React 19 + Tailwind v4, sem Node)"]
    Preload["Container: Electron Preload (contextBridge allowlist mg:v1:*)"]
    Main["Container: Electron Main (Lifecycle, DPAPI, Single Instance, Logs)"]
    LocalCore["Container: Local Core (Fastify + WS /ws + QuickTone Reader + MIDI)"]
    Renderer <-->|"IPC Tipado Zod"| Preload
    Preload <-->|"IPC Main"| Main
    Main -->|"Spawn / Health / Restart / Shutdown"| LocalCore
    Renderer <-->|"HTTP /api/* + WS /ws (localhost)"| LocalCore
  end

  Mobile["Browser Mobile na LAN (Wi-Fi Local)"] <-->|"HTTP /api/* + WS /ws"| LocalCore
  LocalCore <-->|"USB-MIDI WinMM"| Hardware["NUX MG-300"]

  subgraph Cloud["Infraestrutura Cloud (Monólito Modular)"]
    CloudFastify["Container: Cloud API (Fastify Modular /v1)"]
    PgDB[("Container: PostgreSQL 16+ (Auth, Devices, Ledger, Payments, AI Audit)")]
    Portal["Container: Portal Web (React/Web Separado PT/EN)"]
    CloudFastify <-->|"SQL Transacional / Migrations"| PgDB
    Portal -->|"HTTPS /v1"| CloudFastify
  end

  Main -->|"HTTPS /v1 (Auth, Device, AI Proxy)"| CloudFastify
```

---

## 3. C4 Nível 3 — Componentes Internos

### 3.1 Electron Shell & Local Core

```mermaid
flowchart TD
  subgraph MainProc["Electron Main Process"]
    AppLifecycle["AppLifecycleManager (Single Instance + Shutdown)"]
    CoreSupervisor["LocalCoreSupervisor (Port Probe + Health + Backoff Restart)"]
    DpapiVault["DpapiSessionStore (safeStorage / DPAPI tokens + deviceKey)"]
    IpcHandlers["TypedIpcRouter (Allowlist mg:v1:*)"]
    UpdateChecker["UpdateNoticeClient (GET version-manifest.json)"]
    DiagExporter["DiagnosticsBundleExporter (Logs sanitizados)"]
    AppLifecycle --> CoreSupervisor
    IpcHandlers --> CoreSupervisor
    IpcHandlers --> DpapiVault
    IpcHandlers --> UpdateChecker
    IpcHandlers --> DiagExporter
  end

  subgraph CoreProc["Local Core Process (Node/Electron Utility)"]
    FastifyApp["Fastify HTTP + Static Server"]
    LanSecurity["NetworkSecurity + PairingManager (QR + HttpOnly Cookie)"]
    StateMgr["ControllerStateManager (Merge Disco + Hardware)"]
    ExpEdit["ExperimentalEditService (10 Blocos + Backup + 0x0E)"]
    ToneCompiler["DeterministicToneCompiler (buildAndCalibrateStruct102 + Ambience Policy)"]
    MidiSvc["MidiService (Tri-State + Allowlist + SysEx)"]
    WinMm["WinMmMidiAdapter (winmm.dll Bridge)"]
    QtReader["QuickToneDiscoveryService (.nuxpreset V1/V2/V4)"]

    FastifyApp --> LanSecurity
    FastifyApp --> StateMgr
    FastifyApp --> ExpEdit
    ExpEdit --> ToneCompiler
    StateMgr --> MidiSvc
    StateMgr --> QtReader
    ExpEdit --> MidiSvc
    MidiSvc --> WinMm
  end

  CoreSupervisor -->|"Supervisiona"| CoreProc
```

### 3.2 Cloud Backend Modular (`/v1`)

```mermaid
flowchart TD
  subgraph CloudAPI["Cloud Fastify Modular (/v1)"]
    Gateway["HTTP Gateway (TLS, CORS, Rate Limit, Request ID, Error Envelope)"]
    AuthMod["AuthModule (Register, Verify Email, Login, Refresh Rotativo, Logout)"]
    AccountMod["AccountModule (Perfil, Status de E-mail, Sem Presets)"]
    DeviceMod["DeviceModule (Registro Atômico <= 3 Devices, Revogação)"]
    CreditMod["CreditLedgerModule (Trial 30d, Comprados, Reserva/Consumo/Liberação Idempotente)"]
    AiMod["AiProxyModule (Gemini Adapter, usageMetadata, Budget Cap, Kill Switch, Feedback)"]
    BillingMod["BillingModule (PaymentProvider Adapter, Stripe/Mercado Pago, Webhooks Idempotentes)"]
    AuditMod["SecurityAuditModule (Eventos Auth/Billing/IA sem segredos)"]

    Gateway --> AuthMod
    Gateway --> AccountMod
    Gateway --> DeviceMod
    Gateway --> CreditMod
    Gateway --> AiMod
    Gateway --> BillingMod
    AiMod --> CreditMod
    AiMod --> DeviceMod
    BillingMod --> CreditMod
    AuthMod --> AuditMod
    DeviceMod --> AuditMod
    BillingMod --> AuditMod
  end
```

---

## 4. Ownership e Fronteiras Estritas por Módulo

| Módulo | Responsabilidades Exclusivas | Proibições Absolutas (Limites) |
|---|---|---|
| **Electron Main** | Single instance, lifecycle do app e do Local Core, resolução de `userData`, guarda segura de sessão/device key via DPAPI/`safeStorage`, verificação passiva de versão, exportação de diagnóstico sanitizado, navegação externa controlada (`https://`). | **Proibido:** duplicar rotas HTTP/WS do Local Core, acessar USB-MIDI diretamente fora do Core, armazenar segredos de Cloud/Gemini/Gateway, bloquear recursos locais sem login. |
| **Preload IPC** | Expor via `contextBridge` somente os canais da allowlist `mg:v1:*` com validação estrita de payload. | **Proibido:** expor `ipcRenderer` genérico, `fs`, `child_process`, `process.env` ou qualquer primitiva Node ao Renderer. |
| **Renderer (React UI)** | Interface Desktop/Mobile (Palco, Matriz, Editor 10 blocos, Pareamento LAN, Modal IA, UI de Conta/Saldo somente via IPC/API tipada), persistência local de preferências/cache no browser. | **Proibido:** `nodeIntegration`, importar módulos Node, guardar `GEMINI_API_KEY`, confiar em saldo local para liberar IA, chamar Gemini diretamente. |
| **Local Core (`@quicktone/backend` + `@quicktone/midi` + `@quicktone/reader`)** | Servidor HTTP/WS local, pareamento QR LAN e sessão única mobile, leitura `.nuxpreset`, comunicação USB-MIDI WinMM, edição 10 blocos, backup local pré-`0x0E`, compilação/calibração determinística `struct102` (consumindo plano vindo da Cloud na IA). | **Proibido:** exigir internet ou conta para MIDI/presets/LAN, conter `GEMINI_API_KEY` ou segredos de pagamento em produção, alterar firmware da MG-300, gravar em slots Factory (`36..71`). |
| **Cloud Backend (`/v1` + PostgreSQL)** | Auth, verificação de e-mail, sessões refresh hashed, registro e limite atômico de 3 dispositivos, ledger transacional de créditos, proxy Gemini server-side com medição de tokens/custo e kill switch, checkout e webhooks Stripe/Mercado Pago, feedback voluntário. | **Proibido:** acessar `localhost`/LAN do usuário, controlar MIDI, hospedar biblioteca/sync de presets no MVP, confiar em saldo/preço enviado pelo cliente, criar microservices separados sem necessidade medida. |
| **Portal Web Separado** | Fluxo autenticado web PT/EN: cadastro/login/verificação, visualização de saldo/ledger, compra de créditos (Cartão + Pix), gestão/revogação dos 3 dispositivos e dados da conta. | **Proibido:** comunicar com USB-MIDI, parear LAN local, armazenar presets ou conter chaves privadas de gateway/IA. |
