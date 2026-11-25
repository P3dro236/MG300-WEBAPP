import React from 'react';
import {
  type ConfirmedDeviceState,
  type DeviceSyncStatus,
  type Preset,
  type SentCommandRecord,
  classifyPresetCategory,
} from '@quicktone/shared';

interface StageDisplayProps {
  activePreset: Preset | null;
  syncStatus: DeviceSyncStatus;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
}

const SIGNAL_CHAIN_NODES: ReadonlyArray<{
  key: keyof NonNullable<Preset['signalChain']>;
  label: string;
}> = [
  { key: 'compEnabled', label: 'COMP' },
  { key: 'efxEnabled', label: 'EFX' },
  { key: 'ampEnabled', label: 'AMP' },
  { key: 'irEnabled', label: 'IR' },
  { key: 'eqEnabled', label: 'EQ' },
  { key: 'nrEnabled', label: 'NR' },
  { key: 'modEnabled', label: 'MOD' },
  { key: 'dlyEnabled', label: 'DLY' },
  { key: 'rvbEnabled', label: 'RVB' },
];

export const StageDisplay: React.FC<StageDisplayProps> = ({
  activePreset,
  syncStatus,
  confirmedState,
  lastSentCommand,
}) => {
  const isConfirmed =
    Boolean(confirmedState.presetId) &&
    activePreset?.id === confirmedState.presetId &&
    syncStatus === 'confirmed';
  const isPending =
    lastSentCommand?.type === 'preset_select' &&
    !lastSentCommand.confirmedByDevice &&
    activePreset?.id === lastSentCommand.presetId;

  const displayBank =
    activePreset?.displayBank ??
    confirmedState.presetId ??
    lastSentCommand?.presetId ??
    '--';

  const displayName =
    activePreset?.name ??
    (confirmedState.presetId
      ? `Slot ${confirmedState.presetId}`
      : 'Selecione um preset');

  const categoryLabel = activePreset
    ? classifyPresetCategory(activePreset) === 'factory'
      ? 'FÁBRICA'
      : 'USUÁRIO'
    : 'SEM LEITURA';

  const statusTag = isConfirmed
    ? {
        label: 'CONFIRMADO HARDWARE',
        cls: 'border-[#22C55E]/40 bg-[#22C55E]/10 text-[#22C55E]',
      }
    : isPending
      ? {
          label: 'COMANDO ENVIADO',
          cls: 'border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]',
        }
      : {
          label: 'AGUARDANDO SINAL',
          cls: 'border-white/10 bg-[#14161A] text-[#8E95A2]',
        };

  return (
    <section
      data-testid="stage-display"
      aria-label="Visor principal do preset ativo"
      className="rounded-md border border-white/[0.08] bg-[#090A0C] p-3.5 sm:p-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-2.5">
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-[#8E95A2]">
            <span>PRESET ATIVO</span>
            <span className="text-white/20">/</span>
            <span>{categoryLabel}</span>
          </div>

          <span
            className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${statusTag.cls}`}
          >
            {statusTag.label}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-4">
          <div className="flex min-w-0 items-baseline gap-3 sm:gap-4">
            <span className="shrink-0 font-mono text-3xl font-bold tracking-tight text-[#F3F4F6] tabular-nums sm:text-4xl">
              {displayBank}
            </span>
            <h1 className="truncate font-sans text-xl font-semibold tracking-tight text-[#F3F4F6] sm:text-2xl">
              {displayName}
            </h1>
          </div>
        </div>

        <div
          data-testid="signal-chain-strip"
          aria-label="Cadeia de sinal do preset (somente leitura)"
          className="grid grid-cols-5 gap-1 pt-1 sm:grid-cols-9"
        >
          {SIGNAL_CHAIN_NODES.map((node) => {
            const hasChain = Boolean(activePreset?.signalChain);
            const active = activePreset?.signalChain
              ? Boolean(activePreset.signalChain[node.key])
              : false;

            return (
              <div
                key={node.key}
                data-block={node.label}
                data-active={hasChain ? String(active) : 'unknown'}
                className={`flex h-7 items-center justify-center rounded-sm border font-mono text-[10px] font-semibold tracking-wider transition-colors duration-150 ${
                  active
                    ? 'border-[#22C55E]/45 bg-[#22C55E]/10 text-[#F3F4F6]'
                    : hasChain
                      ? 'border-white/[0.06] bg-[#14161A]/60 text-[#525866]'
                      : 'border-white/[0.05] bg-[#14161A]/30 text-[#525866]'
                }`}
              >
                {node.label}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
