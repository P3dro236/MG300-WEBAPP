import React from 'react';
import { Plus, SlidersHorizontal } from 'lucide-react';
import {
  type ConfirmedDeviceState,
  type DeviceSyncStatus,
  MG300_BLOCK_CATALOG,
  type Mg300BlockCode,
  type Preset,
  type SentCommandRecord,
  classifyPresetCategory,
} from '@quicktone/shared';

interface StageDisplayProps {
  activePreset: Preset | null;
  syncStatus: DeviceSyncStatus;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  liveBlockModels?: Record<string, number> | null;
  liveEditorSlot?: number | null;
  canOpenEditor?: boolean;
  onEditActiveTone?: (initialBlockId?: number) => void;
  onCreateNewTone?: () => void;
  onPreloadEditor?: () => void;
}

function isCatalogBlockActiveFromPreset(
  preset: Preset | null,
  code: Mg300BlockCode,
): boolean | null {
  const chain = preset?.signalChain;
  if (!chain) return null;
  switch (code) {
    case 'COMP':
      return Boolean(chain.compEnabled);
    case 'EFX':
      return Boolean(chain.efxEnabled);
    case 'AMP':
      return Boolean(chain.ampEnabled);
    case 'EQ':
      return Boolean(chain.eqEnabled);
    case 'NR':
      return Boolean(chain.nrEnabled);
    case 'MOD':
      return Boolean(chain.modEnabled);
    case 'DLY':
      return Boolean(chain.dlyEnabled);
    case 'RVB':
      return Boolean(chain.rvbEnabled);
    case 'CAB':
      return Boolean(chain.irEnabled);
    case 'MIC':
      return null;
    default:
      return false;
  }
}

export const StageDisplay: React.FC<StageDisplayProps> = ({
  activePreset,
  syncStatus: _syncStatus,
  confirmedState,
  lastSentCommand,
  liveBlockModels = null,
  liveEditorSlot = null,
  canOpenEditor = false,
  onEditActiveTone,
  onCreateNewTone,
  onPreloadEditor,
}) => {
  const isPending =
    lastSentCommand?.type === 'preset_select' &&
    !lastSentCommand.confirmedByDevice &&
    activePreset?.id === lastSentCommand.presetId;
  const isConfirmed =
    Boolean(confirmedState.presetId) &&
    activePreset?.id === confirmedState.presetId &&
    !isPending;

  const isUserPreset =
    activePreset !== null && classifyPresetCategory(activePreset) === 'user';

  const displayBank =
    activePreset?.displayBank ??
    confirmedState.presetId ??
    lastSentCommand?.presetId ??
    '—';

  const displayName =
    activePreset?.name ??
    (confirmedState.presetId
      ? `Slot ${confirmedState.presetId}`
      : 'Selecione um timbre');

  const categoryLabel = activePreset
    ? isUserPreset
      ? 'Usuário'
      : 'Fábrica'
    : 'Sem leitura';

  const statusTag = isConfirmed
    ? {
        label: 'Confirmado',
        cls: 'border-status-confirmed-border bg-status-confirmed-bg text-status-confirmed',
      }
    : isPending
      ? {
          label: 'Enviando…',
          cls: 'border-status-warning-border bg-status-warning-bg text-status-warning',
        }
      : {
          label: 'Aguardando pedaleira',
          cls: 'border-border-subtle bg-bg-surface text-text-muted',
        };

  const hasLiveEditorMatch =
    liveBlockModels !== null &&
    activePreset !== null &&
    liveEditorSlot !== null &&
    liveEditorSlot === activePreset.slotIndex;

  return (
    <section
      data-testid="stage-display"
      aria-label="Visor principal do timbre ativo"
      className="rounded-[var(--radius-lg)] border border-border-subtle bg-bg-recess p-4"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-3">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-text-muted">
            <span>Timbre ativo</span>
            <span className="text-border-strong" aria-hidden="true">
              /
            </span>
            <span>{categoryLabel}</span>
          </div>

          <span
            aria-live="polite"
            className={`inline-flex items-center rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-[11px] font-semibold ${statusTag.cls}`}
          >
            {statusTag.label}
          </span>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-baseline gap-3 sm:gap-4">
            <span className="shrink-0 font-mono text-3xl font-bold tracking-tight text-text-primary tabular-nums sm:text-4xl">
              {displayBank}
            </span>
            <h1 className="truncate font-sans text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">
              {displayName}
            </h1>
          </div>

          {canOpenEditor && (onEditActiveTone || onCreateNewTone) ? (
            <div className="flex flex-wrap items-center gap-2">
              {isUserPreset && onEditActiveTone ? (
                <button
                  type="button"
                  data-testid="open-tone-editor-btn"
                  onMouseEnter={onPreloadEditor}
                  onFocus={onPreloadEditor}
                  onClick={() => onEditActiveTone()}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-[var(--radius-md)] border border-border-strong bg-bg-elevated px-3.5 font-sans text-xs font-semibold text-text-primary transition-colors duration-150 hover:border-border-hover lg:min-h-[38px] cursor-pointer"
                >
                  <SlidersHorizontal className="h-4 w-4 text-accent" strokeWidth={1.75} aria-hidden="true" />
                  <span>Editar timbre</span>
                </button>
              ) : null}

              {onCreateNewTone ? (
                <button
                  type="button"
                  data-testid="create-tone-btn"
                  onMouseEnter={onPreloadEditor}
                  onFocus={onPreloadEditor}
                  onClick={onCreateNewTone}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-bg-surface px-3 font-sans text-xs font-medium text-text-muted transition-colors duration-150 hover:border-border-hover hover:text-text-primary lg:min-h-[38px] cursor-pointer"
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span>Criar novo timbre</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          data-testid="signal-chain-strip"
          aria-label="Cadeia de sinal do timbre ativo"
          className="grid grid-cols-5 gap-1.5 sm:grid-cols-10"
        >
          {MG300_BLOCK_CATALOG.map((block) => {
            const liveActive = hasLiveEditorMatch
              ? (liveBlockModels[String(block.id)] ?? 0) > 0
              : null;
            const presetActive = isCatalogBlockActiveFromPreset(activePreset, block.code);
            const resolvedActive = liveActive !== null ? liveActive : presetActive;
            const hasKnownState = resolvedActive !== null;
            const isActive = resolvedActive === true;
            const canClickBlock = canOpenEditor && isUserPreset && Boolean(onEditActiveTone);

            const chipClass = `flex min-h-[44px] lg:min-h-[36px] items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border font-mono text-[11px] font-semibold tracking-wider transition-colors duration-150 ${
              isActive
                ? 'border-status-confirmed-border bg-status-confirmed-bg text-text-primary'
                : 'border-border-subtle bg-bg-surface text-text-dim'
            }`;

            if (canClickBlock) {
              return (
                <button
                  key={block.id}
                  type="button"
                  translate="no"
                  data-block={block.code}
                  data-active={hasKnownState ? String(isActive) : 'unknown'}
                  aria-haspopup="dialog"
                  aria-label={`Editar bloco ${block.label} (${isActive ? 'ligado' : 'desligado'})`}
                  onMouseEnter={onPreloadEditor}
                  onClick={() => onEditActiveTone?.(block.id)}
                  className={`${chipClass} hover:border-border-hover cursor-pointer`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${
                      isActive ? 'bg-status-confirmed' : 'bg-text-disabled'
                    }`}
                  />
                  <span>{block.code}</span>
                </button>
              );
            }

            return (
              <div
                key={block.id}
                translate="no"
                data-block={block.code}
                data-active={hasKnownState ? String(isActive) : 'unknown'}
                className={chipClass}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    isActive ? 'bg-status-confirmed' : 'bg-text-disabled'
                  }`}
                />
                <span>{block.code}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
