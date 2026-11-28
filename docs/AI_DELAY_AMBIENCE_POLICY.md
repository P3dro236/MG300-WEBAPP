# Política Estrutural de Controle de Delay e Ambiência — MG Control AI

## 1. Diagnóstico Original e Motivação

Na arquitetura de DSP da **NUX MG-300** (`TI TMS320C672x` + `NXP MIMXRT106x`), a cadeia de sinal tem ordem fixa em série:

```text
COMP (1) → EFX (2) → AMP (3) → EQ (4) → NR (5) → MOD (6) → DLY (7) → RVB (8) → CAB (9) + MIC (10)
```

Como `DLY` e `RVB` são **pós-`AMP` e em série**, toda a saturação harmônica e compressão do `AMP` entram no `DLY`, e cada repetição do `DLY` alimenta cumulativamente o `RVB`.

A inspeção dos presets reais gravados em `packages/backend/backups/` e dos 36 presets oficiais de fábrica da ROM STM32 revelou 6 causas raiz para o excesso de delay e ambiência:

1. **Inclusão automática de delay sem necessidade musical:** presets como `Sultans Clean` (`Tape Echo [38, 28, 35]`), `Hotel Solo` (`Tape Echo [50, 45, 40]`) e `Shine On Clean` (`Digi Delay [100, 45, 40]` + `Hall [38, 55, 40, 70]` + `Chorus`) recebiam delay excessivo por padrão. Nos 36 presets oficiais de fábrica da ROM, **20 deles deixam `DLY = OFF`**, e os patches high-gain com `Tape Echo` (`F3C`, `F7A`, `F9A`) mantêm `RVB = OFF`.
2. **Ausência de perfis por finalidade musical:** o calibrador anterior distinguia apenas pedido ambiental vs. não ambiental, sem desligar delay em riffs pesados, bases rítmicas ou pedidos genéricos.
3. **Limites numéricos idênticos para modelos distintos e falta de validação de `Time`:** `Analog Delay` (`id=1`) inverte `p1=Echo` (mix) e `p2=Intensity` (feedback) em relação aos modelos `2..6` (`p1=F.Back`, `p2=Level/Mix`), e `Time` (`0x36`) não tinha validação alguma (aceitando `Time=100` em clean/lead ou tempos longos em slapback).
4. **Avaliação isolada de `DLY` e `RVB`:** não havia orçamento conjunto considerando `DLY + RVB + MOD + ganho`.
5. **Defaults perigosos do catálogo/template:** `getMg300ModelDefaultParams` preenche sliders omitidos com `50` (`[50, 50, 50]`), gerando repetições e mix elevados caso a IA omita parâmetros.
6. **Correções silenciosas sem observabilidade:** não havia registro do que a IA propôs vs. o que foi aplicado nem do motivo de inclusão/exclusão do delay.

---

## 2. Arquitetura em 5 Camadas

| Camada | Arquivo | Responsabilidade |
| :--- | :--- | :--- |
| **1. IA (`Gemini`)** | `packages/backend/src/ai/ai-tone-service.ts` | Interpreta a solicitação, classifica finalidade musical (`mp`) e sugere perfil (`dp`), retornando payload estritamente numérico. |
| **2. Política de Efeitos** | `packages/backend/src/ai/ambience-policy.ts` | Resolve deterministicamente a finalidade musical (`AiMusicalPurpose`), o perfil de delay (`NONE`, `RHYTHM`, `LEAD`, `AMBIENT`, `SLAPBACK`), se o delay é permitido e o orçamento conjunto (`AMBIENCE_BUDGET_RULES`). Impede que a IA burle a política. |
| **3. Compilador** | `packages/backend/src/ai/tone-calibrator.ts` | Compila blocos não-ambiência primeiro para detectar `gainStage` e `MOD`, e aplica defaults seguros (`getSafeAmbienceDefaultParams`) caso a IA omita parâmetros de `DLY`/`RVB`. |
| **4. Validador** | `packages/backend/src/ai/ambience-validator.ts` | Valida bloco único de delay, compatibilidade de modelo por perfil, `timeFlag` e `Time`, `Mix`, `Feedback`, `Mod`, densidade de repetições, `RVB` (respeitando `Room Tone`) e o orçamento conjunto `DLY + RVB + MOD + gainStage`. Registra todas as correções. |
| **5. Serializador & Observabilidade** | `packages/shared/src/mg300-experimental.ts` + `packages/backend/src/ai/tone-observability.ts` | Sanitiza os 102 bytes (`sanitizeStruct102ForSysEx`) para o formato `0x0E` da MG-300 e grava telemetria estruturada sem vazar segredos/API keys. |

---

## 3. Perfis de Utilização de Delay

- **`NONE`:** sem delay (`DLY = 0`). Padrão obrigatório para som limpo seco, som limpo com chorus + reverb, pedidos explícitos *"sem delay"* e solicitações genéricas sem referência musical a delay.
- **`RHYTHM`:** prioriza definição, ataque e clareza rítmica. Em riffs pesados (Metallica, thrash/metal) e bases rítmicas, o delay permanece **desligado por padrão** (`delayAllowed = false`), sendo liberado apenas se o músico mencionar explicitamente delay (com teto discreto: `Mix 8..16`, `Feedback 6..16`).
- **`SLAPBACK`:** repetição única curta para rockabilly/country (`timeFlag` forçado para `0`, `Time 8..24`, `Feedback 0..12`, `Mix 18..34`). Modelos `Modulate(3)`, `Reverse(5)` e `Pan(6)` são bloqueados/remapeados para `Tape Echo(4)`.
- **`LEAD`:** repetição perceptível sem competir com a nota principal. Subdividido conforme `gainStage` e finalidade:
  - `LEAD_HIGH_GAIN`: solos high-gain (Metallica solo, Slash, Gary Moore) — limites mais rígidos (`Feedback <= 20..22`, `Mix <= 22..24`).
  - `LEAD_STANDARD`: solos clean/crunch.
  - `LEAD_MELODIC`: solos melódicos onde o delay é parte da assinatura (ex.: *Pink Floyd — Comfortably Numb / Gilmour*), permitindo `Time 36..64`, `F.Back 16..34`, `Mix 14..30` sem embolar o reverb.
- **`AMBIENT`:** ativado apenas quando há pedido explícito de textura atmosférica/espacial (*ambient, shoegaze, post-rock, cathedral, shimmer, the edge, delay longo*). Libera `Reverse(5)` e `Pan(6)` e amplia tetos de tempo, feedback e mix com proteção contra auto-oscilação.

---

## 4. Regras de Validação e Controle Conjunto

Todas as faixas abaixo usam exclusivamente as unidades nativas `0..100` do catálogo real (`packages/shared/src/mg300-catalog.ts`):

1. **Layouts por modelo (`DELAY_MODEL_LAYOUTS`):**
   - `1 = Analog Delay`: `p0=Time`, `p1=Echo (mix)`, `p2=Intensity (feedback)`.
   - `2 = Digi Delay`, `4 = Tape Echo`: `p0=Time`, `p1=F.Back`, `p2=Level`.
   - `3 = Modulate`: `p0=Time`, `p1=F.Back`, `p2=Level`, `p3=Mod` (limitado em `<= 15..30` fora de `AMBIENT`).
   - `5 = Reverse`, `6 = Pan`: `p0=Time`, `p1=F.Back`, `p2=Mix`.
2. **Densidade de repetições (`excessive_repeats`):** com `timeFlag = 0`, calcula `repeatIndex = Time * 0.35 + Feedback * 0.65` e reduz `Feedback` caso exceda `maxRepeatIndex` do modelo/perfil.
3. **Reverb (`RVB`):** usa `getSpecParamOffset` para respeitar `Room` (`p0=Mix`, `p1=Tone` preservado, `p2=Decay`) e `Hall` (`Pre.D >= 15..20`, `Liveliness <= 35..45` fora de `AMBIENT`).
4. **Orçamento conjunto (`excessive_combined_ambience`):**
   - `effectiveJointWetMax = budget.jointWetMax - (modEnabled ? budget.modStackPenalty : 0)`
   - Se `dlyMix + rvbMix > effectiveJointWetMax`, reduz primeiro `RVB Mix` (preservando a clareza do delay solicitado) e, se necessário, ajusta `DLY Mix`.
   - Em `high_gain + MOD + DLY + RVB` fora de `AMBIENT`, limita também `RVB Decay <= 38`.

---

## 5. Observabilidade e Diagnóstico

Cada chamada a `POST /api/ai/tone/apply` retorna `diagnostics` (`AiToneAmbienceDiagnostics`) e grava um evento `[ai-tone]` no `MidiDiagnosticsLogger` (com sanitização de chaves `AIza...` / `GEMINI_API_KEY`) contendo:
- `originalPrompt`, `musicalPurpose`, `delayProfile`, `aiSuggestedProfile`
- `delayDecision` (`included` | `excluded` | `preserved`) e `delayDecisionReason`
- `selectedDelayModel`
- `aiProposedAmbience` vs. `finalAmbience` (com `jointAmbienceScore`)
- `corrections[]` (com `block`, `param`, `proposed`, `applied`, `rule`, `reason`) e `warnings[]`

Isso permite identificar imediatamente se um problema veio da interpretação da IA (`aiProposedAmbience` / `aiSuggestedProfile`) ou de uma regra do compilador/validador (`corrections`).

---

## 6. Como Calibrar os Perfis

Para ajustar limites sonoros sem alterar código de validação ou protocolo:
1. **Ajustar faixas de um modelo de Delay em um perfil:** edite `DELAY_MODEL_PROFILE_LIMITS` em `packages/backend/src/ai/ambience-policy.ts` (`[min, max, default]` + `maxRepeatIndex`).
2. **Ajustar orçamento de Reverb e soma `DLY + RVB + MOD`:** edite `AMBIENCE_BUDGET_RULES` em `packages/backend/src/ai/ambience-policy.ts`.
3. **Ajustar critérios de classificação do pedido:** edite os padrões e prioridades de `resolveAmbiencePolicy` em `packages/backend/src/ai/ambience-policy.ts`.
4. **Validar:** execute `npx vitest run --configLoader native packages/backend/src/__tests__/delay-ambience-policy.test.ts` após qualquer ajuste.
