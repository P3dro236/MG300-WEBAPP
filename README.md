# NUX MG-300 Web Controller

Controle a sua pedaleira **NUX MG-300** pelo navegador do computador ou pelo celular usando a rede Wi-Fi local com pareamento obrigatório via QR Code.

---

## Como funciona na prática

1. **A pedaleira fica conectada via USB ao computador** (Windows com driver USB-MIDI padrão).
2. **O controlador roda no computador** e conversa diretamente com a MG-300 (leitura de presets e controle em tempo real).
3. **Os presets e preferências ficam salvos no navegador (`localStorage`)**, sem precisar configurar pastas manualmente no disco.
4. **Acesso pelo celular via QR Code obrigatório**: gere um QR Code temporário em **Ajustes** no computador, escaneie com o celular na mesma rede Wi-Fi e autorize a conexão na tela do computador. Apenas **um celular controlador por vez** pode operar a pedaleira.
5. **Tudo sincroniza em tempo real**: se você trocar de timbre, ajustar o **Volume Master** ou pisar no footswitch físico da pedaleira, computador e celular autorizado atualizam juntos no mesmo instante.

---

## Recursos principais

- **Biblioteca limpa (Usuário e Fábrica)**: exibe apenas os seus presets personalizados em **Usuário** e os 36 timbres originais da pedaleira em **Fábrica**, ocultando slots vazios/padrões e cópias de fábrica não editadas.
- **Editor completo de 10 blocos (`COMP..MIC` + Níveis)**: selecione o pedal/modelo real da NUX MG-300 em cada bloco (`COMP`, `EFX`, `AMP`, `EQ`, `NR`, `MOD`, `DLY`, `RVB`, `CAB` incluindo `USER IR` e `MIC`) com controles dinâmicos por modelo em tempo real via MIDI CC.
- **Criar e importar presets (`.nuxpreset`) pelo celular ou PC**: crie presets novos do zero (nome até 18 caracteres MG-300, BPM e sync de delay) ou importe arquivos `.nuxpreset` individuais e pacotes de 36 slots (com aviso explícito quando o preset usar User IR), gravando em qualquer slot de Usuário (`1A–9D`) com backup automático pré-sobrescrita, confirmação explícita e bloqueio estrito contra escrita em slots de Fábrica (`F1A–F9D`).
- **Volume Master exclusivo**: controle fino e estável do **Volume Master** da pedaleira, tanto no slider quanto nos botões `-5` / `+5`.
- **Confirmação real da pedaleira**: diferencia claramente comandos recém-enviados de alterações confirmadas pelo hardware, além de separar o status da conexão MIDI do status da conexão com o servidor (WebSocket).
- **Modo Palco e Matriz**: alterne entre botões grandes de footswitch (`A–D`) para tocar ao vivo e a grade completa (`1–9`) com busca por nome.
- **Segurança na rede Wi-Fi e Dispositivos Confiáveis**: acesso mobile restrito à rede local privada, proteção contra DNS rebinding (validação de `Host` e `Origin`), pareamento por QR Code de uso único, aprovação explícita no desktop, sessão autenticada por cookie `HttpOnly`, reconexão simplificada para **Dispositivos Confiáveis** e revogação instantânea.

---

## Como começar a usar

### Pré-requisitos

- **Node.js** instalado no computador (versão 20 ou superior recomendada).
- Pedaleira **NUX MG-300** conectada ao computador por um cabo Micro-USB de dados.
- O programa **NUX QuickTone** deve estar **fechado** antes de conectar pelo controlador, pois o Windows permite que apenas um programa acesse a porta USB-MIDI por vez.

### 1. Instalar dependências

```bash
npm install
```

### 2. Iniciar o controlador (modo recomendado)

```bash
npm run build
npm start
```

- No computador: `http://localhost:3001`
- Para parear o celular (mesmo Wi-Fi): abra **Ajustes → Gerar QR Code** no computador, escaneie com a câmera do celular e clique em **Autorizar Celular** no computador.

### 3. Modo de desenvolvimento

```bash
# Terminal 1 — Backend e comunicação MIDI
npm run dev:backend

# Terminal 2 — Interface web (Vite)
npm run dev:frontend
```

---

## Guias adicionais

- [Guia de Acesso pelo Celular e Pareamento QR Code](docs/MOBILE_ACCESS_GUIDE.md)
- [Guia de Conexão USB-MIDI com a NUX MG-300](docs/MIDI_CONNECTION_GUIDE.md)
- [Guia de Formato e Leitura de Presets](docs/QUICKTONE_GUIDE.md)
- [Limitações Conhecidas](docs/KNOWN_LIMITATIONS.md)
- [Decisões Técnicas do Projeto](docs/TECHNICAL_DECISIONS.md)
