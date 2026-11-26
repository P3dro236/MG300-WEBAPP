import React, { useEffect, useState } from 'react';
import type { SentCommandRecord } from '@quicktone/shared';

interface VolumeSliderProps {
  volume: number;
  lastSentCommand: SentCommandRecord | null;
  disabled: boolean;
  onChangeVolume: (volume: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

const VolumeSliderInner: React.FC<VolumeSliderProps> = ({
  volume,
  lastSentCommand,
  disabled,
  onChangeVolume,
  onInteractionStart,
  onInteractionEnd,
}) => {
  const [localVolume, setLocalVolume] = useState(volume);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) {
      setLocalVolume(volume);
    }
  }, [volume, isDragging]);

  const hasUnconfirmedSentVolume =
    lastSentCommand?.type === 'volume_change' &&
    !lastSentCommand.confirmedByDevice &&
    lastSentCommand.volume !== undefined &&
    (lastSentCommand.volumeTarget === undefined ||
      lastSentCommand.volumeTarget === 'master_cc64');

  const clampAndSend = (next: number): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(next)));
    setLocalVolume(clamped);
    onChangeVolume(clamped);
  };

  const trackStyle = {
    '--volume-pct': `${localVolume}%`,
  } as React.CSSProperties;

  return (
    <section
      data-testid="volume-control-panel"
      className="surface-card p-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-text-primary">
            Volume Master
          </span>

          <div className="flex items-center gap-2 font-mono tabular-nums">
            {hasUnconfirmedSentVolume ? (
              <span
                data-testid="sent-volume-badge"
                aria-live="polite"
                className="inline-flex items-center rounded-[var(--radius-sm)] border border-status-warning-border bg-status-warning-bg px-2 py-0.5 text-[11px] text-status-warning"
              >
                Enviando…
              </span>
            ) : null}

            <span
              data-testid="volume-value"
              className="text-base font-bold text-text-primary sm:text-lg"
            >
              {localVolume}%
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="volume-decrease-btn"
            aria-label="Diminuir Volume Master em 5%"
            disabled={disabled}
            onClick={() => clampAndSend(localVolume - 5)}
            className="inline-flex min-h-[44px] min-w-[52px] shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border-strong bg-bg-elevated px-3 font-mono text-sm font-semibold text-text-primary tabular-nums transition-colors duration-150 hover:border-border-hover active:bg-bg-recess disabled:opacity-40 cursor-pointer"
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
              value={localVolume}
              disabled={disabled}
              aria-label="Volume Master"
              style={trackStyle}
              onPointerDown={() => {
                setIsDragging(true);
                onInteractionStart?.();
              }}
              onPointerUp={() => {
                setIsDragging(false);
                onInteractionEnd?.();
              }}
              onPointerCancel={() => {
                setIsDragging(false);
                onInteractionEnd?.();
              }}
              onBlur={() => {
                setIsDragging(false);
                onInteractionEnd?.();
              }}
              onChange={(e) => clampAndSend(Number(e.target.value))}
              className="chassis-fader"
            />
          </div>

          <button
            type="button"
            data-testid="volume-increase-btn"
            aria-label="Aumentar Volume Master em 5%"
            disabled={disabled}
            onClick={() => clampAndSend(localVolume + 5)}
            className="inline-flex min-h-[44px] min-w-[52px] shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border-strong bg-bg-elevated px-3 font-mono text-sm font-semibold text-text-primary tabular-nums transition-colors duration-150 hover:border-border-hover active:bg-bg-recess disabled:opacity-40 cursor-pointer"
          >
            +5
          </button>
        </div>
      </div>
    </section>
  );
};

export const VolumeSlider = React.memo(VolumeSliderInner);
