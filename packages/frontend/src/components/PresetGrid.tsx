import React, { useMemo, useState } from 'react';
import type {
  ConfirmedDeviceState,
  Preset,
  PresetsDirectoryStatus,
  SentCommandRecord,
} from '@quicktone/shared';
import { PresetCard, resolvePresetStatus } from './PresetCard';
import { StageFootswitchDeck } from './StageFootswitchDeck';
import { groupPresetsByBank } from '../utils/preset-groups';

export type PresetFilter = 'all' | 'user' | 'factory';
export type PresetViewMode = 'stage' | 'matrix';

interface PresetGridProps {
  presets: Preset[];
  filter: PresetFilter;
  viewMode: PresetViewMode;
  onChangeFilter: (filter: PresetFilter) => void;
  onChangeViewMode: (mode: PresetViewMode) => void;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  disabled: boolean;
  directoryStatus: PresetsDirectoryStatus;
  presetsDirectory: string | null;
  isReloadingPresets?: boolean;
  onSelectPreset: (preset: Preset) => void;
  onOpenSettings: () => void;
  onReloadPresets?: () => void;
}

export const PresetGrid: React.FC<PresetGridProps> = ({
  presets,
  filter,
  viewMode,
  onChangeFilter,
  onChangeViewMode,
  confirmedState,
  lastSentCommand,
  disabled,
  directoryStatus,
  presetsDirectory,
  isReloadingPresets = false,
  onSelectPreset,
  onOpenSettings,
  onReloadPresets,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  const userCount = useMemo(
    () => presets.filter((p) => p.bankType === 'user').length,
    [presets],
  );
  const factoryCount = useMemo(
    () => presets.filter((p) => p.bankType === 'factory').length,
    [presets],
  );

  const filteredPresets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return presets.filter((preset) => {
      if (filter === 'user' && preset.bankType !== 'user') return false;
      if (filter === 'factory' && preset.bankType !== 'factory') return false;
      if (query.length > 0) {
        return (
          preset.name.toLowerCase().includes(query) ||
          preset.displayBank.toLowerCase().includes(query) ||
          preset.id.toLowerCase().includes(query)
        );
      }
      return true;
    });
  }, [presets, filter, searchQuery]);

  const groupedBanks = useMemo(
    () => groupPresetsByBank(filteredPresets),
    [filteredPresets],
  );

  const effectiveDirectoryError =
    directoryStatus === 'directory_not_found' || directoryStatus === 'error';

  return (
    <section
      data-testid="preset-grid"
      aria-label="Seleção de presets MG-300"
      className="rounded-md border border-white/[0.08] bg-[#14161A] p-3.5 sm:p-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs tabular-nums">
            <button
              type="button"
              data-testid="filter-tab-all"
              onClick={() => onChangeFilter('all')}
              className={`min-h-[36px] rounded border px-3 transition-colors duration-150 ${
                filter === 'all'
                  ? 'border-white/25 bg-[#1B1E24] font-semibold text-[#F3F4F6]'
                  : 'border-white/[0.06] bg-[#090A0C] text-[#8E95A2] hover:border-white/15 hover:text-[#F3F4F6]'
              }`}
            >
              Todos ({presets.length})
            </button>

            <button
              type="button"
              data-testid="filter-tab-user"
              onClick={() => onChangeFilter('user')}
              className={`min-h-[36px] rounded border px-3 transition-colors duration-150 ${
                filter === 'user'
                  ? 'border-white/25 bg-[#1B1E24] font-semibold text-[#F3F4F6]'
                  : 'border-white/[0.06] bg-[#090A0C] text-[#8E95A2] hover:border-white/15 hover:text-[#F3F4F6]'
              }`}
            >
              Usuário ({userCount})
            </button>

            <button
              type="button"
              data-testid="filter-tab-factory"
              onClick={() => onChangeFilter('factory')}
              className={`min-h-[36px] rounded border px-3 transition-colors duration-150 ${
                filter === 'factory'
                  ? 'border-white/25 bg-[#1B1E24] font-semibold text-[#F3F4F6]'
                  : 'border-white/[0.06] bg-[#090A0C] text-[#8E95A2] hover:border-white/15 hover:text-[#F3F4F6]'
              }`}
            >
              Fábrica ({factoryCount})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded border border-white/[0.08] bg-[#090A0C] p-0.5 font-mono text-[11px]">
              <button
                type="button"
                data-testid="view-mode-stage-btn"
                onClick={() => onChangeViewMode('stage')}
                className={`min-h-[32px] rounded-sm px-2.5 transition-colors duration-150 ${
                  viewMode === 'stage'
                    ? 'bg-[#1B1E24] font-semibold text-[#F3F4F6]'
                    : 'text-[#8E95A2] hover:text-[#F3F4F6]'
                }`}
              >
                Modo palco (A–D)
              </button>
              <button
                type="button"
                data-testid="view-mode-matrix-btn"
                onClick={() => onChangeViewMode('matrix')}
                className={`min-h-[32px] rounded-sm px-2.5 transition-colors duration-150 ${
                  viewMode === 'matrix'
                    ? 'bg-[#1B1E24] font-semibold text-[#F3F4F6]'
                    : 'text-[#8E95A2] hover:text-[#F3F4F6]'
                }`}
              >
                Matriz (1–9)
              </button>
            </div>

            {viewMode === 'matrix' ? (
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar preset ou banco..."
                aria-label="Buscar preset"
                className="min-h-[34px] w-full rounded border border-white/[0.08] bg-[#090A0C] px-2.5 font-mono text-xs text-[#F3F4F6] placeholder:text-[#525866] focus:border-white/25 focus:outline-none sm:w-48"
              />
            ) : null}

            {onReloadPresets ? (
              <button
                type="button"
                data-testid="reload-presets-btn"
                disabled={isReloadingPresets}
                onClick={onReloadPresets}
                aria-label="Sincronizar presets do disco e da pedaleira"
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded border border-white/[0.08] bg-[#090A0C] px-2.5 font-mono text-[11px] text-[#F3F4F6] transition-colors duration-150 hover:border-white/25 hover:bg-[#1B1E24] disabled:opacity-50"
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
                <span>{isReloadingPresets ? 'Sincronizando...' : 'Sincronizar'}</span>
              </button>
            ) : null}
          </div>
        </div>

        {effectiveDirectoryError ? (
          <div
            data-testid="directory-error-banner"
            className="flex flex-col justify-between gap-2 rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-3 font-mono text-xs text-[#F59E0B] sm:flex-row sm:items-center"
          >
            <div>
              Pasta QuickTone indisponível ou não encontrada
              {presetsDirectory ? `: "${presetsDirectory}"` : ''}.
            </div>
            <button
              type="button"
              onClick={onOpenSettings}
              className="shrink-0 rounded border border-[#F59E0B]/50 bg-[#090A0C] px-3 py-1.5 text-xs font-semibold text-[#F59E0B] hover:border-[#F59E0B]"
            >
              Configurar pasta
            </button>
          </div>
        ) : null}

        {filteredPresets.length === 0 ? (
          <div className="rounded border border-white/[0.06] bg-[#090A0C] p-6 text-center font-mono text-xs text-[#8E95A2]">
            Nenhum preset encontrado neste filtro.
          </div>
        ) : viewMode === 'stage' ? (
          <StageFootswitchDeck
            presets={filteredPresets}
            confirmedState={confirmedState}
            lastSentCommand={lastSentCommand}
            disabled={disabled}
            onSelectPreset={onSelectPreset}
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {groupedBanks.map((group) => (
              <div
                key={group.key}
                className="flex flex-col gap-1.5 rounded border border-white/[0.06] bg-[#090A0C] p-2 sm:flex-row sm:items-stretch sm:gap-3"
              >
                <div className="flex items-center justify-between px-1 font-mono text-[11px] font-semibold tracking-wider text-[#8E95A2] tabular-nums sm:w-28 sm:shrink-0 sm:flex-col sm:items-start sm:justify-center sm:border-r sm:border-white/[0.06] sm:pr-2">
                  <span>{group.label.toUpperCase()}</span>
                  <span className="text-[10px] text-[#525866]">{group.key}A–{group.key}D</span>
                </div>

                <div className="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {group.items.map((preset) => (
                    <PresetCard
                      key={preset.id}
                      preset={preset}
                      status={resolvePresetStatus(preset, confirmedState, lastSentCommand)}
                      disabled={disabled}
                      variant="row-cell"
                      onSelect={onSelectPreset}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
