# Ações imediatas de Pedro
Checklist priorizado. Segredos nunca devem ser enviados em chat, prompt, issue ou arquivo versionado.

| Prioridade | O que fazer | Onde | Entregar aos agentes | Impacto se atrasar |
|---|---|---|---|---|
| P0 | Garantir repo local, branch limpa e commit registrado | PC/Agy/Git | Caminho, branch, commit; acesso local | Bloqueia S01 |
| P0 | Identificar repo do site e projeto Vercel | GitHub/Vercel | Nome/caminho do repo, projeto e permissões | Bloqueia S10 |
| P0 | Manter MG-300 disponível | Setup físico | Firmware, cabo e janela de teste | Bloqueia S04/S09/S11 |
| P1 | Confirmar projeto Google AI Studio/API de produção e model ID | Google AI Studio/Cloud | Nome do projeto, model ID, nome da variável; chave em secret manager | Bloqueia custo/produção S06 |
| P1 | Separar credenciais Gemini dev e produção | Secret manager/env | Nomes dos ambientes e política de rotação | Mistura uso pessoal e SaaS |
| P1 | Validar Stripe Brasil: cartão, Pix, moedas, taxas e liquidação | Stripe Dashboard/suporte | Evidência de elegibilidade; nunca senha | Bloqueia S08 |
| P1 | Preparar Mercado Pago se Stripe Pix indisponível | Mercado Pago Developers | App e credenciais sandbox/prod em secrets | Bloqueia Pix |
| P1 | Definir e-mail de suporte/remetente | Domínio/provedor transacional | Endereço, domínio e acesso DNS | Bloqueia verificação/recuperação |
| P2 | Comprar domínio próprio após cotar renovação | Registrador | Domínio e acesso DNS; não senha | Portal/site ficam em domínio temporário |
| P2 | Cotar Code Signing Windows | CA reconhecida | Preço anual, validação, formato e CI | SmartScreen pode alertar |
| P2 | Definir dados legais/controlador e contato LGPD | Orientação jurídica/contábil | Identificação e contato para termos/política | Bloqueia lançamento comercial |
| P3 | Reservar handles sociais | YouTube/Instagram/TikTok | URLs/nomes | Não bloqueia engenharia |

## Não fazer agora
Não contratar VPS antes de S01/S02 e cotação; não comprar certificado/domínio sem comparar renovação; não ativar cobrança real antes de sandbox, webhook, refund e conciliação; não contratar analytics geral; não colocar segredos em `.env` versionado.

## Ordem sem desperdício
1. Repo + MG-300 destravam S01–S04.
2. Projeto/modelo Gemini e credencial separada destravam medição S06.
3. Stripe/Pix e fallback Mercado Pago destravam S08.
4. Domínio + e-mail transacional destravam portal/site.
5. Code Signing pode aguardar o build de teste S09.
