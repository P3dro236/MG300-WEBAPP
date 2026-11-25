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

export const PresetCard: React.FC<PresetCardProps> = ({
  preset,
  status,
  disabled,
  variant = 'row-cell',
  onSelect,
}) => {
  const isStage = variant === 'stage-footswitch';

  const statusClasses =
    status === 'confirmed'
      ? 'border-[#22C55E] bg-[#141A16]'
      : status === 'command_sent_unconfirmed'
        ? 'border-[#F59E0B] bg-[#1B1710]'
        : 'border-white/[0.08] bg-[#1B1E24] hover:border-white/25 hover:bg-[#22262E]';

  const ledClasses =
    status === 'confirmed'
      ? 'bg-[#22C55E]'
      : status === 'command_sent_unconfirmed'
        ? 'bg-[#F59E0B]'
        : 'bg-[#2E3440]';

  return (
    <button
      type="button"
      data-testid={`preset-card-${preset.id}`}
      data-status={status}
      disabled={disabled}
      onClick={() => onSelect(preset)}
      className={`group relative flex flex-col justify-between rounded border text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F59E0B]/70 disabled:cursor-not-allowed disabled:opacity-45 active:translate-y-px ${
        isStage ? 'min-h-[96px] p-3.5 sm:min-h-[112px] sm:p-4' : 'min-h-[68px] p-2.5 sm:p-3'
      } ${statusClasses}`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span
          data-testid={`preset-bank-${preset.id}`}
          className={`font-mono font-bold tracking-tight tabular-nums ${
            isStage ? 'text-base sm:text-lg' : 'text-xs'
          } ${
            status === 'confirmed'
              ? 'text-[#22C55E]'
              : status === 'command_sent_unconfirmed'
                ? 'text-[#F59E0B]'
                : 'text-[#8E95A2]'
          }`}
        >
          {preset.displayBank}
        </span>

        <span className="flex items-center gap-1.5">
          {status === 'confirmed' ? (
            <span
              data-testid={`preset-status-confirmed-${preset.id}`}
              className="font-mono text-[10px] font-semibold tracking-wider text-[#22C55E]"
            >
              CONFIRMADO
            </span>
          ) : status === 'command_sent_unconfirmed' ? (
            <span
              data-testid={`preset-status-sent-${preset.id}`}
              className="font-mono text-[10px] font-semibold tracking-wider text-[#F59E0B]"
            >
              COMANDO ENVIADO
            </span>
          ) : null}
          <span className={`h-2 w-2 rounded-full ${ledClasses}`} />
        </span>
      </div>

      <div className="mt-1.5 flex w-full items-end justify-between gap-2">
        <span
          data-testid={`preset-name-${preset.id}`}
          className={`line-clamp-2 font-sans font-semibold leading-snug text-[#F3F4F6] ${
            isStage ? 'text-base sm:text-lg' : 'text-xs sm:text-sm'
          }`}
        >
          {preset.name}
        </span>

        {isStage ? (
          <span className="shrink-0 font-mono text-[11px] font-semibold text-[#8E95A2]">
            {preset.patchLetter}
          </span>
        ) : null}
      </div>
    </button>
  );
};
