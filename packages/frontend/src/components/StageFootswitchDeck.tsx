import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type {
  ConfirmedDeviceState,
  Preset,
  SentCommandRecord,
} from '@quicktone/shared';
import { PresetCard, resolvePresetStatus } from './PresetCard';
import { getPresetBankKey, groupPresetsByBank } from '../utils/preset-groups';

interface StageFootswitchDeckProps {
  presets: Preset[];
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  disabled: boolean;
  onSelectPreset: (preset: Preset) => void;
}

export const StageFootswitchDeck: React.FC<StageFootswitchDeckProps> = ({
  presets,
  confirmedState,
  lastSentCommand,
  disabled,
  onSelectPreset,
}) => {
  const banks = useMemo(() => groupPresetsByBank(presets), [presets]);

  const activePresetId =
    lastSentCommand?.type === 'preset_select' && !lastSentCommand.confirmedByDevice
      ? lastSentCommand.presetId
      : confirmedState.presetId;

  const [selectedBankKey, setSelectedBankKey] = useState<string>(() => {
    const matched = presets.find((p) => p.id === activePresetId);
    if (matched) return getPresetBankKey(matched);
    return banks[0]?.key ?? '1';
  });

  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  useEffect(() => {
    if (!activePresetId) return;
    const matched = presetsRef.current.find((p) => p.id === activePresetId);
    if (matched) {
      setSelectedBankKey(getPresetBankKey(matched));
    }
  }, [activePresetId]);

  const currentIdx = useMemo(() => {
    const found = banks.findIndex((b) => b.key === selectedBankKey);
    return found >= 0 ? found : 0;
  }, [banks, selectedBankKey]);

  const currentBank = banks[currentIdx];

  if (!currentBank) {
    return (
      <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-6 text-center font-mono text-xs text-text-muted">
        Nenhum banco disponível no filtro atual.
      </div>
    );
  }

  const goPrev = (): void => {
    if (banks.length === 0) return;
    const prevIdx = (currentIdx - 1 + banks.length) % banks.length;
    setSelectedBankKey(banks[prevIdx]!.key);
  };

  const goNext = (): void => {
    if (banks.length === 0) return;
    const nextIdx = (currentIdx + 1) % banks.length;
    setSelectedBankKey(banks[nextIdx]!.key);
  };

  return (
    <div data-testid="stage-footswitch-deck" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-1.5">
        <button
          type="button"
          data-testid="stage-bank-prev-btn"
          aria-label="Banco anterior"
          onClick={goPrev}
          className="inline-flex min-h-[44px] min-w-[52px] items-center justify-center rounded-[var(--radius-sm)] border border-border-strong bg-bg-elevated px-3 text-text-primary transition-colors duration-150 hover:border-border-hover cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </button>

        <div className="flex flex-col items-center">
          <span
            data-testid="stage-bank-label"
            className="font-mono text-sm font-bold tracking-wider text-text-primary tabular-nums"
          >
            {currentBank.label.toUpperCase()} ({currentBank.key}A–{currentBank.key}D)
          </span>
          <span className="font-mono text-[11px] text-text-muted tabular-nums">
            {currentIdx + 1} / {banks.length}
          </span>
        </div>

        <button
          type="button"
          data-testid="stage-bank-next-btn"
          aria-label="Próximo banco"
          onClick={goNext}
          className="inline-flex min-h-[44px] min-w-[52px] items-center justify-center rounded-[var(--radius-sm)] border border-border-strong bg-bg-elevated px-3 text-text-primary transition-colors duration-150 hover:border-border-hover cursor-pointer"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {banks.length > 1 ? (
        <div
          role="group"
          aria-label="Salto rápido de banco"
          className="flex flex-wrap items-center justify-center gap-1.5"
        >
          {banks.map((bank) => {
            const isCurrent = bank.key === currentBank.key;
            return (
              <button
                key={bank.key}
                type="button"
                data-testid={`stage-bank-jump-${bank.key}`}
                aria-pressed={isCurrent}
                onClick={() => setSelectedBankKey(bank.key)}
                className={`min-h-[44px] min-w-[44px] rounded-[var(--radius-sm)] border px-2 font-mono text-xs font-semibold tabular-nums transition-colors duration-150 lg:min-h-[34px] lg:min-w-[36px] cursor-pointer ${
                  isCurrent
                    ? 'border-accent-border bg-accent-soft text-accent'
                    : 'border-border-subtle bg-bg-recess text-text-muted hover:border-border-hover hover:text-text-primary'
                }`}
              >
                {bank.key}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {currentBank.items.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            status={resolvePresetStatus(preset, confirmedState, lastSentCommand)}
            disabled={disabled}
            variant="stage-footswitch"
            onSelect={onSelectPreset}
          />
        ))}
      </div>
    </div>
  );
};
