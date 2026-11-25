# Relatório de Limitações Conhecidas e Estado de Validação de Hardware

Este documento registra com transparência as limitações técnicas da **NUX MG-300 (`NUX NME-300`, firmware V4.02.23)** e o escopo da validação física e automatizada.

---

## 1. Status da Validação com a Pedaleira Real (`NUX MG-300`)

Validação read-only executada com uma **NUX MG-300 real (`NUX NME-300`)** conectada via USB ao Windows (`winmm.dll`):
- **Leitura completa dos 36 slots de usuário (`1A..9D`) via SysEx (`0x07 → 0x06`)**:
  - Slot `3C` (índice `10`) capturado e decodificado corretamente como **`"Metallica Kirk H."`** (`17` caracteres em `+0x45..+0x55`, byte `+0x57 = 16` preservado).
  - Identificados `15` presets personalizados (`1A..4C`) e `21` cópias de fábrica não editadas (`4D..9D`, como `VT Dist lead`, `RG J. Mayer` até `EmotiveBallad`), corretamente classificadas como **Fábrica** e deduplicadas contra `F1A..F9D`.
- **Troca de Presets (`CC 0x3C`) e Master Volume (`CC 0x40`)**: validados em hardware real e em testes automatizados com `MockMidiAdapter`.

---

## 2. Limitações Conhecidas e Testes Dependentes de Hardware/Rede Física

1. **Acesso Exclusivo à Porta USB-MIDI no Windows (`winmm.dll`)**:
   - Apenas um processo por vez pode abrir a porta `"NUX NME-300"`. Feche o NUX QuickTone ou DAWs antes de conectar.
2. **User IRs customizados em `.nuxpreset` importados (`CAB === 100`)**:
   - A gravação via SysEx `0x0E` grava os 102 bytes de parâmetros, cadeia de efeitos, nome e BPM no STM32. O envio do arquivo de áudio WAV do User IR (protocolo separado `0x50/0x58` no chip NXP) não é feito nesta etapa; a interface exibe aviso explícito ao importar/gravar presets que usam User IR.
3. **Testes que exigem hardware ou rede física para validação manual final**:
   - Validação prática no hardware físico da gravação `0x0E` em múltiplos slots de Usuário (`1A–9D`), troca ao vivo de modelos (`CC 1..10`) e persistência após desligar/religar (o fluxo completo foi validado em testes automatizados com simulador `FakePedalAdapter`).
   - Teste manual de câmera do celular físico na mesma rede Wi-Fi escaneando o QR Code gerado na tela do computador e confirmando o controle ao vivo (a lógica completa de pareamento, cookie `HttpOnly`, bloqueio de não autorizados, limite de 1 celular, dispositivos confiáveis e revogação foi validada em testes automatizados no backend e frontend).
   - Teste manual prolongado de arrasto contínuo do slider de Master Volume com a pedaleira física conectada para confirmar visualmente ausência total de piscagem em tela real.
   - Teste de reconexão física desconectando e reconectando o cabo USB-MIDI com o servidor em execução.
