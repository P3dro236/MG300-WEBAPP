# Guia de Acesso pelo Celular / Tablet via Wi-Fi Local — QuickTone Web Controller

O **QuickTone Web Controller** foi projetado com arquitetura mobile-first para que músicos possam controlar a **NUX MG-300** pelo navegador do celular ou tablet durante ensaios e apresentações ao vivo, usando a mesma rede Wi-Fi local do computador conectado à pedaleira via USB.

---

## 1. Passo a Passo para Conectar pelo Celular

1. **Conecte o computador e o celular à mesma rede Wi-Fi local** (roteador doméstico, roteador de palco ou hotspot local).
2. **Inicie o servidor no computador conectado à MG-300 por USB**:
   ```bash
   npm run build
   npm start
   ```
   - Por padrão, o backend Fastify escuta em **`0.0.0.0:3001`** (servindo tanto a API REST `/api/*`, o WebSocket `/ws` e os arquivos estáticos compilados do frontend React) ou, em modo de desenvolvimento (`npm run dev:backend` + `npm run dev:frontend`), o Vite escuta em **`0.0.0.0:5173`**.
3. **Descubra o endereço IP local (LAN) do computador**:
   - No Windows, verifique o IP da interface Wi-Fi (ex.: `192.168.1.15` ou `192.168.0.100`) exibido no log de inicialização do servidor backend.
4. **Abra o navegador no celular (Chrome, Safari, Firefox)**:
   - Acesse:
     ```
     http://<IP-DO-COMPUTADOR>:3001
     ```
     *(ou `http://<IP-DO-COMPUTADOR>:5173` durante o modo `dev:frontend`)*.

---

## 2. Firewall do Windows (Caso o Celular Não Consiga Conectar)

Se a página abrir em `http://localhost:3001` no computador, mas não carregar no celular:
1. Certifique-se de que o perfil de rede Wi-Fi no Windows está configurado como **Rede Privada** (Configurações → Rede e Internet → Wi-Fi → Propriedades da rede → Perfil de rede: **Privado**).
2. Libere a porta TCP `3001` (e `5173` se usar Vite dev) apenas para a **Rede Privada (LAN)** no Firewall do Windows — **nunca** exponha a porta à internet pública (WAN / port forwarding no roteador).

---

## 3. Segurança em Rede Local Compartilhada (Origin + PIN/Token)

Como outros dispositivos podem compartilhar a mesma rede Wi-Fi do local da apresentação, o backend aplica duas camadas de proteção para todos os comandos de controle (`POST /api/presets/select`, `PUT /api/volume`, `POST /api/midi/connect`, `POST /api/midi/disconnect`, `POST /api/presets/config`):

1. **Validação Estrita de Origem (`Origin`)**:
   - Requisições vindas de sites externos na internet (ataques CSRF / cross-origin DNS rebinding) são bloqueadas com `403 Forbidden`. Apenas origens locais (`localhost`, `127.0.0.1` e faixas privadas RFC 1918 `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`) são aceitas.
2. **Autenticação Simples Configurável por PIN / Token (`QUICKTONE_AUTH_TOKEN`)**:
   - Ao iniciar o backend com a variável `QUICKTONE_AUTH_TOKEN=1234` (ou qualquer PIN/token escolhido pelo músico):
     - A leitura de status e presets permanece acessível, mas qualquer comando de controle exige o cabeçalho `X-QuickTone-Token: 1234` (ou `Authorization: Bearer 1234`).
     - No celular, basta tocar em **Configurações** na barra superior, digitar o PIN/Token de controle e salvar.

---

## 4. Sincronização Multi-Dispositivo em Tempo Real

- Você pode abrir a interface simultaneamente no **computador**, no **celular** (preso ao pedestal/correia) e em um **tablet**.
- Sempre que qualquer cliente seleciona um preset ou ajusta o slider de volume, ou quando a pedaleira envia uma confirmação via USB-MIDI, o servidor transmite um evento WebSocket `state_sync` para **todos os navegadores conectados** instantaneamente.
- Se o sinal Wi-Fi do celular oscilar, o cliente WebSocket entra automaticamente em estado **"Reconectando WS..."** e ressincroniza o estado completo assim que a conexão é restabelecida.
