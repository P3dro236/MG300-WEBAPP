# Guia de Acesso pelo Celular via Wi-Fi Local e QR Code — QuickTone Web Controller

O **QuickTone Web Controller** permite que um celular na mesma rede Wi-Fi local controle a **NUX MG-300** com segurança, utilizando pareamento obrigatório por QR Code e autorização explícita no computador.

---

## 1. Como Parear o Celular (Obrigatório)

Por segurança, abrir apenas o endereço IP no navegador do celular **não** libera acesso à pedaleira. O fluxo obrigatório é:

1. **Conecte o computador e o celular à mesma rede Wi-Fi local**.
2. **Inicie o controlador no computador**:
   ```bash
   npm run build
   npm start
   ```
   Abra `http://localhost:3001` no navegador do computador.
3. **Gere o QR Code temporário**:
   - Clique em **Ajustes** na barra superior e toque em **Gerar QR Code**.
   - O QR Code gerado é de **uso único** e expira automaticamente em **2 minutos**.
4. **Escaneie no celular**:
   - Aponte a câmera do celular para o QR Code na tela do computador e abra o link exibido.
   - O celular exibirá um código numérico de verificação de **6 dígitos**.
5. **Autorize no computador**:
   - Um alerta aparecerá no topo da tela do computador exibindo o nome do dispositivo, o IP local e o código de 6 dígitos.
   - Confira se o código coincide e clique em **Autorizar Celular**.

---

## 2. Regras de Sessão e Controle Único

- **Um celular controlador por vez**: se um segundo celular for autorizado no computador, o celular anterior tem sua sessão imediatamente revogada (rotas HTTP bloqueadas e WebSocket encerrado).
- **Dispositivos Confiáveis**: ao autorizar um celular via QR Code, ele pode ser lembrado como dispositivo confiável (armazenado via cookie `HttpOnly` com hash SHA-256 no servidor) para reconectar em sessões futuras sem precisar escanear um novo QR Code. Você pode gerenciar ou remover qualquer dispositivo confiável em **Ajustes → Dispositivos Confiáveis** no computador.
- **Expiração e revogação manual**: sessões expiram automaticamente após inatividade ou tempo máximo de sessão e podem ser revogadas a qualquer momento em **Ajustes → Revogar Acesso** no computador (ou **Encerrar Sessão neste Celular** no próprio aparelho).
- **Sem tokens permanentes em URLs ou logs**: o QR Code contém apenas o desafio temporário de uso único (removido da barra de endereços logo após o carregamento); a sessão autenticada utiliza cookie `HttpOnly; SameSite=Strict`.
- **Proteção contra força bruta**: tentativas repetidas com códigos inválidos sofrem bloqueio temporário por taxa (`429 Too Many Requests`).

---

## 3. Proteção de Rede Local e Firewall

- O backend aceita conexões apenas de endereços privados da rede local (`localhost`, `127.0.0.1`, `10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`, link-local) e valida estritamente os cabeçalhos **`Host`** e **`Origin`** em requisições HTTP e upgrades WebSocket para bloquear ataques de **DNS rebinding** e **CSRF**.
- Caso o celular não consiga abrir a página pela rede Wi-Fi, verifique no Windows se a rede Wi-Fi está configurada como **Rede Privada** e permita a porta TCP `3001` apenas para a rede privada no Firewall do Windows.
