import React from 'react';
import type {
  ConfirmedDeviceState,
  Preset,
  SentCommandRecord,
} from '@quicktone/shared';

export type PresetVisualStatus = 'confirmed' | 'command_sent_unconfirmed' | 'idle';

export function resolvePresetStatus(
  preset: Preset,
  confirmedState: ConfirmedDeviceState,
  lastSentCommand: SentCommandRecord | null,
): PresetVisualStatus {
  const isConfirmed =
    confirmedState.slotIndex !== null
      ? confirmedState.slotIndex === preset.slotIndex
      : confirmedState.presetId === preset.id;

  const isSentUnconfirmed =
    lastSentCommand !== null &&
    !lastSentCommand.confirmedByDevice &&
    lastSentCommand.type === 'preset_select' &&
    (lastSentCommand.slotIndex === preset.slotIndex ||
      lastSentCommand.presetId === preset.id);

  if (isSentUnconfirmed) return 'command_sent_unconfirmed';
  if (isConfirmed) return 'confirmed';
  return 'idle';
}

interface PresetCardProps {
  preset: Preset;
  status: PresetVisualStatus;
  disabled: boolean;
  variant?: 'row-cell' | 'stage-footswitch';
  onSelect: (preset: Preset) => void;
}

const PresetCardInner: React.FC<PresetCardProps> = ({
  preset,
  status,
  disabled,
  variant = 'row-cell',
  onSelect,
}) => {
  const isStage = variant === 'stage-footswitch';

  const statusClasses =
    status === 'confirmed'
      ? 'border-status-confirmed bg-status-confirmed-bg'
      : status === 'command_sent_unconfirmed'
        ? 'border-status-warning bg-status-warning-bg'
        : 'border-border-subtle bg-bg-elevated hover:border-border-hover';

  const ledClasses =
    status === 'confirmed'
      ? 'bg-status-confirmed'
      : status === 'command_sent_unconfirmed'
        ? 'bg-status-warning'
        : 'bg-text-disabled';

  return (
    <button
      type="button"
      data-testid={`preset-card-${preset.id}`}
      data-status={status}
      aria-label={`Carregar timbre ${preset.displayBank} — ${preset.name}`}
      disabled={disabled}
      onClick={() => onSelect(preset)}
      className={`group relative flex flex-col justify-between rounded-[var(--radius-md)] border text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 active:translate-y-px cursor-pointer ${
        isStage ? 'min-h-[96px] p-4 sm:min-h-[108px]' : 'min-h-[68px] p-3'
      } ${statusClasses}`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span
          data-testid={`preset-bank-${preset.id}`}
          className={`font-mono font-bold tracking-tight tabular-nums ${
            isStage ? 'text-base sm:text-lg' : 'text-xs'
          } ${
            status === 'confirmed'
              ? 'text-status-confirmed'
              : status === 'command_sent_unconfirmed'
                ? 'text-status-warning'
                : 'text-text-muted'
          }`}
        >
          {preset.displayBank}
        </span>

        <span className="flex items-center gap-1.5">
          {status === 'confirmed' ? (
            <span
              data-testid={`preset-status-confirmed-${preset.id}`}
              className="font-mono text-[11px] font-semibold tracking-wider text-status-confirmed"
            >
              Ativo
            </span>
          ) : status === 'command_sent_unconfirmed' ? (
            <span
              data-testid={`preset-status-sent-${preset.id}`}
              className="font-mono text-[11px] font-semibold tracking-wider text-status-warning"
            >
              Enviando…
            </span>
          ) : null}
          <span className={`h-2 w-2 rounded-full ${ledClasses}`} aria-hidden="true" />
        </span>
      </div>

      <div className="mt-1.5 flex w-full items-end justify-between gap-2">
        <span
          data-testid={`preset-name-${preset.id}`}
          className={`line-clamp-2 font-sans font-semibold leading-snug text-text-primary ${
            isStage ? 'text-base sm:text-lg' : 'text-xs sm:text-sm'
          }`}
        >
          {preset.name}
        </span>

        {isStage ? (
          <span className="shrink-0 font-mono text-[11px] font-semibold text-text-muted">
            {preset.patchLetter}
          </span>
        ) : null}
      </div>
    </button>
  );
};

export const PresetCard = React.memo(PresetCardInner);
