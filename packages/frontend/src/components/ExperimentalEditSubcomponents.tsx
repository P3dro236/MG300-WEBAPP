import React from 'react';
import {
  type Mg300BlockCatalogEntry,
  type Mg300ModelSpec,
  MG300_USER_IR_CAB_ID,
} from '@quicktone/shared';

export interface ExperimentalFaderProps {
  testId: string;
  label: string;
  labelWidthClass?: string;
  value: number;
  max: number;
  disabled: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onChangeValue: (value: number) => void;
}

export const ExperimentalFader: React.FC<ExperimentalFaderProps> = ({
  testId,
  label,
  labelWidthClass = 'w-20',
  value,
  max,
  disabled,
  onDragStart,
  onDragEnd,
  onChangeValue,
}) => {
  const clamped = Math.max(0, Math.min(max, value));
  const pct = max > 0 ? Math.round((clamped / max) * 100) : 0;

  return (
    <label className="flex items-center gap-3">
      <span className={`${labelWidthClass} shrink-0 font-mono text-xs text-[#8E95A2]`}>
        {label}
      </span>
      <input
        data-testid={testId}
        type="range"
        min={0}
        max={max}
        step={1}
        value={clamped}
        disabled={disabled}
        style={{ '--volume-pct': `${pct}%` } as React.CSSProperties}
        onPointerDown={onDragStart}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onBlur={onDragEnd}
        onChange={(e) => onChangeValue(Number(e.target.value))}
        className="chassis-fader flex-1"
      />
      <span className="w-10 shrink-0 text-right font-mono text-xs font-semibold text-[#F3F4F6] tabular-nums">
        {clamped}
      </span>
    </label>
  );
};

const IR_CUT_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Flat' },
  { value: 1, label: 'Low Cut' },
  { value: 2, label: 'Hi/Lo Cut' },
];

export interface IrCutSelectorProps {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

export const IrCutSelector: React.FC<IrCutSelectorProps> = ({ value, disabled, onChange }) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <span className="font-mono text-xs text-[#8E95A2]">IR Cut</span>
    <div
      role="group"
      aria-label="Corte de frequência do IR"
      className="inline-flex rounded border border-white/[0.08] bg-[#14161A] p-0.5 font-mono text-xs"
    >
      {IR_CUT_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`min-h-[44px] rounded-sm px-3 transition-colors duration-150 sm:min-h-[40px] ${
              selected
                ? 'bg-[#1B1E24] font-semibold text-[#F3F4F6]'
                : 'text-[#8E95A2] hover:text-[#F3F4F6]'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  </div>
);

export interface ExperimentalBlockInspectorProps {
  block: Mg300BlockCatalogEntry;
  modelId: number;
  modelSpec: Mg300ModelSpec | undefined;
  values: readonly number[];
  cabEnabled: boolean;
  irVolume: number;
  irCut: number;
  disabled: boolean;
  onToggleBlock: () => void;
  onChangeModel: (modelId: number) => void;
  onChangeParam: (paramIndex: number, value: number) => void;
  onChangeLevel: (target: 'irVolume' | 'irCut', value: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export const ExperimentalBlockInspector: React.FC<ExperimentalBlockInspectorProps> = ({
  block,
  modelId,
  modelSpec,
  values,
  cabEnabled,
  irVolume,
  irCut,
  disabled,
  onToggleBlock,
  onChangeModel,
  onChangeParam,
  onChangeLevel,
  onDragStart,
  onDragEnd,
}) => {
  const isEnabled = modelId > 0;

  return (
    <div className="flex flex-col gap-3 rounded border border-white/[0.08] bg-[#090A0C] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold tracking-wider text-[#F3F4F6]">
            BLOCO {block.label}
          </span>
          <span
            className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
              isEnabled
                ? 'border-[#22C55E]/40 bg-[#22C55E]/10 text-[#22C55E]'
                : 'border-white/10 bg-[#14161A] text-[#8E95A2]'
            }`}
          >
            {isEnabled ? 'ATIVO' : 'OFF'}
          </span>
        </div>

        <button
          type="button"
          data-testid={`exp-toggle-block-${block.code}`}
          aria-pressed={isEnabled}
          disabled={disabled}
          onClick={onToggleBlock}
          className={`min-h-[44px] rounded border px-3.5 font-mono text-xs font-semibold transition-colors duration-150 disabled:opacity-40 ${
            isEnabled
              ? 'border-[#22C55E]/50 bg-[#141A16] text-[#22C55E] hover:border-[#22C55E]'
              : 'border-white/15 bg-[#1B1E24] text-[#F3F4F6] hover:border-white/30'
          }`}
        >
          {isEnabled ? 'Desligar Bloco' : 'Ligar Bloco'}
        </button>
      </div>

      {/* Seletor de pedal / modelo */}
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-[#8E95A2]">
          Pedal / Modelo ({block.label})
        </span>
        <select
          data-testid={`exp-model-select-${block.code}`}
          disabled={disabled}
          value={modelId}
          onChange={(e) => onChangeModel(Number(e.target.value))}
          className="min-h-[44px] w-full rounded border border-white/15 bg-[#14161A] px-3 font-mono text-xs text-[#F3F4F6] disabled:opacity-40"
        >
          <option value={0}>0 — OFF (Bypass)</option>
          {block.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id === MG300_USER_IR_CAB_ID ? 'USER' : model.id} — {model.name}
            </option>
          ))}
        </select>
      </label>

      {/* Controles dinâmicos para o modelo escolhido */}
      {block.id <= 8 ? (
        modelSpec ? (
          <div className="flex flex-col gap-2.5">
            {modelSpec.params.map((param) => {
              const val = values[param.paramIndex] ?? 0;
              if (param.controlType === 'toggle') {
                const isToggleOn = val > 0;
                return (
                  <div
                    key={`${block.id}-${modelId}-${param.cc}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="font-mono text-xs text-[#8E95A2]">{param.label}</span>
                    <button
                      type="button"
                      data-testid={`exp-toggle-param-${block.code}-${param.paramIndex}`}
                      aria-label={`${param.label}: ${isToggleOn ? 'ligado' : 'desligado'}`}
                      aria-pressed={isToggleOn}
                      disabled={disabled}
                      onClick={() =>
                        onChangeParam(param.paramIndex, isToggleOn ? 0 : (param.onValue ?? 1))
                      }
                      className={`min-h-[44px] min-w-[96px] rounded border px-3 font-mono text-xs font-semibold transition-colors duration-150 ${
                        isToggleOn
                          ? 'border-[#F59E0B]/60 bg-[#1B1710] text-[#F59E0B]'
                          : 'border-white/15 bg-[#14161A] text-[#8E95A2]'
                      }`}
                    >
                      {isToggleOn ? 'LIGADO' : 'DESLIGADO'}
                    </button>
                  </div>
                );
              }

              if (param.controlType === 'select' && param.options) {
                const clampedOption =
                  param.options.find((opt) => opt.value === val)?.value ??
                  param.options[0]?.value ??
                  0;
                return (
                  <label
                    key={`${block.id}-${modelId}-${param.cc}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="w-20 shrink-0 font-mono text-xs text-[#8E95A2]">
                      {param.label}
                    </span>
                    <select
                      data-testid={`exp-select-param-${block.code}-${param.paramIndex}`}
                      disabled={disabled}
                      value={clampedOption}
                      onChange={(e) => onChangeParam(param.paramIndex, Number(e.target.value))}
                      className="min-h-[44px] flex-1 rounded border border-white/15 bg-[#14161A] px-3 font-mono text-xs text-[#F3F4F6]"
                    >
                      {param.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              }

              return (
                <ExperimentalFader
                  key={`${block.id}-${modelId}-${param.cc}`}
                  testId={`exp-slider-${block.code}-${param.paramIndex}`}
                  label={param.label}
                  value={val}
                  max={param.max}
                  disabled={disabled}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onChangeValue={(v) => onChangeParam(param.paramIndex, v)}
                />
              );
            })}
          </div>
        ) : (
          <p className="font-sans text-xs text-[#8E95A2]">
            Bloco em bypass (OFF). Selecione um modelo acima para ajustar os parâmetros.
          </p>
        )
      ) : null}

      {/* Controles de IR diretamente no bloco CAB (id 9) */}
      {block.id === 9 ? (
        <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-2.5">
          <ExperimentalFader
            testId="exp-slider-cab-irVolume"
            label="IR Level"
            value={irVolume}
            max={40}
            disabled={disabled}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChangeValue={(v) => onChangeLevel('irVolume', v)}
          />
          <IrCutSelector
            value={irCut}
            disabled={disabled}
            onChange={(v) => onChangeLevel('irCut', v)}
          />
        </div>
      ) : null}

      {/* Nota contextual para MIC quando CAB está desligado */}
      {block.id === 10 && !cabEnabled ? (
        <p className="font-sans text-xs text-[#8E95A2]">
          Dica: o bloco CAB está desligado; ative um gabinete no bloco CAB para ouvir a simulação de
          microfone.
        </p>
      ) : null}
    </div>
  );
};

export interface ExperimentalLevelsPanelProps {
  patchVolume: number;
  irVolume: number;
  irCut: number;
  disabled: boolean;
  onChangeLevel: (target: 'patchVolume' | 'irVolume' | 'irCut', value: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export const ExperimentalLevelsPanel: React.FC<ExperimentalLevelsPanelProps> = ({
  patchVolume,
  irVolume,
  irCut,
  disabled,
  onChangeLevel,
  onDragStart,
  onDragEnd,
}) => (
  <div className="flex flex-col gap-3 rounded border border-white/[0.08] bg-[#090A0C] p-3">
    <div className="border-b border-white/[0.06] pb-2">
      <span className="font-mono text-xs font-bold tracking-wider text-[#F3F4F6]">
        NÍVEIS DO PRESET &amp; IR
      </span>
    </div>

    <ExperimentalFader
      testId="exp-slider-patchVolume"
      label="Patch Level"
      labelWidthClass="w-24"
      value={patchVolume}
      max={100}
      disabled={disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onChangeValue={(v) => onChangeLevel('patchVolume', v)}
    />

    <ExperimentalFader
      testId="exp-slider-irVolume"
      label="IR Volume"
      labelWidthClass="w-24"
      value={irVolume}
      max={40}
      disabled={disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onChangeValue={(v) => onChangeLevel('irVolume', v)}
    />

    <div className="pt-1">
      <IrCutSelector
        value={irCut}
        disabled={disabled}
        onChange={(v) => onChangeLevel('irCut', v)}
      />
    </div>
  </div>
);
