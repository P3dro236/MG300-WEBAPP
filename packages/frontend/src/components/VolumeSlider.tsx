import React from 'react';
import type {
  ConfirmedDeviceState,
  SentCommandRecord,
} from '@quicktone/shared';

interface VolumeSliderProps {
  volume: number;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  disabled: boolean;
  onChangeVolume: (volume: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

const VolumeSliderInner: React.FC<VolumeSliderProps> = ({
  volume,
  confirmedState,
  lastSentCommand,
  disabled,
  onChangeVolume,
  onInteractionStart,
  onInteractionEnd,
}) => {
  const isVolumeConfirmed =
    confirmedState.volume !== null &&
    (confirmedState.volumeTarget === null || confirmedState.volumeTarget === 'master_cc64');

  const hasUnconfirmedSentVolume =
    lastSentCommand?.type === 'volume_change' &&
    !lastSentCommand.confirmedByDevice &&
    lastSentCommand.volume !== undefined &&
    (lastSentCommand.volumeTarget === undefined ||
      lastSentCommand.volumeTarget === 'master_cc64');

  const clampAndSend = (next: number): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(next)));
    onChangeVolume(clamped);
  };

  const trackStyle = {
    '--volume-pct': `${volume}%`,
  } as React.CSSProperties;

  return (
    <section
      data-testid="volume-control-panel"
      className="rounded-md border border-white/[0.08] bg-[#14161A] p-3.5 sm:p-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#F3F4F6]">
            Volume Master
          </span>

          <div className="flex min-h-[28px] items-center justify-end gap-2 font-mono tabular-nums">
            <div className="flex min-w-[104px] justify-end">
              {hasUnconfirmedSentVolume ? (
                <span
                  data-testid="sent-volume-badge"
                  className="inline-flex min-w-[104px] items-center justify-center rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-2 py-0.5 text-[11px] text-[#F59E0B]"
                >
                  Enviado: {lastSentCommand.volume}%
                </span>
              ) : null}
            </div>

            <div className="flex min-w-[120px] justify-end">
              {isVolumeConfirmed && confirmedState.volume !== null ? (
                <span
                  data-testid="confirmed-volume-badge"
                  className="inline-flex min-w-[120px] items-center justify-center rounded border border-[#22C55E]/40 bg-[#22C55E]/10 px-2 py-0.5 text-[11px] text-[#22C55E]"
                >
                  Confirmado: {confirmedState.volume}%
                </span>
              ) : null}
            </div>

            <span
              data-testid="volume-value"
              className="w-14 shrink-0 text-right text-lg font-bold text-[#F3F4F6]"
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

          <div className="min-w-0 flex-1 px-1">
            <input
              data-testid="volume-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume}
              disabled={disabled}
              aria-label="Volume Master"
              style={trackStyle}
              onPointerDown={onInteractionStart}
              onPointerUp={onInteractionEnd}
              onPointerCancel={onInteractionEnd}
              onMouseDown={onInteractionStart}
              onMouseUp={onInteractionEnd}
              onTouchStart={onInteractionStart}
              onTouchEnd={onInteractionEnd}
              onBlur={onInteractionEnd}
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

export const VolumeSlider = React.memo(VolumeSliderInner);
