import React, { useMemo, useState } from 'react';
import {
  type ConfirmedDeviceState,
  type Preset,
  type SentCommandRecord,
  classifyPresetCategory,
  filterVisibleLibraryPresets,
} from '@quicktone/shared';
import { PresetCard, resolvePresetStatus } from './PresetCard';
import { StageFootswitchDeck } from './StageFootswitchDeck';
import { groupPresetsByBank } from '../utils/preset-groups';

export type PresetFilter = 'user' | 'factory';
export type PresetViewMode = 'stage' | 'matrix';

interface PresetGridProps {
  presets: Preset[];
  alreadyFiltered?: boolean;
  filter: PresetFilter;
  viewMode: PresetViewMode;
  onChangeFilter: (filter: PresetFilter) => void;
  onChangeViewMode: (mode: PresetViewMode) => void;
  confirmedState: ConfirmedDeviceState;
  lastSentCommand: SentCommandRecord | null;
  disabled: boolean;
  isReloadingPresets?: boolean;
  onSelectPreset: (preset: Preset) => void;
  onReloadPresets?: () => void;
}

export const PresetGrid: React.FC<PresetGridProps> = ({
  presets,
  alreadyFiltered = false,
  filter,
  viewMode,
  onChangeFilter,
  onChangeViewMode,
  confirmedState,
  lastSentCommand,
  disabled,
  isReloadingPresets = false,
  onSelectPreset,
  onReloadPresets,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  const visiblePresets = useMemo(
    () => (alreadyFiltered ? presets : filterVisibleLibraryPresets(presets)),
    [presets, alreadyFiltered],
  );

  const userCount = useMemo(
    () => visiblePresets.filter((p) => classifyPresetCategory(p) === 'user').length,
    [visiblePresets],
  );
  const factoryCount = useMemo(
    () => visiblePresets.filter((p) => classifyPresetCategory(p) === 'factory').length,
    [visiblePresets],
  );

  const filteredPresets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return visiblePresets.filter((preset) => {
      if (classifyPresetCategory(preset) !== filter) {
        return false;
      }
      if (query.length > 0) {
        return (
          preset.name.toLowerCase().includes(query) ||
          preset.displayBank.toLowerCase().includes(query) ||
          preset.id.toLowerCase().includes(query)
        );
      }
      return true;
    });
  }, [visiblePresets, filter, searchQuery]);

  const groupedBanks = useMemo(
    () => groupPresetsByBank(filteredPresets),
    [filteredPresets],
  );

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
              data-testid="filter-tab-user"
              onClick={() => onChangeFilter('user')}
              className={`min-h-[44px] rounded border px-3 transition-colors duration-150 sm:min-h-[36px] ${
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
              className={`min-h-[44px] rounded border px-3 transition-colors duration-150 sm:min-h-[36px] ${
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
                className={`min-h-[40px] rounded-sm px-2.5 transition-colors duration-150 sm:min-h-[32px] ${
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
                className={`min-h-[40px] rounded-sm px-2.5 transition-colors duration-150 sm:min-h-[32px] ${
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
                className="min-h-[44px] w-full rounded border border-white/[0.08] bg-[#090A0C] px-2.5 font-mono text-xs text-[#F3F4F6] placeholder:text-[#525866] focus:border-white/25 focus:outline-none sm:min-h-[34px] sm:w-48"
              />
            ) : null}

            {onReloadPresets ? (
              <button
                type="button"
                data-testid="reload-presets-btn"
                disabled={isReloadingPresets}
                onClick={onReloadPresets}
                aria-label="Sincronizar presets da pedaleira"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded border border-white/[0.08] bg-[#090A0C] px-2.5 font-mono text-[11px] text-[#F3F4F6] transition-colors duration-150 hover:border-white/25 hover:bg-[#1B1E24] disabled:opacity-50 sm:min-h-[34px]"
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

        {filteredPresets.length === 0 ? (
          <div className="rounded border border-white/[0.06] bg-[#090A0C] p-6 text-center font-mono text-xs text-[#8E95A2]">
            {filter === 'user'
              ? 'Nenhum preset de usuário carregado. Conecte a MG-300 para sincronizar os timbres salvos.'
              : 'Nenhum preset de fábrica encontrado neste filtro.'}
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
