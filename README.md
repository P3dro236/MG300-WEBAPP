# NUX MG-300 Web Controller

Controle a sua pedaleira **NUX MG-300** pelo celular, tablet ou navegador do computador usando a rede Wi-Fi local.

---

## O problema que este projeto resolve

Quem usa a NUX MG-300 em ensaios, apresentações ao vivo ou estudos em casa conhece uma limitação prática: o software oficial **NUX QuickTone** exige que você esteja sentado na frente do computador, e a pedaleira no chão nem sempre fica em uma posição confortável para leitura rápida ou ajustes finos de volume entre uma música e outra.

O **NUX MG-300 Web Controller** transforma o computador conectado à pedaleira em uma ponte sem fio para a sua rede local. Com ele, você pode prender o celular no pedestal do microfone ou deixar um tablet na estante e controlar a pedaleira à distância, direto pelo navegador, sem precisar instalar nenhum aplicativo no celular.

---

## Como funciona na prática

1. **A pedaleira fica conectada via USB ao computador** (notebook ou PC de apoio no palco, estúdio ou quarto).
2. **O controlador roda no computador** e conversa diretamente com a MG-300 e com os seus arquivos de presets do QuickTone.
3. **Qualquer dispositivo no mesmo Wi-Fi acessa o painel** pelo navegador (basta ler o QR Code exibido na tela ou digitar o endereço local).
4. **Tudo acontece em tempo real**: se você trocar de timbre no celular, pisar no footswitch físico da pedaleira ou mexer na tela do computador, todos os dispositivos atualizam juntos no mesmo instante.

---

## Por que isso é útil na rotina do músico

- **Liberdade no palco e no ensaio**: troque de banco e de timbre (`1A` a `9D` do usuário e `F1A` a `F9D` de fábrica) sem precisar ir até o notebook ou se abaixar para girar botões no chão.
- **Confirmação real da pedaleira**: o painel mostra claramente a diferença entre um comando que acabou de ser enviado e o timbre que a pedaleira realmente confirmou estar ativo. No palco, você tem certeza absoluta de qual preset está soando.
- **Ajuste rápido de níveis**: controle o **Volume Master**, o **Volume do Preset (Patch Level)** ou a posição do **Pedal de Expressão** em uma barra pensada para toque rápido com o dedo.
- **Visão clara da cadeia de sinal**: veja de relance quais blocos estão ligados ou desligados no timbre atual (`COMP`, `EFX`, `AMP`, `IR`, `EQ`, `NR`, `MOD`, `DLY`, `RVB`), além do BPM configurado.
- **Modo Palco e Modo Grade**: alterne entre uma visualização focada em botões grandes de footswitch (`A`, `B`, `C`, `D`) para tocar ao vivo e uma grade completa para localizar qualquer timbre pelo nome.
- **Leitura segura dos seus timbres**: o sistema lê os nomes dos presets direto da memória da MG-300 conectada e também dos seus arquivos `.nuxpreset` salvos no computador, sempre em modo somente leitura para nunca alterar ou corromper seus arquivos originais.
- **Proteção por PIN em redes compartilhadas**: se estiver usando o Wi-Fi de um estúdio, igreja ou casa de show, você pode ativar um PIN simples para garantir que só o seu celular possa enviar comandos para a pedaleira.

---

## Como começar a usar

### Pré-requisitos

- **Node.js** instalado no computador (versão 20 ou superior recomendada).
- Pedaleira **NUX MG-300** conectada ao computador por um cabo Micro-USB de dados.
- O programa **NUX QuickTone** deve estar **fechado** antes de conectar pelo controlador web, pois o Windows permite que apenas um programa use a conexão USB da pedaleira por vez.

### 1. Instalar o projeto

No terminal, dentro da pasta do projeto, instale as dependências:

```bash
npm install
```

### 2. Iniciar o controlador (modo recomendado para uso normal e palco)

Compile a interface e inicie o servidor:

```bash
npm run build
npm start
```

O terminal mostrará o endereço para abrir no próprio computador e o endereço da rede Wi-Fi para abrir no celular:

- No computador: `http://localhost:3001`
- No celular ou tablet (mesmo Wi-Fi): `http://<IP-DO-SEU-COMPUTADOR>:3001`

Você também pode clicar em **Ajustes** no topo da tela do computador e apontar a câmera do celular para o **QR Code** gerado automaticamente.

### 3. Modo de desenvolvimento (para quem quiser editar a interface ou o código)

Se quiser rodar o servidor e a interface em terminais separados com atualização automática:

```bash
# Terminal 1 — Servidor e comunicação com a pedaleira
npm run dev:backend

# Terminal 2 — Interface web
npm run dev:frontend
```

---

## Dicas rápidas de uso

- **Conectar a pedaleira**: assim que abrir a página, o controlador detecta automaticamente a porta `NUX NME-300`. Se você ligar a pedaleira depois de abrir o site, clique em **Conectar** na barra superior ou em **Sincronizar** para carregar os 36 timbres salvos na memória dela.
- **Usar arquivos `.nuxpreset` do computador**: em **Ajustes**, você pode informar a pasta onde guarda seus arquivos `.nuxpreset` exportados pelo QuickTone, além de escolher se deseja exibir ou ocultar os 36 timbres de fábrica (`F1A` a `F9D`).
- **Celular não carrega a página**: verifique no Windows se o seu Wi-Fi está marcado como **Rede Privada** para que o firewall local permita a conexão entre o celular e o computador na porta `3001`.

---

## Guias adicionais

Para instruções detalhadas sobre configurações específicas, consulte a pasta `docs/`:

- [Guia de Acesso pelo Celular e Wi-Fi Local](docs/MOBILE_ACCESS_GUIDE.md)
- [Guia de Conexão USB com a NUX MG-300](docs/MIDI_CONNECTION_GUIDE.md)
- [Guia de Presets do QuickTone](docs/QUICKTONE_GUIDE.md)
- [Limitações Conhecidas](docs/KNOWN_LIMITATIONS.md)
- [Decisões Técnicas do Projeto](docs/TECHNICAL_DECISIONS.md)
