import React, { useEffect, useRef, useState } from 'react';
import { FileUp, RotateCcw, X } from 'lucide-react';
import {
  MG300_BLOCK_CATALOG,
  MG300_EXPERIMENTAL_SLOT,
  MG300_USER_SLOTS,
  MG300_USER_SLOT_MAX,
  MG300_USER_SLOT_MIN,
  type Preset,
  getMg300BlockCatalog,
  getMg300ModelSpec,
  isPlaceholderPreset,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { ToneEditorSession } from '../hooks/useToneEditorSession';
import { ToneBlockInspector, ToneLevelsPanel } from './ToneEditorSubcomponents';

export type EditorTab = number | 'levels';

export interface ToneEditorDrawerProps {
  isOpen: boolean;
  initialTab?: EditorTab;
  session: ToneEditorSession;
  presets: readonly Preset[];
  midiDisabled: boolean;
  onClose: () => void;
}

function describeUserSlotOccupant(slotIndex: number, presets: readonly Preset[]): string | null {
  const match = presets.find((p) => p.slotIndex === slotIndex && p.bankType === 'user');
  if (!match || isPlaceholderPreset(match)) {
    return null;
  }
  return match.name;
}

function getSourceBadge(mode: 'hardware' | 'draft' | 'imported'): {
  text: string;
  className: string;
} {
  if (mode === 'draft') {
    return {
      text: 'Novo timbre (rascunho offline)',
      className: 'border-border-strong bg-bg-elevated text-text-primary',
    };
  }
  if (mode === 'imported') {
    return {
      text: 'Importado (não salvo)',
      className: 'border-status-warning-border bg-status-warning-bg text-status-warning',
    };
  }
  return {
    text: 'Ao vivo na pedaleira',
    className: 'border-status-confirmed-border bg-status-confirmed-bg text-status-confirmed',
  };
}

export const ToneEditorDrawer: React.FC<ToneEditorDrawerProps> = ({
  isOpen,
  initialTab = 3,
  session,
  presets,
  midiDisabled,
  onClose,
}) => {
  const [selectedTab, setSelectedTab] = useState<EditorTab>(initialTab);
  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const [saveTargetSlot, setSaveTargetSlot] = useState<number>(MG300_EXPERIMENTAL_SLOT);
  const [pendingAction, setPendingAction] = useState<
    | { type: 'close' }
    | { type: 'switch_slot'; slotIndex: number }
    | { type: 'reload' }
    | { type: 'import'; file: File }
    | { type: 'bundle_slot'; index: number }
    | null
  >(null);

  const drawerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const keepEditingBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedTab(initialTab);
      setSavePanelOpen(false);
      setPendingAction(null);
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (isOpen && !savePanelOpen && session.state?.slot !== undefined) {
      setSaveTargetSlot(session.state.slot);
    }
  }, [isOpen, savePanelOpen, session.state?.slot]);

  useEffect(() => {
    if (pendingAction) {
      keepEditingBtnRef.current?.focus();
    }
  }, [pendingAction]);

  const requestClose = (): void => {
    if (session.working) return;
    if (session.isDirty) {
      setPendingAction({ type: 'close' });
      return;
    }
    session.cancelPendingEdits();
    onClose();
  };

  const handleEscape = (): void => {
    if (session.working) return;
    if (pendingAction) {
      setPendingAction(null);
      return;
    }
    if (savePanelOpen) {
      session.clearError();
      setSavePanelOpen(false);
      return;
    }
    requestClose();
  };

  useFocusTrap(drawerRef, isOpen, handleEscape);

  if (!isOpen) {
    return null;
  }

  const { state, working } = session;
  const loaded = state?.loaded ?? false;
  const isHardwareMode = (state?.sourceMode ?? 'hardware') === 'hardware';
  const locked = working || (midiDisabled && isHardwareMode);
  const saveLocked = working || midiDisabled;
  const safeCurrentSlot =
    state &&
    state.slot >= MG300_USER_SLOT_MIN &&
    state.slot <= MG300_USER_SLOT_MAX
      ? state.slot
      : MG300_EXPERIMENTAL_SLOT;

  const currentCoord = slotIndexToBankCoordinate(safeCurrentSlot);
  const safeTargetSlot =
    saveTargetSlot >= MG300_USER_SLOT_MIN && saveTargetSlot <= MG300_USER_SLOT_MAX
      ? saveTargetSlot
      : safeCurrentSlot;
  const targetCoord = slotIndexToBankCoordinate(safeTargetSlot);
  const targetOccupant = describeUserSlotOccupant(safeTargetSlot, presets);
  const sourceBadge = state ? getSourceBadge(state.sourceMode) : null;

  const activeBlockMeta =
    typeof selectedTab === 'number' ? getMg300BlockCatalog(selectedTab) : undefined;
  const activeBlockKey = activeBlockMeta ? String(activeBlockMeta.id) : '';
  const activeModelId =
    activeBlockMeta !== undefined
      ? (session.localBlockModels[activeBlockKey] ?? state?.blockModels?.[activeBlockKey] ?? 0)
      : 0;
  const activeModelSpec =
    activeBlockMeta !== undefined && activeModelId > 0
      ? getMg300ModelSpec(activeBlockMeta.id, activeModelId)
      : undefined;
  const activeBlockValues =
    activeBlockMeta !== undefined
      ? (session.localBlockParams[activeBlockKey] ?? [0, 0, 0, 0, 0, 0])
      : [];
  const activeBlockEnabled = activeModelId > 0;
  const cabModelLocal = session.localBlockModels['9'] ?? state?.blockModels?.['9'] ?? 0;

  const executePendingAction = (): void => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    if (action.type === 'close') {
      void session.discardAndReset(!midiDisabled).finally(() => {
        onClose();
      });
    } else if (action.type === 'switch_slot') {
      void session.loadSlot(action.slotIndex);
    } else if (action.type === 'reload') {
      void session.loadSlot(safeCurrentSlot);
    } else if (action.type === 'import') {
      void session.importNuxPresetFile(action.file);
    } else if (action.type === 'bundle_slot') {
      void session.selectBundlePreset(action.index);
    }
  };

  return (
    <div
      data-testid="tone-editor-backdrop"
      className="fixed inset-0 z-[var(--z-drawer)] flex justify-end bg-bg-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          requestClose();
        }
      }}
    >
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tone-editor-title"
        data-testid="experimental-edit-panel"
        tabIndex={-1}
        className="flex h-full w-full flex-col border-l border-border-strong bg-bg-surface shadow-[var(--shadow-modal)] overscroll-contain lg:max-w-[560px]"
      >
        {/* Header fixo */}
        <header className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="tone-editor-title"
                className="font-sans text-base font-semibold text-text-primary sm:text-lg"
              >
                {isHardwareMode
                  ? `Editar timbre · ${currentCoord.displayBank}`
                  : 'Criar novo timbre'}
              </h2>
              {sourceBadge && loaded ? (
                <span
                  className={`rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-[11px] font-semibold ${sourceBadge.className}`}
                >
                  {sourceBadge.text}
                </span>
              ) : null}
            </div>
            <p className="font-sans text-xs text-text-muted">
              Apenas slots de Usuário (1A–9D) podem ser editados ou gravados.
            </p>
          </div>

          <button
            type="button"
            data-testid="close-tone-editor-btn"
            aria-label="Fechar editor de timbre"
            disabled={working}
            onClick={requestClose}
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border-subtle bg-bg-elevated text-text-muted transition-colors hover:border-border-hover hover:text-text-primary disabled:opacity-40 cursor-pointer"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        {/* Barra de confirmação quando há alterações pendentes */}
        {pendingAction ? (
          <div
            role="alertdialog"
            aria-label="Alterações não salvas"
            data-testid="dirty-guard-banner"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-status-warning-border bg-status-warning-bg px-4 py-3 sm:px-6"
          >
            <span className="font-sans text-xs font-medium text-text-primary">
              Você tem alterações não salvas neste timbre. Deseja descartar?
            </span>
            <div className="flex items-center gap-2">
              <button
                ref={keepEditingBtnRef}
                type="button"
                onClick={() => setPendingAction(null)}
                className="min-h-[44px] rounded-[var(--radius-sm)] border border-border-strong bg-bg-surface px-3 font-sans text-xs font-medium text-text-primary lg:min-h-[34px] cursor-pointer"
              >
                Continuar editando
              </button>
              <button
                type="button"
                data-testid="confirm-discard-dirty-btn"
                onClick={executePendingAction}
                className="min-h-[44px] rounded-[var(--radius-sm)] border border-status-error-border bg-status-error-bg px-3 font-sans text-xs font-semibold text-status-error lg:min-h-[34px] cursor-pointer"
              >
                Descartar alterações
              </button>
            </div>
          </div>
        ) : null}

        {session.message ? (
          <div className="border-b border-status-error-border bg-status-error-bg px-4 py-2.5 sm:px-6">
            <p className="font-sans text-xs text-status-error" role="alert">
              {session.message}
            </p>
          </div>
        ) : null}

        {/* Conteúdo rolável */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4">
            {/* Ações secundárias do editor */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle pb-4">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-text-muted">
                  Slot (1A–9D)
                </span>
                <select
                  data-testid="exp-load-slot-select"
                  name="user-slot-select"
                  aria-label="Trocar slot de Usuário para editar"
                  disabled={midiDisabled || working}
                  value={safeCurrentSlot}
                  onChange={(e) => {
                    const nextSlot = Number(e.target.value);
                    if (session.isDirty) {
                      setPendingAction({ type: 'switch_slot', slotIndex: nextSlot });
                      return;
                    }
                    void session.loadSlot(nextSlot);
                  }}
                  className="min-h-[44px] min-w-0 flex-1 rounded-[var(--radius-md)] border border-border-strong bg-bg-recess px-2.5 font-mono text-xs text-text-primary tabular-nums disabled:opacity-40"
                >
                  {MG300_USER_SLOTS.map((coord) => {
                    const match = describeUserSlotOccupant(coord.slotIndex, presets);
                    return (
                      <option
                        key={coord.slotIndex}
                        value={coord.slotIndex}
                        className="bg-bg-surface text-text-primary"
                      >
                        {coord.displayBank}
                        {match ? ` · ${match}` : ' · Disponível'}
                      </option>
                    );
                  })}
                </select>
              </label>

              <input
                ref={fileInputRef}
                data-testid="exp-import-input"
                type="file"
                accept=".nuxpreset"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  if (session.isDirty) {
                    setPendingAction({ type: 'import', file });
                    return;
                  }
                  void session.importNuxPresetFile(file);
                }}
              />
              <button
                type="button"
                data-testid="exp-import-btn"
                disabled={working}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess px-3 font-sans text-xs font-medium text-text-primary transition-colors hover:border-border-hover disabled:opacity-40 cursor-pointer"
              >
                <FileUp className="h-3.5 w-3.5 text-text-muted" strokeWidth={1.75} aria-hidden="true" />
                <span>Importar (.nuxpreset)</span>
              </button>

              {loaded && isHardwareMode && session.isDirty ? (
                <button
                  type="button"
                  data-testid="exp-reload-slot-btn"
                  disabled={midiDisabled || working}
                  onClick={() => setPendingAction({ type: 'reload' })}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess px-3 font-sans text-xs font-medium text-text-muted transition-colors hover:border-border-hover hover:text-text-primary disabled:opacity-40 cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  <span>Descartar e recarregar</span>
                </button>
              ) : null}
            </div>

            {loaded && !isHardwareMode ? (
              <div
                data-testid="offline-draft-notice"
                className="rounded-[var(--radius-md)] border border-status-info-border bg-status-info-bg px-3.5 py-2.5 font-sans text-xs text-text-primary"
              >
                Rascunho offline — as alterações só passam a soar na pedaleira após clicar em{' '}
                <strong>Salvar na pedaleira</strong>.
              </div>
            ) : null}

            {!loaded ? (
              <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-6 text-center font-sans text-xs text-text-muted">
                {working
                  ? 'Carregando parâmetros da pedaleira…'
                  : 'Selecione um slot de Usuário (1A–9D) ou importe um arquivo .nuxpreset para editar.'}
              </div>
            ) : (
              <>
                {session.bundleInfo && session.bundleInfo.slots.length > 1 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-3">
                    <span className="font-mono text-xs text-text-muted">
                      Pacote {session.bundleInfo.fileName} ({session.bundleInfo.slots.length} timbres):
                    </span>
                    <select
                      data-testid="exp-bundle-slot-select"
                      name="bundle-slot-select"
                      aria-label="Selecionar timbre do pacote importado"
                      disabled={working}
                      value={session.bundleInfo.selectedIndex}
                      onChange={(e) => {
                        const nextIndex = Number(e.target.value);
                        if (session.bundleItemDirty) {
                          setPendingAction({ type: 'bundle_slot', index: nextIndex });
                          return;
                        }
                        void session.selectBundlePreset(nextIndex);
                      }}
                      className="min-h-[44px] max-w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-2.5 font-mono text-xs text-text-primary"
                    >
                      {session.bundleInfo.slots.map((entry) => (
                        <option
                          key={entry.index}
                          value={entry.index}
                          className="bg-bg-surface text-text-primary"
                        >
                          {entry.displayBank} · {entry.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {/* Metadados */}
                <div className="grid grid-cols-1 gap-3 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-3.5 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                  <label className="flex flex-col gap-1">
                    <span className="flex items-center justify-between font-mono text-[11px] uppercase tracking-wide text-text-muted">
                      <span>Nome do timbre</span>
                      <span className="tabular-nums text-text-dim">{session.localName.length}/18</span>
                    </span>
                    <input
                      data-testid="exp-preset-name-input"
                      name="preset-name"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={18}
                      disabled={locked}
                      value={session.localName}
                      onChange={(e) =>
                        session.handleMetaChange(
                          e.target.value,
                          session.localBpm,
                          session.localTimeFlag,
                        )
                      }
                      onBlur={() => session.flushMetaQuietly()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        }
                      }}
                      placeholder="Ex.: Solo Clean…"
                      className="min-h-[44px] rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-3 font-mono text-xs text-text-primary placeholder:text-text-dim"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">
                      BPM
                    </span>
                    <input
                      data-testid="exp-bpm-input"
                      name="preset-bpm"
                      type="number"
                      inputMode="numeric"
                      min={40}
                      max={240}
                      disabled={locked}
                      value={session.localBpmText}
                      onChange={(e) => session.handleBpmInputChange(e.target.value)}
                      onBlur={session.handleBpmBlur}
                      className="min-h-[44px] w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-3 font-mono text-xs text-text-primary tabular-nums sm:w-24"
                    />
                  </label>

                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">
                      Delay
                    </span>
                    <button
                      type="button"
                      data-testid="exp-time-flag-btn"
                      aria-pressed={session.localTimeFlag === 1}
                      disabled={locked}
                      onClick={() => {
                        const nextFlag = session.localTimeFlag === 1 ? 0 : 1;
                        session.handleMetaChange(session.localName, session.localBpm, nextFlag);
                      }}
                      className={`min-h-[44px] rounded-[var(--radius-md)] border px-3 font-mono text-xs font-semibold transition-colors duration-150 cursor-pointer ${
                        session.localTimeFlag === 1
                          ? 'border-accent-border bg-accent-soft text-accent'
                          : 'border-border-strong bg-bg-surface text-text-muted hover:text-text-primary'
                      }`}
                    >
                      {session.localTimeFlag === 1 ? 'Sync BPM' : 'Manual (ms)'}
                    </button>
                  </div>
                </div>

                {state?.userIrWarning ? (
                  <div
                    data-testid="exp-user-ir-warning"
                    className="rounded-[var(--radius-md)] border border-status-warning-border bg-status-warning-bg px-3 py-2 font-sans text-xs text-status-warning"
                    role="note"
                  >
                    {state.userIrWarning}
                  </div>
                ) : null}

                {/* Abas dos 10 blocos + Níveis */}
                <div
                  role="group"
                  aria-label="Blocos do timbre"
                  className="grid grid-cols-4 gap-1.5 sm:grid-cols-6"
                >
                  {MG300_BLOCK_CATALOG.map((block) => {
                    const modelId =
                      session.localBlockModels[String(block.id)] ??
                      state?.blockModels?.[String(block.id)] ??
                      0;
                    const isOn = modelId > 0;
                    const isSelected = selectedTab === block.id;
                    return (
                      <button
                        key={block.id}
                        type="button"
                        translate="no"
                        data-testid={`exp-select-block-${block.code}`}
                        aria-pressed={isSelected}
                        disabled={locked}
                        onClick={() => setSelectedTab(block.id)}
                        className={`flex min-h-[46px] flex-col items-center justify-center rounded-[var(--radius-sm)] border px-1.5 py-1 font-mono text-[11px] font-semibold transition-colors duration-150 disabled:opacity-40 cursor-pointer ${
                          isSelected
                            ? 'border-accent-border bg-accent-soft text-text-primary'
                            : 'border-border-subtle bg-bg-recess text-text-muted hover:border-border-hover hover:text-text-primary'
                        }`}
                      >
                        <span>{block.code}</span>
                        <span
                          aria-hidden="true"
                          className={`mt-1 h-1 w-4 rounded-full ${
                            isOn ? 'bg-status-confirmed' : 'bg-border-strong'
                          }`}
                        />
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    data-testid="exp-select-levels"
                    aria-pressed={selectedTab === 'levels'}
                    disabled={locked}
                    onClick={() => setSelectedTab('levels')}
                    className={`flex min-h-[46px] flex-col items-center justify-center rounded-[var(--radius-sm)] border px-1.5 py-1 font-mono text-[11px] font-semibold transition-colors duration-150 disabled:opacity-40 cursor-pointer ${
                      selectedTab === 'levels'
                        ? 'border-accent-border bg-accent-soft text-text-primary'
                        : 'border-border-subtle bg-bg-recess text-text-muted hover:border-border-hover hover:text-text-primary'
                    }`}
                  >
                    <span>NÍVEIS</span>
                    <span className="font-mono text-[11px] text-text-muted tabular-nums">
                      {session.localPatchVol}%
                    </span>
                  </button>
                </div>

                {activeBlockMeta ? (
                  <ToneBlockInspector
                    block={activeBlockMeta}
                    modelId={activeModelId}
                    modelSpec={activeModelSpec}
                    values={activeBlockValues}
                    cabEnabled={cabModelLocal > 0}
                    irVolume={session.localIrVol}
                    irCut={session.localIrCut}
                    disabled={locked}
                    onToggleBlock={() =>
                      session.toggleBlock(activeBlockMeta.id, activeBlockEnabled)
                    }
                    onChangeModel={(nextModel) =>
                      session.changeBlockModel(activeBlockMeta.id, nextModel)
                    }
                    onChangeParam={(paramIndex, value) =>
                      session.handleBlockParam(activeBlockMeta.id, paramIndex, value)
                    }
                    onChangeLevel={(target, value) => session.handleLevelChange(target, value)}
                    onDragStart={session.handleDragStart}
                    onDragEnd={session.handleDragEnd}
                  />
                ) : (
                  <ToneLevelsPanel
                    patchVolume={session.localPatchVol}
                    disabled={locked}
                    onChangePatchVolume={(v) => session.handleLevelChange('patchVolume', v)}
                    onJumpToCab={() => setSelectedTab(9)}
                    onDragStart={session.handleDragStart}
                    onDragEnd={session.handleDragEnd}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Rodapé fixo com etapa inline de Salvar na pedaleira */}
        {loaded ? (
          <footer className="border-t border-border-subtle bg-bg-recess px-4 py-3.5 sm:px-6">
            {state?.lastSave && !savePanelOpen ? (
              <p className="mb-2.5 font-mono text-[11px] text-text-muted tabular-nums" role="status">
                {state.lastSave.verified
                  ? `Último salvamento em ${state.lastSave.displayBank}: salvo e confirmado.`
                  : state.lastSave.ackReceived
                    ? `Salvo em ${state.lastSave.displayBank} (alguns ajustes divergiram na verificação).`
                    : `Falha ao confirmar salvamento em ${state.lastSave.displayBank}.`}
              </p>
            ) : null}

            {savePanelOpen ? (
              <div
                data-testid="inline-save-panel"
                className="flex flex-col gap-3"
              >
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="save-target-slot-select"
                    className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                  >
                    Slot escolhido (Usuário 1A–9D)
                  </label>
                  <select
                    id="save-target-slot-select"
                    data-testid="save-target-slot-select"
                    name="save-target-slot"
                    value={safeTargetSlot}
                    disabled={working}
                    onChange={(e) => {
                      session.clearError();
                      setSaveTargetSlot(Number(e.target.value));
                    }}
                    className="min-h-[44px] w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-3 font-mono text-xs text-text-primary tabular-nums"
                  >
                    {MG300_USER_SLOTS.map((coord) => {
                      const current = describeUserSlotOccupant(coord.slotIndex, presets);
                      return (
                        <option
                          key={coord.slotIndex}
                          value={coord.slotIndex}
                          className="bg-bg-surface text-text-primary"
                        >
                          {coord.displayBank} — {current ?? 'Slot disponível'}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <p className="font-sans text-xs text-text-muted">
                  {targetOccupant ? (
                    <>
                      Substituirá <strong className="text-text-primary">{targetOccupant}</strong> em{' '}
                      <strong className="text-accent">{targetCoord.displayBank}</strong> (backup automático salvo antes).
                    </>
                  ) : (
                    <>
                      Salvará em <strong className="text-accent">{targetCoord.displayBank}</strong> após backup automático.
                    </>
                  )}
                </p>

                {state?.hasUserIr ? (
                  <p
                    data-testid="save-modal-user-ir-warning"
                    className="rounded-[var(--radius-sm)] border border-status-warning-border bg-status-warning-bg px-3 py-2 font-sans text-xs text-status-warning"
                  >
                    {state.userIrName
                      ? `User IR "${state.userIrName}" selecionado: o áudio IR depende do arquivo gravado neste slot.`
                      : 'User IR customizado selecionado: o áudio IR depende do arquivo gravado neste slot.'}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => {
                      session.clearError();
                      setSavePanelOpen(false);
                    }}
                    className="min-h-[44px] rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-4 font-sans text-xs font-medium text-text-muted hover:text-text-primary disabled:opacity-40 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    data-testid="exp-confirm-save-btn"
                    disabled={saveLocked}
                    onClick={() => {
                      void session.confirmSave(safeTargetSlot).then((ok) => {
                        if (ok) {
                          setSavePanelOpen(false);
                        }
                      });
                    }}
                    className="min-h-[44px] rounded-[var(--radius-md)] bg-accent px-4 font-sans text-xs font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40 cursor-pointer"
                  >
                    {working
                      ? 'Salvando…'
                      : targetOccupant
                        ? `Substituir ${targetCoord.displayBank}`
                        : `Salvar em ${targetCoord.displayBank}`}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-sans text-xs text-text-muted">
                  {session.isDirty
                    ? 'Alterações pendentes — salve em um slot 1A–9D.'
                    : isHardwareMode
                      ? `Sincronizado com o slot ${currentCoord.displayBank}.`
                      : 'Salve em um slot 1A–9D para gravar na pedaleira.'}
                </span>

                <button
                  type="button"
                  data-testid="exp-save-btn"
                  disabled={saveLocked}
                  onClick={() => {
                    session.flushMetaQuietly();
                    session.clearError();
                    setSaveTargetSlot(safeCurrentSlot);
                    setSavePanelOpen(true);
                  }}
                  className="min-h-[44px] rounded-[var(--radius-md)] bg-accent px-4 font-sans text-xs font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40 cursor-pointer"
                >
                  Salvar na pedaleira
                </button>
              </div>
            )}
          </footer>
        ) : null}
      </aside>
    </div>
  );
};
