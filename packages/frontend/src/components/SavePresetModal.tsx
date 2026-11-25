import React, { useEffect } from 'react';
import {
  MG300_USER_SLOTS,
  MG300_USER_SLOT_MAX,
  MG300_USER_SLOT_MIN,
  type Preset,
  isPlaceholderPreset,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';

interface SavePresetModalProps {
  isOpen: boolean;
  targetSlot: number;
  presetName: string;
  bpm: number;
  hasUserIr: boolean;
  userIrName: string | null;
  presets: readonly Preset[];
  saving: boolean;
  error?: string | null;
  onChangeTargetSlot: (slotIndex: number) => void;
  onClose: () => void;
  onConfirm: (confirmedSlot: number) => void;
}

function describeOccupant(slotIndex: number, presets: readonly Preset[]): string | null {
  const match = presets.find((p) => p.slotIndex === slotIndex && p.bankType === 'user');
  if (!match || isPlaceholderPreset(match)) {
    return null;
  }
  return match.name;
}

/**
 * Confirmation modal for committing the active preset into a User slot (`1A..9D`).
 * Strictly excludes Factory slots (`F1A..F9D`) and summarizes destination + pre-overwrite backup.
 */
export const SavePresetModal: React.FC<SavePresetModalProps> = ({
  isOpen,
  targetSlot,
  presetName,
  bpm,
  hasUserIr,
  userIrName,
  presets,
  saving,
  error = null,
  onChangeTargetSlot,
  onClose,
  onConfirm,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, saving, onClose]);

  if (!isOpen) {
    return null;
  }

  const safeSlot =
    targetSlot >= MG300_USER_SLOT_MIN && targetSlot <= MG300_USER_SLOT_MAX ? targetSlot : 15;
  const targetCoord = slotIndexToBankCoordinate(safeSlot);
  const occupantName = describeOccupant(safeSlot, presets);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-preset-modal-title"
      data-testid="save-preset-modal"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-md border border-white/15 bg-[#14161A] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div>
            <h2
              id="save-preset-modal-title"
              className="font-mono text-sm font-bold uppercase tracking-wider text-[#F3F4F6]"
            >
              Gravar Preset na Pedaleira
            </h2>
            <p className="mt-1 font-sans text-xs text-[#8E95A2]">
              Um backup automático do slot de destino será salvo no computador antes da gravação.
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            aria-label="Fechar janela de gravação"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-white/15 bg-[#090A0C] font-mono text-xs text-[#8E95A2] hover:text-[#F3F4F6] disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-xs font-semibold uppercase tracking-wide text-[#8E95A2]">
            Slot de Destino (Usuário 1A–9D)
          </span>
          <select
            data-testid="save-target-slot-select"
            value={safeSlot}
            disabled={saving}
            onChange={(e) => onChangeTargetSlot(Number(e.target.value))}
            className="min-h-[44px] w-full rounded border border-white/15 bg-[#090A0C] px-3 font-mono text-xs text-[#F3F4F6] tabular-nums"
          >
            {MG300_USER_SLOTS.map((coord) => {
              const current = describeOccupant(coord.slotIndex, presets);
              return (
                <option key={coord.slotIndex} value={coord.slotIndex}>
                  {coord.displayBank} — {current ?? 'Slot disponível'}
                </option>
              );
            })}
          </select>
        </label>

        <div className="flex flex-col gap-2 rounded border border-white/[0.08] bg-[#090A0C] p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[#8E95A2]">Novo Preset</span>
            <span className="font-mono font-semibold text-[#F3F4F6] tabular-nums">
              {presetName || 'New Preset'} · {bpm} BPM
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[#8E95A2]">Slot Alvo</span>
            <span className="font-mono font-bold text-[#F59E0B] tabular-nums">
              {targetCoord.displayBank}
            </span>
          </div>
          <div className="border-t border-white/[0.06] pt-2 font-sans text-[#D1D5DB]">
            {occupantName ? (
              <span>
                Este slot já contém <strong className="text-[#F3F4F6]">{occupantName}</strong> e
                será substituído após o backup.
              </span>
            ) : (
              <span>
                O slot <strong className="text-[#F3F4F6]">{targetCoord.displayBank}</strong> será
                gravado após o backup de segurança.
              </span>
            )}
          </div>
        </div>

        {hasUserIr ? (
          <div
            data-testid="save-modal-user-ir-warning"
            className="rounded border border-[#F59E0B]/40 bg-[#1B1710] p-2.5 font-sans text-xs text-[#FCD34D]"
          >
            {userIrName
              ? `User IR "${userIrName}" selecionado: os ajustes do preset serão gravados, mas o arquivo de áudio IR depende do que já estiver salvo neste slot.`
              : 'User IR customizado selecionado: os ajustes do preset serão gravados, mas o arquivo de áudio IR depende do que já estiver salvo neste slot.'}
          </div>
        ) : null}

        <p className="font-sans text-[11px] text-[#8E95A2]">
          Apenas slots de Usuário (1A–9D) podem ser gravados; slots de Fábrica (F1A–F9D) são
          protegidos contra escrita.
        </p>

        {error ? (
          <div
            data-testid="save-modal-error"
            role="alert"
            className="rounded border border-[#EF4444]/45 bg-[#EF4444]/10 p-2.5 font-sans text-xs text-[#FCA5A5]"
          >
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.08] pt-3">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="min-h-[44px] rounded border border-white/15 bg-[#090A0C] px-4 font-mono text-xs text-[#8E95A2] hover:text-[#F3F4F6] disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            data-testid="exp-confirm-save-btn"
            disabled={saving}
            onClick={() => onConfirm(safeSlot)}
            className="min-h-[44px] rounded border border-[#F59E0B] bg-[#F59E0B] px-4 font-mono text-xs font-bold text-[#090A0C] transition-colors duration-150 hover:bg-[#FBBF24] disabled:opacity-40"
          >
            {saving ? 'Gravando...' : `Confirmar em ${targetCoord.displayBank}`}
          </button>
        </div>
      </div>
    </div>
  );
};
