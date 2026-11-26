import React, { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

const PresetGridInner: React.FC<PresetGridProps> = ({
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
  searchInputRef,
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

  const effectiveViewMode: PresetViewMode =
    searchQuery.trim().length > 0 ? 'matrix' : viewMode;

  return (
    <section
      data-testid="preset-grid"
      aria-label="Seleção de timbres MG-300"
      className="surface-card p-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-3">
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums">
            <button
              type="button"
              data-testid="filter-tab-user"
              aria-pressed={filter === 'user'}
              onClick={() => onChangeFilter('user')}
              className={`min-h-[44px] rounded-[var(--radius-md)] border px-3 transition-colors duration-150 lg:min-h-[38px] cursor-pointer ${
                filter === 'user'
                  ? 'border-border-strong bg-bg-elevated font-semibold text-text-primary'
                  : 'border-border-subtle bg-bg-recess text-text-muted hover:border-border-hover hover:text-text-primary'
              }`}
            >
              Usuário ({userCount})
            </button>

            <button
              type="button"
              data-testid="filter-tab-factory"
              aria-pressed={filter === 'factory'}
              onClick={() => onChangeFilter('factory')}
              className={`min-h-[44px] rounded-[var(--radius-md)] border px-3 transition-colors duration-150 lg:min-h-[38px] cursor-pointer ${
                filter === 'factory'
                  ? 'border-border-strong bg-bg-elevated font-semibold text-text-primary'
                  : 'border-border-subtle bg-bg-recess text-text-muted hover:border-border-hover hover:text-text-primary'
              }`}
            >
              Fábrica ({factoryCount})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Modo de exibição dos timbres"
              className="inline-flex rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-0.5 font-mono text-[11px]"
            >
              <button
                type="button"
                data-testid="view-mode-stage-btn"
                aria-pressed={viewMode === 'stage'}
                onClick={() => onChangeViewMode('stage')}
                className={`min-h-[44px] rounded-[var(--radius-sm)] px-3 transition-colors duration-150 lg:min-h-[34px] cursor-pointer ${
                  viewMode === 'stage'
                    ? 'bg-bg-elevated font-semibold text-text-primary'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                Palco (A–D)
              </button>
              <button
                type="button"
                data-testid="view-mode-matrix-btn"
                aria-pressed={viewMode === 'matrix'}
                onClick={() => onChangeViewMode('matrix')}
                className={`min-h-[44px] rounded-[var(--radius-sm)] px-3 transition-colors duration-150 lg:min-h-[34px] cursor-pointer ${
                  viewMode === 'matrix'
                    ? 'bg-bg-elevated font-semibold text-text-primary'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                Bancos (1–9)
              </button>
            </div>

            <input
              ref={searchInputRef}
              type="search"
              name="preset-search"
              autoComplete="off"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar timbre ou slot…"
              aria-label="Buscar timbre"
              className="min-h-[44px] w-full rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess px-3 font-mono text-xs text-text-primary placeholder:text-text-dim sm:w-48 lg:min-h-[38px]"
            />

            {onReloadPresets ? (
              <button
                type="button"
                data-testid="reload-presets-btn"
                disabled={isReloadingPresets}
                onClick={onReloadPresets}
                aria-label="Sincronizar timbres da pedaleira"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess px-3 font-sans text-xs font-medium text-text-primary transition-colors duration-150 hover:border-border-hover hover:bg-bg-elevated disabled:opacity-50 lg:min-h-[38px] cursor-pointer"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 text-text-muted ${isReloadingPresets ? 'animate-spin' : ''}`}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span>{isReloadingPresets ? 'Sincronizando…' : 'Sincronizar'}</span>
              </button>
            ) : null}
          </div>
        </div>

        {filteredPresets.length === 0 ? (
          <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-6 text-center font-mono text-xs text-text-muted">
            {filter === 'user'
              ? 'Nenhum timbre de usuário carregado. Conecte a MG-300 para sincronizar.'
              : 'Nenhum timbre de fábrica encontrado neste filtro.'}
          </div>
        ) : effectiveViewMode === 'stage' ? (
          <StageFootswitchDeck
            presets={filteredPresets}
            confirmedState={confirmedState}
            lastSentCommand={lastSentCommand}
            disabled={disabled}
            onSelectPreset={onSelectPreset}
          />
        ) : (
          <div className="flex flex-col divide-y divide-border-subtle rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess">
            {groupedBanks.map((group) => (
              <div
                key={group.key}
                className="flex flex-col gap-2 p-2.5 sm:flex-row sm:items-stretch sm:gap-3"
              >
                <div className="flex items-center justify-between px-1 font-mono text-[11px] font-semibold tracking-wider text-text-muted tabular-nums sm:w-28 sm:shrink-0 sm:flex-col sm:items-start sm:justify-center sm:border-r sm:border-border-subtle sm:pr-2">
                  <span>{group.label.toUpperCase()}</span>
                  <span className="text-[11px] text-text-dim">{group.key}A–{group.key}D</span>
                </div>

                <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
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

export const PresetGrid = React.memo(PresetGridInner);
