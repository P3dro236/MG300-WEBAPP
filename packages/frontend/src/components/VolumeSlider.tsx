import React from 'react';
import type {
  ConfirmedDeviceState,
  DeviceSyncStatus,
  SentCommandRecord,
  VolumeTarget,
} from '@quicktone/shared';

interface VolumeSliderProps {
  volume: number;
  volumeTarget: VolumeTarget;
  syncStatus: DeviceSyncStatus;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  disabled: boolean;
  onChangeVolume: (volume: number) => void;
  onSelectTarget: (target: VolumeTarget) => void;
}

const TARGET_OPTIONS: ReadonlyArray<{
  id: VolumeTarget;
  shortLabel: string;
  title: string;
  ariaLabel: string;
}> = [
  {
    id: 'master_cc64',
    shortLabel: 'Master (CC 64)',
    title: 'Volume Master (CC 64)',
    ariaLabel: 'Volume Master',
  },
  {
    id: 'patch_cc74',
    shortLabel: 'Patch Level (CC 74)',
    title: 'Nível do Patch P.LVL (CC 74)',
    ariaLabel: 'Patch Level',
  },
  {
    id: 'expression_cc61',
    shortLabel: 'Expressão (CC 61)',
    title: 'Pedal de Expressão (CC 61)',
    ariaLabel: 'Pedal de Expressão',
  },
];

export const VolumeSlider: React.FC<VolumeSliderProps> = ({
  volume,
  volumeTarget,
  syncStatus: _syncStatus,
  confirmedState,
  lastSentCommand,
  disabled,
  onChangeVolume,
  onSelectTarget,
}) => {
  const activeOption =
    TARGET_OPTIONS.find((opt) => opt.id === volumeTarget) ?? TARGET_OPTIONS[0]!;

  const isVolumeConfirmed =
    confirmedState.volume !== null && confirmedState.volumeTarget === volumeTarget;

  const hasUnconfirmedSentVolume =
    lastSentCommand?.type === 'volume_change' &&
    !lastSentCommand.confirmedByDevice &&
    lastSentCommand.volume !== undefined &&
    lastSentCommand.volumeTarget === volumeTarget;

  const clampAndSend = (next: number): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(next)));
    onChangeVolume(clamped);
  };

  return (
    <section
      data-testid="volume-control-panel"
      className="rounded-md border border-white/[0.08] bg-[#14161A] p-3.5 sm:p-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {TARGET_OPTIONS.map((opt) => {
              const selected = opt.id === volumeTarget;
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-testid={`volume-target-quick-${opt.id}`}
                  onClick={() => onSelectTarget(opt.id)}
                  className={`min-h-[34px] rounded border px-2.5 font-mono text-[11px] font-medium transition-colors duration-150 ${
                    selected
                      ? 'border-white/25 bg-[#1B1E24] text-[#F3F4F6]'
                      : 'border-white/[0.06] bg-[#090A0C] text-[#8E95A2] hover:border-white/15 hover:text-[#F3F4F6]'
                  }`}
                >
                  {opt.shortLabel}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 font-mono tabular-nums">
            {hasUnconfirmedSentVolume ? (
              <span
                data-testid="sent-volume-badge"
                className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2 py-0.5 text-[11px] text-[#F59E0B]"
              >
                Enviado: {lastSentCommand.volume}%
              </span>
            ) : null}

            {isVolumeConfirmed && confirmedState.volume !== null ? (
              <span
                data-testid="confirmed-volume-badge"
                className="rounded border border-[#22C55E]/40 bg-[#22C55E]/10 px-2 py-0.5 text-[11px] text-[#22C55E]"
              >
                Confirmado: {confirmedState.volume}%
              </span>
            ) : null}

            <span
              data-testid="volume-value"
              className="min-w-[3.2rem] text-right text-lg font-bold text-[#F3F4F6]"
            >
              {volume}%
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            data-testid="volume-decrease-btn"
            disabled={disabled}
            onClick={() => clampAndSend(volume - 5)}
            className="inline-flex min-h-[44px] min-w-[52px] shrink-0 items-center justify-center rounded border border-white/10 bg-[#1B1E24] px-3 font-mono text-sm font-semibold text-[#F3F4F6] tabular-nums transition-colors duration-150 hover:border-white/25 active:bg-[#090A0C] disabled:opacity-40"
          >
            -5
          </button>

          <div className="flex-1 px-1">
            <input
              data-testid="volume-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume}
              disabled={disabled}
              aria-label={activeOption.ariaLabel}
              onChange={(e) => clampAndSend(Number(e.target.value))}
              className="chassis-fader"
            />
          </div>

          <button
            type="button"
            data-testid="volume-increase-btn"
            disabled={disabled}
            onClick={() => clampAndSend(volume + 5)}
            className="inline-flex min-h-[44px] min-w-[52px] shrink-0 items-center justify-center rounded border border-white/10 bg-[#1B1E24] px-3 font-mono text-sm font-semibold text-[#F3F4F6] tabular-nums transition-colors duration-150 hover:border-white/25 active:bg-[#090A0C] disabled:opacity-40"
          >
            +5
          </button>
        </div>
      </div>
    </section>
  );
};
