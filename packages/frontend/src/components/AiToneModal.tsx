import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Guitar,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import {
  type AiGearConfig,
  type AiToneApplyRequest,
  type AiToneApplyResponse,
  MG300_EXPERIMENTAL_SLOT,
  MG300_USER_SLOTS,
  MG300_USER_SLOT_MAX,
  MG300_USER_SLOT_MIN,
  type Preset,
  type UpdateAiGearRequest,
  classifyPresetCategory,
  containsForbiddenSlotMention,
  isPlaceholderPreset,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';
import { QuickToneApiError } from '../api/client';
import { useFocusTrap } from '../hooks/useFocusTrap';

export interface AiToneModalProps {
  isOpen: boolean;
  presets: readonly Preset[];
  activePreset: Preset | null;
  confirmedSlotIndex: number | null;
  aiGear: AiGearConfig | null;
  midiDisabled: boolean;
  onClose: () => void;
  onSaveAiGear: (payload: UpdateAiGearRequest) => Promise<AiGearConfig>;
  onApplyAiTone: (payload: AiToneApplyRequest) => Promise<AiToneApplyResponse>;
  onOpenInEditor: (slotIndex: number) => void;
}

function resolveDefaultTargetSlot(
  activePreset: Preset | null,
  confirmedSlotIndex: number | null,
): number {
  if (
    activePreset &&
    classifyPresetCategory(activePreset) === 'user' &&
    activePreset.slotIndex >= MG300_USER_SLOT_MIN &&
    activePreset.slotIndex <= MG300_USER_SLOT_MAX
  ) {
    return activePreset.slotIndex;
  }
  if (
    confirmedSlotIndex !== null &&
    confirmedSlotIndex >= MG300_USER_SLOT_MIN &&
    confirmedSlotIndex <= MG300_USER_SLOT_MAX
  ) {
    return confirmedSlotIndex;
  }
  return MG300_EXPERIMENTAL_SLOT;
}

function getSlotOccupantName(slotIndex: number, presets: readonly Preset[]): string | null {
  const match = presets.find((p) => p.slotIndex === slotIndex && p.bankType === 'user');
  if (!match || isPlaceholderPreset(match)) {
    return null;
  }
  return match.name;
}

export const AiToneModal: React.FC<AiToneModalProps> = ({
  isOpen,
  presets,
  activePreset,
  confirmedSlotIndex,
  aiGear,
  midiDisabled,
  onClose,
  onSaveAiGear,
  onApplyAiTone,
  onOpenInEditor,
}) => {
  const [selectedSlot, setSelectedSlot] = useState<number>(() =>
    resolveDefaultTargetSlot(activePreset, confirmedSlotIndex),
  );
  const [promptText, setPromptText] = useState('');
  const [inlineGuitarModel, setInlineGuitarModel] = useState('');
  const [inlineOutputTarget, setInlineOutputTarget] = useState('');
  const [savingInlineGear, setSavingInlineGear] = useState(false);
  const [inlineGearError, setInlineGearError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [appliedResult, setAppliedResult] = useState<AiToneApplyResponse | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  // Reset modal state only on closed -> open transition; never wipe prompt/slot during open interactions.
  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!justOpened) {
      return;
    }
    setSelectedSlot(resolveDefaultTargetSlot(activePreset, confirmedSlotIndex));
    setPromptText('');
    setInlineGuitarModel('');
    setInlineOutputTarget('');
    setInlineGearError(null);
    setValidationError(null);
    setConfirmOpen(false);
    setIsSubmitting(false);
    setSubmitError(null);
    setAppliedResult(null);
  }, [isOpen, activePreset, confirmedSlotIndex]);

  const handleEscape = (): void => {
    if (isSubmitting || savingInlineGear) {
      return;
    }
    if (confirmOpen) {
      setConfirmOpen(false);
      return;
    }
    onClose();
  };

  useFocusTrap(dialogRef, isOpen, handleEscape);

  const slotOptions = useMemo(
    () =>
      MG300_USER_SLOTS.map((coord) => {
        const occupant = getSlotOccupantName(coord.slotIndex, presets);
        return {
          slotIndex: coord.slotIndex,
          displayBank: coord.displayBank,
          occupant,
          label: occupant
            ? `${coord.displayBank} · ${occupant}`
            : `${coord.displayBank} · Disponível`,
        };
      }),
    [presets],
  );

  if (!isOpen) {
    return null;
  }

  const targetCoord = slotIndexToBankCoordinate(selectedSlot);
  const targetOccupant = getSlotOccupantName(selectedSlot, presets);

  const handleSaveInlineGear = async (): Promise<void> => {
    if (savingInlineGear || isSubmitting) return;
    const trimmedGuitar = inlineGuitarModel.trim();
    if (trimmedGuitar.length < 2) {
      setInlineGearError('Informe o modelo da guitarra (mínimo 2 caracteres).');
      return;
    }
    setSavingInlineGear(true);
    setInlineGearError(null);
    setValidationError(null);
    try {
      await onSaveAiGear({
        guitarModel: trimmedGuitar,
        outputTarget: inlineOutputTarget.trim(),
      });
    } catch (err) {
      setInlineGearError(
        err instanceof QuickToneApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Falha ao validar a guitarra informada.',
      );
    } finally {
      setSavingInlineGear(false);
    }
  };

  const handleCreateClick = (): void => {
    if (isSubmitting || midiDisabled) {
      return;
    }
    setSubmitError(null);
    setValidationError(null);

    if (!aiGear) {
      setValidationError(
        'Cadastre e valide o modelo da sua guitarra no bloco acima antes de criar o timbre.',
      );
      return;
    }

    const trimmedPrompt = promptText.trim();
    if (trimmedPrompt.length < 3) {
      setValidationError('Descreva o timbre desejado (mínimo 3 caracteres).');
      return;
    }

    const forbiddenMention = containsForbiddenSlotMention(trimmedPrompt);
    if (forbiddenMention) {
      setValidationError(
        `Não mencione slots ou presets no texto ("${forbiddenMention}"). Escolha o preset alvo apenas no seletor do topo.`,
      );
      return;
    }

    setConfirmOpen(true);
  };

  const handleConfirmApply = async (): Promise<void> => {
    if (isSubmitting || midiDisabled || !aiGear) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await onApplyAiTone({
        slotIndex: selectedSlot,
        prompt: promptText.trim(),
      });
      setConfirmOpen(false);
      setAppliedResult(result);
    } catch (err) {
      setConfirmOpen(false);
      setSubmitError(
        err instanceof QuickToneApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Não foi possível gerar e gravar o timbre na pedaleira.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="ai-tone-backdrop"
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-bg-scrim p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting && !savingInlineGear) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        data-testid="ai-tone-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-tone-modal-title"
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-[var(--radius-lg)] border border-border-strong bg-bg-surface p-4 shadow-[var(--shadow-modal)] sm:p-6"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle pb-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Sparkles
              className="mt-0.5 h-4 w-4 shrink-0 text-accent"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2
                id="ai-tone-modal-title"
                className="font-sans text-base font-semibold text-text-primary sm:text-lg"
              >
                Criar timbre com IA
              </h2>
              <p className="font-mono text-[11px] text-text-muted">
                NUX MG-300 · Assistente de geração e ajuste direto na Flash
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="close-ai-tone-modal-btn"
            aria-label="Fechar assistente de timbre"
            disabled={isSubmitting || savingInlineGear}
            onClick={onClose}
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border-subtle bg-bg-elevated px-3 font-sans text-xs font-medium text-text-primary transition-colors duration-150 hover:border-border-hover disabled:opacity-40 lg:min-h-[38px] cursor-pointer"
          >
            <X className="h-4 w-4 sm:hidden" strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden sm:inline">Fechar</span>
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          {/* Seletor de slot alvo no topo */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="ai-target-slot-select"
              className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted"
            >
              Preset alvo (Slots de Usuário 1A–9D)
            </label>
            <select
              id="ai-target-slot-select"
              data-testid="ai-target-slot-select"
              value={selectedSlot}
              disabled={isSubmitting || Boolean(appliedResult)}
              onChange={(e) => {
                setSelectedSlot(Number(e.target.value));
                setConfirmOpen(false);
              }}
              className="min-h-[44px] w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-recess px-3 font-mono text-xs text-text-primary tabular-nums disabled:opacity-50"
            >
              {slotOptions.map((opt) => (
                <option
                  key={opt.slotIndex}
                  value={opt.slotIndex}
                  className="bg-bg-surface text-text-primary"
                >
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Pedaleira desconectada */}
          {midiDisabled ? (
            <div
              role="alert"
              data-testid="ai-midi-disconnected-banner"
              className="flex items-start gap-2.5 rounded-[var(--radius-md)] border border-status-warning-border bg-status-warning-bg px-3.5 py-3 text-xs text-text-primary"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className="font-sans leading-relaxed">
                Pedaleira NUX MG-300 desconectada. Conecte o cabo USB/MIDI para gerar e gravar o timbre no slot selecionado.
              </span>
            </div>
          ) : null}

          {/* Equipamento inline quando ausente vs resumo compacto quando configurado */}
          {aiGear === null ? (
            <section
              data-testid="ai-inline-gear-box"
              aria-label="Cadastro rápido de equipamento"
              className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-accent-border bg-bg-recess p-3.5"
            >
              <div className="flex items-start gap-2">
                <Guitar
                  className="mt-0.5 h-4 w-4 shrink-0 text-accent"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <div>
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-accent">
                    Equipamento obrigatório não configurado
                  </span>
                  <p className="mt-0.5 font-sans text-xs text-text-muted">
                    Informe sua guitarra abaixo para calibrar o timbre. O texto e o slot escolhidos serão preservados.
                  </p>
                </div>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSaveInlineGear();
                }}
                className="flex flex-col gap-3"
              >
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="ai-inline-gear-guitar-input"
                      className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      Modelo da guitarra *
                    </label>
                    <input
                      id="ai-inline-gear-guitar-input"
                      data-testid="ai-inline-gear-guitar-input"
                      type="text"
                      value={inlineGuitarModel}
                      onChange={(e) => {
                        setInlineGuitarModel(e.target.value);
                        if (inlineGearError) setInlineGearError(null);
                      }}
                      placeholder="Ex.: Gibson Les Paul Standard"
                      disabled={savingInlineGear}
                      className="min-h-[44px] w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-3 font-sans text-xs text-text-primary placeholder:text-text-dim disabled:opacity-50"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="ai-inline-gear-output-input"
                      className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      Saída / amplificação
                    </label>
                    <input
                      id="ai-inline-gear-output-input"
                      data-testid="ai-inline-gear-output-input"
                      type="text"
                      value={inlineOutputTarget}
                      onChange={(e) => {
                        setInlineOutputTarget(e.target.value);
                        if (inlineGearError) setInlineGearError(null);
                      }}
                      placeholder="Caixa ativa FRFR, fone de ouvido, amp..."
                      disabled={savingInlineGear}
                      className="min-h-[44px] w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-3 font-sans text-xs text-text-primary placeholder:text-text-dim disabled:opacity-50"
                    />
                  </div>
                </div>

                {inlineGearError ? (
                  <div
                    role="alert"
                    data-testid="ai-inline-gear-error"
                    className="flex items-start gap-2 rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg px-3 py-2 text-xs text-text-primary"
                  >
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0 text-status-error"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    <span className="font-sans">{inlineGearError}</span>
                  </div>
                ) : null}

                <div>
                  <button
                    type="submit"
                    data-testid="ai-inline-gear-save-btn"
                    disabled={savingInlineGear}
                    className="min-h-[44px] rounded-[var(--radius-md)] border border-accent-border bg-bg-elevated px-4 font-sans text-xs font-semibold text-accent transition-colors duration-150 hover:border-accent disabled:opacity-50 lg:min-h-[38px] cursor-pointer"
                  >
                    {savingInlineGear ? 'Validando…' : 'Validar guitarra'}
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <div
              data-testid="ai-active-gear-summary"
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess px-3.5 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Guitar className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden="true" />
                <span className="truncate font-sans text-xs font-medium text-text-primary">
                  {aiGear.guitarModel}
                  {aiGear.outputTarget ? ` · ${aiGear.outputTarget}` : ''}
                </span>
              </div>
              <span className="font-mono text-[11px] text-text-muted">
                {aiGear.pickupSummary}
              </span>
            </div>
          )}

          {/* Fluxo de prompt vs Resultado aplicado */}
          {appliedResult ? (
            <section
              data-testid="ai-applied-result"
              aria-label="Resumo do timbre aplicado"
              className={`flex flex-col gap-4 rounded-[var(--radius-md)] border bg-bg-recess p-4 ${
                appliedResult.saveResult.verified
                  ? 'border-status-confirmed-border'
                  : 'border-status-warning-border'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border-subtle pb-3">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {appliedResult.saveResult.verified ? (
                      <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-status-confirmed-border bg-status-confirmed-bg px-2 py-0.5 font-mono text-[11px] font-semibold text-status-confirmed">
                        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        {appliedResult.intent === 'create_new' ? 'Novo timbre' : 'Ajuste do preset'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-status-warning-border bg-status-warning-bg px-2 py-0.5 font-mono text-[11px] font-semibold text-status-warning">
                        <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        Verificação pendente
                      </span>
                    )}
                    <span className="font-mono text-xs font-bold text-text-primary tabular-nums">
                      {appliedResult.displayBank}
                    </span>
                    <span className="font-mono text-xs text-text-muted tabular-nums">
                      {appliedResult.bpm} BPM
                    </span>
                  </div>
                  <h3 className="font-sans text-base font-semibold text-text-primary">
                    {appliedResult.presetName}
                  </h3>
                </div>
              </div>

              {!appliedResult.saveResult.verified ? (
                <div
                  role="alert"
                  data-testid="ai-save-unverified-warning"
                  className="flex items-start gap-2 rounded-[var(--radius-md)] border border-status-warning-border bg-status-warning-bg px-3 py-2.5 text-xs text-text-primary"
                >
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="font-sans leading-relaxed">
                    A gravação na memória Flash da pedaleira não pôde ser confirmada na leitura de retorno
                    {appliedResult.saveResult.mismatchedOffsets.length > 0
                      ? ` (${appliedResult.saveResult.mismatchedOffsets.length} diferença(s) detectada(s))`
                      : !appliedResult.saveResult.ackReceived
                        ? ' (sem ACK da pedaleira)'
                        : ''}
                    . Abra no Editor para conferir e salvar novamente, se necessário.
                  </span>
                </div>
              ) : null}

              <p className="font-sans text-xs leading-relaxed text-text-primary">
                {appliedResult.summary}
              </p>

              {appliedResult.appliedBlocks.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Blocos e parâmetros aplicados
                  </span>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {appliedResult.appliedBlocks.map((block) => (
                      <div
                        key={block.blockCode}
                        className={`flex flex-col gap-1 rounded-[var(--radius-sm)] border px-3 py-2 ${
                          block.enabled
                            ? 'border-border-strong bg-bg-surface'
                            : 'border-border-subtle bg-bg-base opacity-75'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] font-bold text-accent">
                            {block.blockCode}
                          </span>
                          <span className="truncate font-sans text-xs font-medium text-text-primary">
                            {block.enabled ? block.modelName : 'Bypass'}
                          </span>
                        </div>
                        {block.enabled && block.params.length > 0 ? (
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-text-muted tabular-nums">
                            {block.params.map((p, i) => (
                              <span key={i}>
                                {p.label}: <strong className="text-text-primary">{p.value}</strong>
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {appliedResult.tips.length > 0 ? (
                <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Dicas técnicas
                  </span>
                  <ul className="flex flex-col gap-1 font-sans text-xs text-text-muted">
                    {appliedResult.tips.map((tip, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="font-mono text-accent" aria-hidden="true">
                          ·
                        </span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-3">
                <button
                  type="button"
                  data-testid="ai-close-result-btn"
                  onClick={onClose}
                  className="min-h-[44px] rounded-[var(--radius-md)] border border-border-subtle bg-bg-surface px-4 font-sans text-xs font-medium text-text-muted transition-colors duration-150 hover:border-border-hover hover:text-text-primary lg:min-h-[38px] cursor-pointer"
                >
                  Fechar
                </button>
                <button
                  type="button"
                  data-testid="ai-open-in-editor-btn"
                  onClick={() => onOpenInEditor(appliedResult.slotIndex)}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-[var(--radius-md)] border border-accent-border bg-bg-elevated px-4 font-sans text-xs font-semibold text-accent transition-colors duration-150 hover:border-accent lg:min-h-[38px] cursor-pointer"
                >
                  <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span>Abrir no Editor</span>
                </button>
              </div>
            </section>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="ai-prompt-input"
                  className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  Descreva o timbre ou ajuste desejado
                </label>
                <textarea
                  id="ai-prompt-input"
                  data-testid="ai-prompt-input"
                  rows={4}
                  value={promptText}
                  disabled={isSubmitting}
                  onChange={(e) => {
                    setPromptText(e.target.value);
                    if (validationError) setValidationError(null);
                    if (submitError) setSubmitError(null);
                  }}
                  placeholder="Ex.: Timbre crunch clássico anos 80 estilo Scorpions com delay curto e reverb de palco"
                  className="w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-recess px-3 py-2.5 font-sans text-xs leading-relaxed text-text-primary placeholder:text-text-dim disabled:opacity-50"
                />
              </div>

              {validationError ? (
                <div
                  role="alert"
                  data-testid="ai-validation-error"
                  className="flex items-start gap-2 rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg px-3 py-2.5 text-xs text-text-primary"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-status-error"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="font-sans leading-relaxed">{validationError}</span>
                </div>
              ) : null}

              {submitError ? (
                <div
                  role="alert"
                  data-testid="ai-submit-error"
                  className="flex items-start gap-2 rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg px-3 py-2.5 text-xs text-text-primary"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-status-error"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="font-sans leading-relaxed">{submitError}</span>
                </div>
              ) : null}

              {confirmOpen ? (
                <div
                  data-testid="ai-confirm-box"
                  className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-accent-border bg-bg-recess p-3.5"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-accent">
                      Confirmar gravação na Flash
                    </span>
                    <p className="font-sans text-xs leading-relaxed text-text-primary">
                      {targetOccupant ? (
                        <>
                          O slot{' '}
                          <strong className="font-mono tabular-nums">
                            {targetCoord.displayBank}
                          </strong>{' '}
                          (<strong>{targetOccupant}</strong>) será substituído pelo novo timbre,
                          com backup automático antes da gravação.
                        </>
                      ) : (
                        <>
                          O slot{' '}
                          <strong className="font-mono tabular-nums">
                            {targetCoord.displayBank}
                          </strong>{' '}
                          (Disponível) receberá o novo timbre na Flash com backup automático.
                        </>
                      )}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      data-testid="ai-confirm-cancel-btn"
                      disabled={isSubmitting}
                      onClick={() => setConfirmOpen(false)}
                      className="min-h-[44px] rounded-[var(--radius-md)] border border-border-subtle bg-bg-surface px-4 font-sans text-xs font-medium text-text-muted transition-colors duration-150 hover:border-border-hover hover:text-text-primary disabled:opacity-40 lg:min-h-[38px] cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      data-testid="ai-confirm-accept-btn"
                      disabled={isSubmitting || midiDisabled}
                      onClick={() => void handleConfirmApply()}
                      className="min-h-[44px] rounded-[var(--radius-md)] border border-accent-border bg-accent px-4 font-sans text-xs font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 lg:min-h-[38px] cursor-pointer"
                    >
                      {isSubmitting ? 'Gerando e gravando na pedaleira…' : 'Confirmar'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <button
                    type="button"
                    data-testid="ai-submit-btn"
                    disabled={isSubmitting || midiDisabled}
                    onClick={handleCreateClick}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-[var(--radius-md)] border border-accent-border bg-accent px-4 font-sans text-xs font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent-hover disabled:opacity-50 lg:min-h-[38px] cursor-pointer"
                  >
                    <Sparkles className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    <span>Criar</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
