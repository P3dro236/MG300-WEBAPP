# QuickTone Web Controller — NUX MG-300 LAN Controller

Aplicação full-stack (**Node.js + TypeScript + Fastify + WebSocket + Zod** no backend e **React + TypeScript + Vite + Tailwind CSS** no frontend) para controlar uma pedaleira **NUX MG-300 (`NUX NME-300`)** pela rede Wi-Fi local, utilizando os arquivos locais de presets do **NUX QuickTone (`.nuxpreset` / `MG300AllPreset.nuxpreset`)** como fonte de dados somente leitura.

---

## 1. Arquitetura do Monorepo

```text
NUXMG300-WEBAPP/
├── docs/
│   ├── TECHNICAL_DECISIONS.md     # ADRs e mapeamentos baseados em evidências reais
│   ├── QUICKTONE_GUIDE.md         # Guia de configuração do QuickTone e formato binário .nuxpreset
│   ├── MIDI_CONNECTION_GUIDE.md   # Guia de conexão USB-MIDI e protocolo da NUX MG-300
│   ├── MOBILE_ACCESS_GUIDE.md     # Guia de acesso pelo celular/tablet via Wi-Fi local
│   └── KNOWN_LIMITATIONS.md       # Limitações conhecidas e status de validação com hardware real
├── packages/
│   ├── shared/                    # @quicktone/shared — Schemas Zod, tipos TypeScript e protocolo MG-300
│   ├── quicktone-reader/          # @quicktone/reader — Descoberta, parser binário somente leitura e watcher
│   ├── midi-service/              # @quicktone/midi — Abstração MIDI independente, WinMM bridge, Mock e Tri-State
│   ├── backend/                   # @quicktone/backend — Servidor Fastify (0.0.0.0), REST API, WebSocket e segurança LAN
│   └── frontend/                  # @quicktone/frontend — Interface React mobile-first tema escuro para palco
└── e2e/
    └── controller.spec.ts         # Testes End-to-End com Playwright
```

---

## 2. Principais Funcionalidades e Garantias de Segurança

1. **Leitura Somente Leitura dos Presets Reais do QuickTone (`.nuxpreset`)**:
   - Decodifica o formato binário real `"MG300 Preset Data"` (`8.380`/`8.381 B` para preset individual e `300.673`/`300.709 B` para pacote completo `MG300AllPreset.nuxpreset`), incluindo a estrutura de `102 bytes` (`0x66 B`), a tabela real de **72 caracteres (`0x00..0x47`)** da ROM LCD da MG-300 e o catálogo dos 36 presets de fábrica (`F1A..F9D`).
   - Monitoramento em tempo real da pasta de presets (`fs.watch`) e configuração manual de diretório quando a pasta não é encontrada.
2. **Abstração USB-MIDI Independente e Proteção da Pedaleira**:
   - Mapeia os bancos `1A..9D` (usuário, slots `0..35`) e `F1A..F9D` (fábrica, slots `36..71`) para o comando real de seleção de preset da MG-300 (**`CC 0x3C` / `CC 60`**, `[0xB0, 0x3C, slotIndex]`), além de suportar `Program Change (0xC0)` e `Bank Select MSB (CC 0x00) / LSB (CC 0x20)`.
   - Controla os CCs reais de volume validados no firmware da MG-300 (`0..100`):
     - **`CC 0x40` (`CC 64`)**: Volume Global `MASTER` (`state[0x09]`).
     - **`CC 0x4A` (`CC 74`)**: Volume do Preset `PATCH LEVEL` (`P.LVL`, `state[0x46F]`).
     - **`CC 0x3D` (`CC 61`)**: Posição do Pedal de Expressão (`state[0x12]`).
   - **Bloqueio contra CCs perigosos**: impede o envio de `CC 1..10` como comandos de volume (na MG-300, `CC 7` altera o modelo do bloco de Delay `state[0x411]`).
3. **Modelo Tri-State de Sincronismo com o Hardware**:
   - Diferencia explicitamente no backend e na interface:
     - **`confirmed`**: Estado confirmado por mensagem recebida da pedaleira via MIDI IN (`confirmedState`).
     - **`command_sent_unconfirmed`**: Último comando transmitido pelo computador via MIDI OUT (`lastSentCommand`), aguardando confirmação real do dispositivo.
     - **`unknown`**: Estado desconhecido (inicial ou pós-desconexão).
4. **Sincronização Multi-Cliente via WebSocket e Segurança LAN**:
   - Servidor Fastify configurável em `0.0.0.0:3001`.
   - Sincronização instantânea entre múltiplos celulares/tablets conectados na mesma rede Wi-Fi.
   - Validação de origem (`Origin` restrito a localhost e sub-redes privadas RFC 1918) e autenticação simples configurável via PIN/Token (`QUICKTONE_AUTH_TOKEN` / cabeçalho `X-QuickTone-Token`).

---

## 3. Instalação, Execução e Testes

### Instalar dependências
```bash
npm install
```

### Executar verificação de tipos (TypeScript)
```bash
npm run typecheck
```

### Executar testes unitários e de integração (Vitest + React Testing Library)
```bash
npm test
```

### Executar testes End-to-End (Playwright)
```bash
npm run test:e2e
```

### Iniciar aplicação em modo de desenvolvimento
```bash
# Terminal 1 — Backend Fastify + WebSocket (0.0.0.0:3001)
npm run dev:backend

# Terminal 2 — Frontend Vite React (0.0.0.0:5173)
npm run dev:frontend
```

### Compilar e iniciar para produção (Palco / LAN)
```bash
npm run build
npm start
```

---

## 4. Endpoints da API REST e WebSocket

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/health` | Status de saúde do servidor, uptime, estado MIDI e status de sincronização. |
| `GET` | `/api/presets` | Lista de presets carregados do QuickTone, status da pasta e avisos de validação. |
| `GET` | `/api/status` | Estado completo do controlador (`confirmedState`, `lastSentCommand`, `syncStatus`, portas MIDI). |
| `POST` | `/api/presets/select` | Seleciona um preset por `presetId` (ex.: `"1A"`, `"F2C"`) ou `slotIndex` (`0..71`). |
| `PUT` | `/api/volume` | Ajusta o volume (`0..100`) no alvo selecionado (`master_cc64`, `patch_cc74` ou `expression_cc61`). |
| `POST` | `/api/midi/connect` | Conecta à porta USB-MIDI da MG-300 (`"NUX NME-300"` ou porta especificada). |
| `POST` | `/api/midi/disconnect` | Desconecta da porta USB-MIDI ativa. |
| `POST` | `/api/presets/config` | Configura manualmente o caminho da pasta de presets do QuickTone. |
| `WS` | `/ws` | Canal WebSocket bidirecional para sincronização `state_sync` e `presets_updated` em tempo real. |

---

## 5. Documentação Complementar

- [Decisões Técnicas e Evidências (ADRs)](docs/TECHNICAL_DECISIONS.md)
- [Guia de Configuração do QuickTone](docs/QUICKTONE_GUIDE.md)
- [Guia de Conexão USB-MIDI](docs/MIDI_CONNECTION_GUIDE.md)
- [Guia de Acesso pelo Celular (Wi-Fi Local)](docs/MOBILE_ACCESS_GUIDE.md)
- [Relatório de Limitações Conhecidas e Validação de Hardware](docs/KNOWN_LIMITATIONS.md)
