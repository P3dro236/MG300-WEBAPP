import React, { useEffect, useMemo, useRef, useState } from 'react';
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
    if (!activePresetId) {
      return;
    }
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
      <div className="rounded-md border border-white/[0.08] bg-[#14161A] p-6 text-center font-mono text-xs text-[#8E95A2]">
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
      <div className="flex items-center justify-between gap-2 rounded border border-white/[0.08] bg-[#090A0C] p-1.5">
        <button
          type="button"
          data-testid="stage-bank-prev-btn"
          aria-label="Banco anterior"
          onClick={goPrev}
          className="inline-flex min-h-[44px] min-w-[56px] items-center justify-center rounded border border-white/10 bg-[#1B1E24] px-3 font-mono text-sm font-semibold text-[#F3F4F6] transition-colors duration-150 hover:border-white/25"
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div className="flex flex-col items-center">
          <span
            data-testid="stage-bank-label"
            className="font-mono text-sm font-bold tracking-wider text-[#F3F4F6] tabular-nums"
          >
            {currentBank.label.toUpperCase()} ({currentBank.key}A–{currentBank.key}D)
          </span>
          <span className="font-mono text-[10px] text-[#8E95A2] tabular-nums">
            {currentIdx + 1} / {banks.length}
          </span>
        </div>

        <button
          type="button"
          data-testid="stage-bank-next-btn"
          aria-label="Próximo banco"
          onClick={goNext}
          className="inline-flex min-h-[44px] min-w-[56px] items-center justify-center rounded border border-white/10 bg-[#1B1E24] px-3 font-mono text-sm font-semibold text-[#F3F4F6] transition-colors duration-150 hover:border-white/25"
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

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
