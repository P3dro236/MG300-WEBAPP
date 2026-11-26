import React from 'react';
import {
  type Mg300BlockCatalogEntry,
  type Mg300ModelSpec,
  MG300_USER_IR_CAB_ID,
} from '@quicktone/shared';

export interface ToneFaderProps {
  testId: string;
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onChangeValue: (value: number) => void;
}

export const ToneFader: React.FC<ToneFaderProps> = ({
  testId,
  label,
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
      <span className="min-w-[96px] shrink-0 font-mono text-xs text-text-muted">
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
      <span className="w-10 shrink-0 text-right font-mono text-xs font-semibold text-text-primary tabular-nums">
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

export interface ToneIrCutSelectorProps {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

export const ToneIrCutSelector: React.FC<ToneIrCutSelectorProps> = ({
  value,
  disabled,
  onChange,
}) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <span className="font-mono text-xs text-text-muted">Corte de IR</span>
    <div
      role="group"
      aria-label="Corte de frequência do IR"
      className="inline-flex rounded-[var(--radius-md)] border border-border-subtle bg-bg-surface p-0.5 font-mono text-xs"
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
            className={`min-h-[44px] rounded-[var(--radius-sm)] px-3 transition-colors duration-150 lg:min-h-[38px] cursor-pointer ${
              selected
                ? 'bg-bg-elevated font-semibold text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  </div>
);

export interface ToneBlockInspectorProps {
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

export const ToneBlockInspector: React.FC<ToneBlockInspectorProps> = ({
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
    <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold tracking-wider text-text-primary">
            {block.label}
          </span>
          <span
            className={`rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-[11px] font-semibold ${
              isEnabled
                ? 'border-status-confirmed-border bg-status-confirmed-bg text-status-confirmed'
                : 'border-border-subtle bg-bg-surface text-text-muted'
            }`}
          >
            {isEnabled ? 'Ligado' : 'Desligado'}
          </span>
        </div>

        <button
          type="button"
          data-testid={`exp-toggle-block-${block.code}`}
          aria-pressed={isEnabled}
          disabled={disabled}
          onClick={onToggleBlock}
          className={`min-h-[44px] rounded-[var(--radius-md)] border px-3.5 font-sans text-xs font-semibold transition-colors duration-150 disabled:opacity-40 cursor-pointer ${
            isEnabled
              ? 'border-status-confirmed-border bg-status-confirmed-bg text-status-confirmed hover:border-status-confirmed'
              : 'border-border-strong bg-bg-elevated text-text-primary hover:border-border-hover'
          }`}
        >
          {isEnabled ? 'Desligar' : 'Ligar'}
        </button>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">
          Modelo ({block.label})
        </span>
        <select
          data-testid={`exp-model-select-${block.code}`}
          name={`model-${block.code}`}
          disabled={disabled}
          value={modelId}
          onChange={(e) => onChangeModel(Number(e.target.value))}
          className="min-h-[44px] w-full rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-3 font-mono text-xs text-text-primary disabled:opacity-40"
        >
          <option value={0} className="bg-bg-surface text-text-primary">
            Desligado (Bypass)
          </option>
          {block.models.map((model) => (
            <option
              key={model.id}
              value={model.id}
              className="bg-bg-surface text-text-primary"
            >
              {model.id === MG300_USER_IR_CAB_ID ? `USER IR · ${model.name}` : model.name}
            </option>
          ))}
        </select>
      </label>

      {block.id <= 8 ? (
        modelSpec ? (
          <div className="flex flex-col gap-3">
            {modelSpec.params.map((param) => {
              const val = values[param.paramIndex] ?? 0;
              if (param.controlType === 'toggle') {
                const isToggleOn = val > 0;
                return (
                  <div
                    key={`${block.id}-${modelId}-${param.cc}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="font-mono text-xs text-text-muted">{param.label}</span>
                    <button
                      type="button"
                      data-testid={`exp-toggle-param-${block.code}-${param.paramIndex}`}
                      aria-label={`${param.label}: ${isToggleOn ? 'ligado' : 'desligado'}`}
                      aria-pressed={isToggleOn}
                      disabled={disabled}
                      onClick={() =>
                        onChangeParam(param.paramIndex, isToggleOn ? 0 : (param.onValue ?? 1))
                      }
                      className={`min-h-[44px] min-w-[104px] rounded-[var(--radius-md)] border px-3 font-mono text-xs font-semibold transition-colors duration-150 cursor-pointer ${
                        isToggleOn
                          ? 'border-accent-border bg-accent-soft text-accent'
                          : 'border-border-strong bg-bg-surface text-text-muted'
                      }`}
                    >
                      {isToggleOn ? 'Ligado' : 'Desligado'}
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
                    <span className="min-w-[96px] shrink-0 font-mono text-xs text-text-muted">
                      {param.label}
                    </span>
                    <select
                      data-testid={`exp-select-param-${block.code}-${param.paramIndex}`}
                      name={`param-${block.code}-${param.paramIndex}`}
                      disabled={disabled}
                      value={clampedOption}
                      onChange={(e) => onChangeParam(param.paramIndex, Number(e.target.value))}
                      className="min-h-[44px] flex-1 rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-3 font-mono text-xs text-text-primary"
                    >
                      {param.options.map((opt) => (
                        <option
                          key={opt.value}
                          value={opt.value}
                          className="bg-bg-surface text-text-primary"
                        >
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              }

              return (
                <ToneFader
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
          <p className="font-sans text-xs text-text-muted">
            Bloco em bypass. Selecione um modelo acima para ajustar os parâmetros.
          </p>
        )
      ) : null}

      {block.id === 9 ? (
        <div className="flex flex-col gap-3 border-t border-border-subtle pt-3">
          <ToneFader
            testId="exp-slider-cab-irVolume"
            label="Volume do IR"
            value={irVolume}
            max={40}
            disabled={disabled}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onChangeValue={(v) => onChangeLevel('irVolume', v)}
          />
          <ToneIrCutSelector
            value={irCut}
            disabled={disabled}
            onChange={(v) => onChangeLevel('irCut', v)}
          />
        </div>
      ) : null}

      {block.id === 10 && !cabEnabled ? (
        <p className="font-sans text-xs text-text-muted">
          Dica: o bloco CAB está desligado; ative um gabinete no bloco CAB para ouvir a simulação de
          microfone.
        </p>
      ) : null}
    </div>
  );
};

export interface ToneLevelsPanelProps {
  patchVolume: number;
  disabled: boolean;
  onChangePatchVolume: (value: number) => void;
  onJumpToCab: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export const ToneLevelsPanel: React.FC<ToneLevelsPanelProps> = ({
  patchVolume,
  disabled,
  onChangePatchVolume,
  onJumpToCab,
  onDragStart,
  onDragEnd,
}) => (
  <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-4">
    <div className="border-b border-border-subtle pb-2.5">
      <span className="font-mono text-xs font-bold tracking-wider text-text-primary">
        NÍVEL DO TIMBRE
      </span>
    </div>

    <ToneFader
      testId="exp-slider-patchVolume"
      label="Volume do timbre"
      value={patchVolume}
      max={100}
      disabled={disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onChangeValue={onChangePatchVolume}
    />

    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
      <span className="font-sans text-xs text-text-muted">
        Volume e corte de IR ficam centralizados no bloco CAB.
      </span>
      <button
        type="button"
        onClick={onJumpToCab}
        className="min-h-[44px] rounded-[var(--radius-sm)] border border-border-strong bg-bg-surface px-3 font-sans text-xs font-medium text-text-primary transition-colors hover:border-border-hover lg:min-h-[34px] cursor-pointer"
      >
        Ir para CAB
      </button>
    </div>
  </div>
);
