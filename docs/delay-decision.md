# Decisão Técnica e Relatório Completo — Controle Estrutural de Delay e Ambiência (MG Control AI)

**Data:** 2026-11-27  
**Branch:** `feat/ai-tone-assistant`  
**Escopo:** Arquitetura, política, compilação, validação determinística, observabilidade, testes e revisão independente do controle de Delay (`DLY`) e Ambiência (`RVB` + `MOD`) na geração de timbres para a pedaleira **NUX MG-300**.

---

## 1. Contexto e Diagnóstico Original

### 1.1 Fluxo Completo Analisado
1. **Rota HTTP:** `POST /api/ai/tone/apply` em `packages/backend/src/app.ts` delega para `AiToneService.applyTone` em `packages/backend/src/ai/ai-tone-service.ts`.
2. **Camada Gemini:** `AiToneService` envia `TONE_SYSTEM_INSTRUCTION`, `TONE_RESPONSE_SCHEMA` e o `userPrompt` compacto para `GeminiClient.generateJson` (`packages/backend/src/ai/gemini-client.ts`).
3. **Normalização:** `RawAiToneResponseSchema` e `toNormalizedPlan` validam e normalizam o JSON estritamente numérico em `AiTonePlan`.
4. **Compilação e Calibração:** `buildAndCalibrateStruct102` (`packages/backend/src/ai/tone-calibrator.ts`) converte o plano em `struct102` (`102` bytes) usando o catálogo oficial `MG300_BLOCK_CATALOG` (`packages/shared/src/mg300-catalog.ts`).
5. **Serialização e Gravação Flash:** `sanitizeStruct102ForSysEx` (`packages/shared/src/mg300-experimental.ts`) garante segurança 7-bit e `ExperimentalEditService.applyExternalTransform` (`packages/backend/src/experimental-edit.ts`) executa backup + SysEx `0x0E` + readback `0x07 -> 0x06`.

### 1.2 Causas Raiz Identificadas (Comprovadas em Backups Reais e ROM da MG-300)
Na NUX MG-300 (`TI TMS320C672x` + `NXP MIMXRT106x`), a cadeia de áudio é fixa e em série:

```text
COMP (1) -> EFX (2) -> AMP (3) -> EQ (4) -> NR (5) -> MOD (6) -> DLY (7) -> RVB (8) -> CAB (9) + MIC (10)
```

Todo ganho do `EFX`/`AMP` alimenta diretamente `DLY`, e cada repetição de `DLY` alimenta cumulativamente `RVB`. A inspeção de backups reais gravados em `packages/backend/backups/` e dos **36 presets oficiais de fábrica da ROM STM32** (`stream_0x03_cortexm_0x08008000.bin`) revelou 6 causas raiz:

1. **Delay adicionado sem necessidade musical:** em backups reais da pedaleira, presets como `Sultans Clean` receberam `Tape Echo [38, 28, 35]`, `Hotel Solo` recebeu `Tape Echo [50, 45, 40]` e `Shine On Clean` recebeu `Digi Delay [Time=100, F.Back=45, Level=40]` + `Hall [38, 55, 40, 70]` + `Chorus` — obrigando o músico a desligar o delay manualmente (`DLY: OFF` nos backups seguintes). Nos **36 presets oficiais de fábrica**, **20 mantêm `DLY: OFF`**, e patches high-gain de fábrica com `Tape Echo` (`F3C TMWAKA LEAD`, `F7A RLDamageRect`, `F9A JL VH4 Crunch`) deixam `RVB: OFF`.
2. **Ausência de perfis por finalidade musical:** havia apenas uma detecção binária (`isAmbientOrHeavyAmbienceRequest`), incapaz de desligar delay em riffs pesados, clean seco, clean com chorus+reverb ou solicitações genéricas, chegando inclusive a subir valores baixos até o piso `12`/`10`.
3. **Limites iguais entre modelos distintos + falta de validação de `Time`:** `DLY 2..6` usavam os mesmos tetos e `Time` (`0x36`) não era validado (aceitando `Time=100` em clean/lead ou tempos longos em slapback), além da armadilha do `Analog Delay` (`id=1`), que inverte `p1=Echo` (mix) e `p2=Intensity` (feedback) em relação aos modelos `2..6` (`p1=F.Back`, `p2=Level/Mix`).
4. **Avaliação isolada de `DLY` e `RVB`:** não existia controle de orçamento conjunto para `DLY + RVB + MOD + ganho`.
5. **Defaults elevados quando a IA omitia parâmetros:** `getMg300ModelDefaultParams` em `mg300-catalog.ts` inicializa sliders com `50` (`[50, 50, 50]`), e `createBlankMg300Struct102` inicializa `DLY` com `[50, 35, 35]` e `RVB` com `[35, 50, 50]`.
6. **Correções silenciosas e ausência de observabilidade:** não havia registro do que a IA propôs versus o que foi gravado na pedaleira nem do motivo de inclusão/exclusão do delay.

---

## 2. Trabalho Executado e Separação de Responsabilidades

> **Escopo respeitado:** Nenhuma alteração foi feita no firmware, na camada USB-MIDI (`packages/midi-service`) ou no protocolo SysEx (`buildMg300PresetWriteSysEx`).

### 2.1 Continuação do Plano Mestre Anterior (Onda 3)
Antes da tarefa estrutural de Delay e Ambiência, foi concluída a **Onda 3** do plano mestre em `data/plans/plano-mestre-orquestracao.md` na branch `feat/ai-tone-assistant`:
- Auditoria independente em 2 rodadas sobre `mg300-experimental.ts`, `experimental-edit.ts`, `env.ts`, `gemini-client.ts`, `tone-calibrator.ts`, `ai-tone-service.ts` e suítes de testes.
- Correções de contrato (`RawAiToneResponseSchema` aceitando `.nullish()` e números finitos, documentação explícita de `intent` e faixas no prompt), tratamento de partes `thought: true`, bump de `maxOutputTokens` em fallback sem thinking, remoção do falso positivo `'TOKEN'` em `isQuotaErrorSignal`, guarda `NODE_ENV === 'test'`, skip imediato em `401`/`403` no `:generateContent`, e arrays parciais em `AMP 2/26/8/9/23`.
- Criação de 3 commits locais atômicos (`e237e0a`, `4ccaf27`, `56120ef`), sem `git push`.

### 2.2 Nova Arquitetura em 5 Camadas (Delay e Ambiência)

| Camada | Arquivo | Responsabilidade |
| :--- | :--- | :--- |
| **1. Contratos Compartilhados** | `packages/shared/src/contracts.ts` | Define `AiDelayProfileSchema`, `AiMusicalPurposeSchema`, `AiGainStageSchema`, `AiAmbienceRuleCodeSchema`, `AiAmbienceCorrectionSchema`, `AiToneAmbienceDiagnosticsSchema` e o campo opcional `diagnostics` em `AiToneApplyResponseSchema`. |
| **2. IA (`Gemini`)** | `packages/backend/src/ai/ai-tone-service.ts` | Interpreta o pedido e retorna JSON numérico incluindo `mp` (finalidade musical) e `dp` (perfil de delay sugerido), instruído a não incluir `DLY(7)` quando desnecessário. |
| **3. Política Centralizada** | `packages/backend/src/ai/ambience-policy.ts` *(novo)* | Resolve deterministicamente `musicalPurpose`, `delayProfile`, `delayAllowed` e orçamento `AMBIENCE_BUDGET_RULES` com base no pedido real e `gainStage`, impedindo que a IA burle a política. |
| **4. Compilador** | `packages/backend/src/ai/tone-calibrator.ts` | Compila blocos não-ambiência (`COMP..MOD, CAB, MIC`) antes de `DLY`/`RVB` para identificar `gainStage` e `MOD`, injeta defaults seguros (`getSafeAmbienceDefaultParams`) e registra `aiProposedAmbience`. |
| **5. Validador Determinístico** | `packages/backend/src/ai/ambience-validator.ts` *(novo)* | Aplica regra de bloco único, remove delay injustificado, valida compatibilidade de modelo/perfil, `timeFlag`/`Time`, `Mix`/`Feedback`/`Mod`, `repeatIndex`, `RVB` e controle conjunto `DLY + RVB + MOD + gainStage`. |
| **6. Serializador & Observabilidade** | `packages/shared/src/mg300-experimental.ts`, `packages/backend/src/ai/tone-observability.ts` *(novo)*, `packages/backend/src/app.ts` | Sanitiza `struct102` (`sanitizeStruct102ForSysEx`) e registra telemetria completa via `AiToneObservabilityRecorder` (com redação automática de segredos/API keys) no retorno da API e no `MidiDiagnosticsLogger`. |

---

## 3. Regras Implementadas (Baseadas Exclusivamente nos Dados Reais da MG-300)

Todas as faixas operam exclusivamente sobre os parâmetros e intervalos reais `0..100` definidos em `packages/shared/src/mg300-catalog.ts`.

### 3.1 Perfis de Utilização (`AiDelayProfile`)
1. **`NONE`:** sem delay (`DLY = 0`). Padrão obrigatório para som limpo seco (`clean_dry`), som limpo com modulação e reverb (`clean_modulated`), pedidos explícitos *"sem delay"* (sem confundir a contração portuguesa `"no delay"`/`"no eco"`, ex.: *"Ajustar feedback no delay"*, com a negação inglesa `"with no delay"`) e pedidos genéricos sem referência a delay.
2. **`RHYTHM`:** prioriza definição e ataque (`heavy_rhythm` e `rhythm`). Em riffs pesados (Metallica, thrash/metal) e bases rítmicas, o delay permanece **desligado por padrão** (`delayAllowed = false`), sendo liberado apenas se explicitamente solicitado no prompt (`Mix 8..16`, `Feedback 6..16`).
3. **`SLAPBACK`:** repetição curta para rockabilly/country (`timeFlag` forçado para `0`, `Time 8..24`, `Feedback 0..12`, `Mix 18..34`). Modelos incompatíveis (`Modulate`, `Reverse`, `Pan`) são convertidos para `Tape Echo (4)`.
4. **`LEAD`:** repetição perceptível sem competir com a nota principal, subdividida em:
   - `LEAD_HIGH_GAIN` (ex.: solos de Metallica, Slash, Gary Moore): tetos rígidos (`Feedback <= 20..22`, `Mix <= 20..24`).
   - `LEAD_STANDARD`: solos clean/crunch.
   - `LEAD_MELODIC` (ex.: *Pink Floyd — Comfortably Numb / Gilmour*): `Time 34..64`, `Feedback 14..34`, `Mix 14..30`.
5. **`AMBIENT`:** ativado exclusivamente por solicitação explícita de textura atmosférica/espacial ou delay longo (*ambient, shoegaze, post-rock, cathedral, shimmer, the edge*). Libera `Reverse (5)` e `Pan (6)` e amplia faixas de tempo/feedback/mix. Um pedido de *"mais reverb"* isolado em riff pesado **não** ativa `AMBIENT` no delay.

### 3.2 Layouts e Limites Específicos por Modelo (`DELAY_MODEL_LAYOUTS`)
- **`1 = Analog Delay`:** `p0=Time`, **`p1=Echo` (Mix)**, **`p2=Intensity` (Feedback)** — layout invertido respeitado em leitura, escrita, defaults e remapeamento.
- **`2 = Digi Delay` e `4 = Tape Echo`:** `p0=Time`, `p1=F.Back`, `p2=Level`.
- **`3 = Modulate`:** `p0=Time`, `p1=F.Back`, `p2=Level`, `p3=Mod` (limitado em `<= 15..30` fora de `AMBIENT`, e `<= 55` em `AMBIENT`).
- **`5 = Reverse` e `6 = Pan`:** `p0=Time`, `p1=F.Back`, `p2=Mix` (`Reverse` restrito a `AMBIENT` salvo pedido explícito de `"reverse"`/`"reverso"`; `Pan` restrito a `LEAD` e `AMBIENT`).

### 3.3 Validações Estruturais e Controle Conjunto
- **Bloco único (`multiple_delay_blocks`):** consolida e registra diretivas duplicadas (ex.: `'7'` + `'DLY'` ou `'DLY2'`).
- **Densidade de repetições (`excessive_repeats`):** calcula `repeatIndex = Time * 0.35 + Feedback * 0.65` e reduz `Feedback` quando excede `maxRepeatIndex` do modelo/perfil.
- **Reverb (`RVB`):** usa `getSpecParamOffset` para preservar `Tone` (`0x3e`) em `Room (1)`, impor `Pre.D >= 15..20` e limitar `Liveliness` em `Hall (2)`.
- **Orçamento conjunto (`excessive_combined_ambience`):** `effectiveJointWetMax = budget.jointWetMax - (modEnabled ? budget.modStackPenalty : 0)`. Quando `dlyMix + rvbMix > effectiveJointWetMax`, reduz primeiro `RVB Mix` (para não matar o ataque/definição do delay) e depois `DLY Mix` se necessário; em `high_gain + MOD + DLY + RVB` fora de `AMBIENT`, limita também `RVB Decay <= 38`.
- **Preservação em `edit_existing`:** edições que não alteram `DLY`/`RVB` preservam os valores pré-existentes; solicitações explícitas de aumento de delay em `edit_existing` passam pelo validador completo (`modelo`, `timeFlag`, `Time`, `Mod <= 55`, `repeatIndex`) com teto seguro `<= 65`. Além disso, a IA não pode usar `mp`/`dp` para injetar `AMBIENT` ou um novo `DLY` em edições genéricas sem menção a delay.

---

## 4. Observabilidade e Segurança (`tone-observability.ts`)

Cada geração em `POST /api/ai/tone/apply` retorna `diagnostics` (`AiToneAmbienceDiagnostics`) e grava um registro estruturado `[ai-tone]` no `MidiDiagnosticsLogger` contendo:
- `originalPrompt` (sanitizado)
- `musicalPurpose`
- `delayProfile` e `aiSuggestedProfile`
- `delayDecision` (`included` | `excluded` | `preserved`) e `delayDecisionReason`
- `selectedDelayModel` (`id`, `name`)
- `aiProposedAmbience` vs. `finalAmbience` (com `jointAmbienceScore`)
- `corrections[]` (`block`, `param`, `proposed`, `applied`, `rule`, `reason`) e `warnings[]`

`redactSensitiveTokens` mascara automaticamente padrões `AIza...`, tokens `Bearer ...` e os valores configurados em `process.env.GEMINI_API_KEY` / `GEMINI_API_KEY_2` antes de gravar em memória ou disco.

---

## 5. Revisão Independente (`code-review` via `refactoring-auditor`)

- **Rodada 1 (`REPROVADO`):** identificou `2` achados `ALTO` (falso positivo da contração PT `"no delay"`/`"no eco"` em `EXPLICIT_NO_DELAY_PATTERNS`; possibilidade de a IA sugerir `mp: 'ambient'`/`dp: 'AMBIENT'` em `edit_existing` sem pedido de delay), `2` achados `MÉDIO` (`explicitAmbienceIncrease` pulando validações de `Time`/`Mod` e `"mais reverb"` ativando `AMBIENT` no delay; função `validateAndEnforceAmbience` longa) e `3` achados `BAIXO`, além de 3 lacunas de testes.
- **Correções aplicadas:** separação de `explicitDelayIncrease` vs. `explicitReverbIncrease`, restrição contextual da negação inglesa `no delay`, fechamento do bypass em `edit_existing`, execução completa do pipeline de validação em aumentos explícitos de delay, refatoração de `ambience-validator.ts` em helpers coesos (`enforceDelayModelCompatibility`, `enforceActiveDelayLimits`, `enforceDelayPolicyAndLimits`, `enforceReverbLimits`, `enforceJointAmbienceBudget`), ajustes pontuais (`app.ts`, `ambience-policy.ts`) e adição dos testes adversariais correspondentes.
- **Rodada 2 (`APROVADO`):** **`0` CRÍTICO, `0` ALTO, `0` MÉDIO, `0` BAIXO** — todos os achados e lacunas confirmados como resolvidos.

---

## 6. Validações e Bateria de Testes Executada

Todos os comandos abaixo foram executados após a última edição no diretório `C:\Users\pedro\Desktop\mg\NUXMG300-WEBAPP`:

| Validação | Resultado | Escopo |
| :--- | :--- | :--- |
| `npm run typecheck` | **PASSOU** | Todos os 5 workspaces (`shared`, `reader`, `midi`, `backend`, `frontend`). |
| `npm run build` | **PASSOU** | Build completo dos pacotes e bundle de produção Vite. |
| `npx vitest run --configLoader native` | **PASSOU** | **12 arquivos / 141 testes**, incluindo os **10 cenários obrigatórios** em `packages/backend/src/__tests__/delay-ambience-policy.test.ts`:<br>1. Metallica — riffs pesados (`RHYTHM`, `DLY OFF`)<br>2. Metallica — solos (`LEAD high_gain`)<br>3. Pink Floyd — solos melódicos com delay (`LEAD melodic_lead`)<br>4. Pink Floyd — ambiência atmosférica (`AMBIENT`)<br>5. Rock clássico — solo com repetição moderada (`LEAD`)<br>6. Slapback para rockabilly (`SLAPBACK`, `timeFlag=0`)<br>7. Som limpo sem delay (`NONE`, `DLY OFF`)<br>8. Som limpo com chorus e reverb (`NONE`, `DLY OFF`, `MOD`+`RVB` controlados)<br>9. Timbre ambient com delay e reverb (`AMBIENT`)<br>10. Solicitação genérica sem referência a delay (`NONE`, `DLY OFF`)<br>+ Compatibilidade binária `struct102` (102 bytes), `sanitizeStruct102ForSysEx`, `buildMg300PresetWriteSysEx`, `isExperimentalPresetWriteSysEx`, `buildPresetFromStruct102`, testes adversariais e redação de segredos. |
| `npx playwright test` | **PASSOU** | **4 testes E2E** em `chromium-mobile`. |

---

## 7. Documentos e Guias Relacionados

- Política operacional e guia de calibração de perfis: `docs/AI_DELAY_AMBIENCE_POLICY.md`
- Registro arquitetural (`ADR-006`): `docs/TECHNICAL_DECISIONS.md`
