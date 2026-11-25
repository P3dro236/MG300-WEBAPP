import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MG300_BLOCK_CATALOG,
  MG300_EXPERIMENTAL_SLOT,
  MG300_USER_SLOTS,
  type Preset,
  getMg300BlockCatalog,
  getMg300ModelSpec,
  sanitizeMg300PresetName,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';
import {
  type ExperimentalEditState,
  type ExperimentalImportBundleSlot,
  type QuickToneApiClient,
  QuickToneApiError,
} from '../api/client';
import {
  ExperimentalBlockInspector,
  ExperimentalLevelsPanel,
} from './ExperimentalEditSubcomponents';
import { SavePresetModal } from './SavePresetModal';

const SEND_THROTTLE_MS = 35;
const META_DEBOUNCE_MS = 300;
const LOCAL_ECHO_GUARD_MS = 400;
const MAX_CLIENT_UPLOAD_BYTES = 512 * 1024;

interface ExperimentalEditPanelProps {
  client: QuickToneApiClient;
  presets?: readonly Preset[];
  disabled?: boolean;
  externalState?: ExperimentalEditState | null;
  syncEpoch?: number;
}

type SelectedTab = number | 'levels';

async function encodeFileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === 'function') {
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao ler arquivo local.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function getSourceBadge(mode: ExperimentalEditState['sourceMode']): {
  text: string;
  className: string;
} {
  if (mode === 'draft') {
    return {
      text: 'NOVO RASCUNHO',
      className: 'border-white/20 bg-[#1B1E24] text-[#D1D5DB]',
    };
  }
  if (mode === 'imported') {
    return {
      text: 'IMPORTADO',
      className: 'border-[#F59E0B]/40 bg-[#1B1710] text-[#F59E0B]',
    };
  }
  return {
    text: 'PEDALEIRA AO VIVO',
    className: 'border-[#22C55E]/40 bg-[#141A16] text-[#22C55E]',
  };
}

function clampBpm(value: number): number {
  return Math.max(40, Math.min(240, Math.round(Number.isFinite(value) ? value : 120)));
}

/**
 * Studio rack editor for all 10 MG-300 signal blocks (`COMP..MIC` + levels),
 * model/pedal selection, blank preset creation, `.nuxpreset` import, and User slot (`1A..9D`) Flash save.
 */
export function ExperimentalEditPanel({
  client,
  presets = [],
  disabled = false,
  externalState = null,
  syncEpoch = 0,
}: ExperimentalEditPanelProps): React.ReactElement | null {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<ExperimentalEditState | null>(null);
  const [selectedTab, setSelectedTab] = useState<SelectedTab>(3);
  const [loadSlot, setLoadSlot] = useState<number>(MG300_EXPERIMENTAL_SLOT);
  const [saveTargetSlot, setSaveTargetSlot] = useState<number>(MG300_EXPERIMENTAL_SLOT);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalError, setSaveModalError] = useState<string | null>(null);

  const [localBlockModels, setLocalBlockModels] = useState<Record<string, number>>({});
  const [localBlockParams, setLocalBlockParams] = useState<Record<string, number[]>>({});
  const [localName, setLocalName] = useState('');
  const [localBpm, setLocalBpm] = useState(120);
  const [localBpmText, setLocalBpmText] = useState('120');
  const [localTimeFlag, setLocalTimeFlag] = useState(0);
  const [localPatchVol, setLocalPatchVol] = useState(50);
  const [localIrVol, setLocalIrVol] = useState(20);
  const [localIrCut, setLocalIrCut] = useState(0);

  const [bundleInfo, setBundleInfo] = useState<{
    fileName: string;
    contentBase64: string;
    selectedIndex: number;
    slots: ExperimentalImportBundleSlot[];
  } | null>(null);

  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingFns = useRef(new Map<string, () => Promise<void>>());
  const isDraggingRef = useRef(false);
  const lastLocalEditAtRef = useRef(0);
  const metaDirtyRef = useRef(false);
  const metaInFlightRef = useRef<Promise<void> | null>(null);
  const prevServerSlotRef = useRef<number | null>(null);
  const editEpochRef = useRef(0);

  const cancelPendingEdits = useCallback((): void => {
    editEpochRef.current += 1;
    for (const timer of pendingTimers.current.values()) {
      clearTimeout(timer);
    }
    pendingTimers.current.clear();
    pendingFns.current.clear();
    isDraggingRef.current = false;
    lastLocalEditAtRef.current = 0;
    metaDirtyRef.current = false;
  }, []);

  const cancelPendingParamEdits = useCallback((): void => {
    for (const [key, timer] of pendingTimers.current.entries()) {
      if (key === 'meta') continue;
      clearTimeout(timer);
      pendingTimers.current.delete(key);
      pendingFns.current.delete(key);
    }
    isDraggingRef.current = false;
    lastLocalEditAtRef.current = 0;
  }, []);

  const applyState = useCallback(
    (next: ExperimentalEditState, options: { force?: boolean } = {}) => {
      const force = options.force ?? true;
      setState(next);

      if (prevServerSlotRef.current === null || prevServerSlotRef.current !== next.slot) {
        setLoadSlot(next.slot);
      }
      prevServerSlotRef.current = next.slot;

      const hasRecentLocalEdit =
        !force &&
        (isDraggingRef.current ||
          pendingTimers.current.size > 0 ||
          Date.now() - lastLocalEditAtRef.current < LOCAL_ECHO_GUARD_MS);

      if (!hasRecentLocalEdit) {
        setLocalBlockModels(next.blockModels ?? {});
        setLocalBlockParams(next.blockParams ?? {});
        setLocalPatchVol(next.patchVolume ?? 50);
        setLocalIrVol(next.irVolume ?? 20);
        setLocalIrCut(next.irCut ?? 0);
        if (force || !metaDirtyRef.current) {
          const nextBpm = next.bpm ?? 120;
          setLocalName(next.presetName ?? '');
          setLocalBpm(nextBpm);
          setLocalBpmText(String(nextBpm));
          setLocalTimeFlag(next.timeFlag ?? 0);
        }
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    client
      .getExperimentalState()
      .then((initial) => {
        if (cancelled || !initial) return;
        setAvailable(true);
        applyState(initial, { force: true });
        setSaveTargetSlot(initial.slot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, applyState, syncEpoch]);

  useEffect(() => {
    const timers = pendingTimers.current;
    const fns = pendingFns.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      fns.clear();
    };
  }, []);

  useEffect(() => {
    if (externalState) {
      setAvailable(true);
      applyState(externalState, { force: false });
    }
  }, [externalState, applyState]);

  const run = useCallback(async (task: () => Promise<void>) => {
    setWorking(true);
    setMessage(null);
    try {
      await task();
    } catch (err) {
      setMessage(
        err instanceof QuickToneApiError
          ? err.message
          : 'Não foi possível concluir a operação. Tente novamente.',
      );
    } finally {
      setWorking(false);
    }
  }, []);

  const scheduleThrottled = (
    key: string,
    fn: () => Promise<void>,
    delayMs = SEND_THROTTLE_MS,
  ): void => {
    const scheduledEpoch = editEpochRef.current;
    lastLocalEditAtRef.current = Date.now();
    const timers = pendingTimers.current;
    const fns = pendingFns.current;
    clearTimeout(timers.get(key));
    const wrapped = async (): Promise<void> => {
      if (editEpochRef.current !== scheduledEpoch) {
        return;
      }
      await fn();
    };
    fns.set(key, wrapped);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fns.delete(key);
        void wrapped().catch((err: unknown) => {
          if (editEpochRef.current !== scheduledEpoch) return;
          setMessage(
            err instanceof QuickToneApiError
              ? err.message
              : 'Não foi possível enviar o ajuste para a pedaleira. Tente novamente.',
          );
        });
      }, delayMs),
    );
  };

  const flushPendingParamEdits = useCallback(async (): Promise<void> => {
    const entries: Array<[string, () => Promise<void>]> = [];
    for (const [key, timer] of pendingTimers.current.entries()) {
      if (key === 'meta') continue;
      clearTimeout(timer);
      pendingTimers.current.delete(key);
      const fn = pendingFns.current.get(key);
      pendingFns.current.delete(key);
      if (fn) {
        entries.push([key, fn]);
      }
    }
    for (const [, fn] of entries) {
      await fn();
    }
  }, []);

  const handleDragStart = useCallback((): void => {
    isDraggingRef.current = true;
  }, []);

  const handleDragEnd = useCallback((): void => {
    isDraggingRef.current = false;
    lastLocalEditAtRef.current = Date.now();
  }, []);

  const sendMetaSerialized = useCallback(
    (payload: { presetName: string; bpm: number; timeFlag: number }, epoch: number): Promise<void> => {
      const prev = metaInFlightRef.current ?? Promise.resolve();
      const req = prev
        .catch(() => undefined)
        .then(async () => {
          if (editEpochRef.current !== epoch) {
            return;
          }
          const next = await client.setExperimentalMeta(payload);
          if (editEpochRef.current === epoch) {
            setState(next);
          }
        })
        .finally(() => {
          if (metaInFlightRef.current === req) {
            metaInFlightRef.current = null;
          }
        });
      metaInFlightRef.current = req;
      return req;
    },
    [client],
  );

  const flushMeta = useCallback(
    async (bpmOverride?: number): Promise<void> => {
      const pendingMeta = pendingTimers.current.get('meta');
      if (pendingMeta) {
        clearTimeout(pendingMeta);
        pendingTimers.current.delete('meta');
        pendingFns.current.delete('meta');
      }
      if (metaInFlightRef.current) {
        await metaInFlightRef.current;
      }
      if (!metaDirtyRef.current && bpmOverride === undefined && state) {
        return;
      }
      metaDirtyRef.current = false;
      const effectiveBpm = clampBpm(bpmOverride ?? localBpm);
      const epoch = editEpochRef.current;
      await sendMetaSerialized(
        {
          presetName: sanitizeMg300PresetName(localName, 'Preset'),
          bpm: effectiveBpm,
          timeFlag: localTimeFlag,
        },
        epoch,
      );
    },
    [localName, localBpm, localTimeFlag, state, sendMetaSerialized],
  );

  const flushMetaQuietly = useCallback(
    (bpmOverride?: number): void => {
      void flushMeta(bpmOverride).catch((err: unknown) => {
        setMessage(
          err instanceof QuickToneApiError
            ? err.message
            : 'Não foi possível atualizar nome ou BPM na pedaleira.',
        );
      });
    },
    [flushMeta],
  );

  const handleMetaChange = (nextName: string, nextBpm: number, nextTimeFlag: number): void => {
    metaDirtyRef.current = true;
    setLocalName(nextName);
    setLocalBpm(nextBpm);
    setLocalTimeFlag(nextTimeFlag);
    const clampedBpm = clampBpm(nextBpm);
    const epoch = editEpochRef.current;
    scheduleThrottled(
      'meta',
      async () => {
        metaDirtyRef.current = false;
        await sendMetaSerialized(
          {
            presetName: sanitizeMg300PresetName(nextName, 'Preset'),
            bpm: clampedBpm,
            timeFlag: nextTimeFlag,
          },
          epoch,
        );
      },
      META_DEBOUNCE_MS,
    );
  };

  const handleBpmInputChange = (raw: string): void => {
    setLocalBpmText(raw);
    const trimmed = raw.trim();
    if (trimmed === '') {
      metaDirtyRef.current = true;
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      handleMetaChange(localName, parsed, localTimeFlag);
    }
  };

  const handleBpmBlur = (): void => {
    const trimmed = localBpmText.trim();
    const parsed = trimmed === '' ? localBpm : Number(trimmed);
    const clamped = clampBpm(Number.isFinite(parsed) ? parsed : localBpm);
    setLocalBpm(clamped);
    setLocalBpmText(String(clamped));
    flushMetaQuietly(clamped);
  };

  const handleBlockParam = (blockId: number, index: number, value: number): void => {
    const key = String(blockId);
    setLocalBlockParams((prev) => {
      const current = prev[key] ?? [0, 0, 0, 0, 0, 0];
      return {
        ...prev,
        [key]: current.map((v, i) => (i === index ? value : v)),
      };
    });
    const scheduledEpoch = editEpochRef.current;
    scheduleThrottled(`b:${blockId}:${index}`, async () => {
      const next = await client.setExperimentalBlockParam(blockId, index, value);
      if (editEpochRef.current !== scheduledEpoch) return;
      setState(next);
      if (blockId === 7 && index === 0) {
        setLocalTimeFlag(next.timeFlag ?? 0);
      }
    });
  };

  const handleLevelChange = (
    target: 'patchVolume' | 'irVolume' | 'irCut',
    value: number,
  ): void => {
    if (target === 'patchVolume') setLocalPatchVol(value);
    if (target === 'irVolume') setLocalIrVol(value);
    if (target === 'irCut') setLocalIrCut(value);
    const scheduledEpoch = editEpochRef.current;
    scheduleThrottled(`lvl:${target}`, async () => {
      const next = await client.setExperimentalLevel(target, value);
      if (editEpochRef.current !== scheduledEpoch) return;
      setState(next);
    });
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size === 0 || file.size > MAX_CLIENT_UPLOAD_BYTES) {
      setMessage('Arquivo inválido ou maior que o limite de 512 KB.');
      return;
    }

    cancelPendingEdits();
    await run(async () => {
      const contentBase64 = await encodeFileToBase64(file);
      const res = await client.importNuxPresetFile({
        fileName: file.name,
        contentBase64,
      });
      applyState(res.state, { force: true });
      if (res.bundleSlots && res.bundleSlots.length > 1) {
        setBundleInfo({
          fileName: file.name,
          contentBase64,
          selectedIndex: res.selectedIndex,
          slots: res.bundleSlots,
        });
      } else {
        setBundleInfo(null);
      }
    });
  };

  const handleSelectBundlePreset = async (index: number): Promise<void> => {
    if (!bundleInfo) return;
    cancelPendingEdits();
    await run(async () => {
      const res = await client.importNuxPresetFile({
        fileName: bundleInfo.fileName,
        contentBase64: bundleInfo.contentBase64,
        bundleSlotIndex: index,
      });
      applyState(res.state, { force: true });
      setBundleInfo((prev) => (prev ? { ...prev, selectedIndex: index } : null));
    });
  };

  const handleConfirmSave = (confirmedSlot: number): void => {
    setSaveModalError(null);
    setWorking(true);
    setMessage(null);
    void (async () => {
      try {
        await flushPendingParamEdits();
        await flushMeta();
        await client.saveExperimentalSlot(confirmedSlot);
        setSaveModalOpen(false);
        setSaveModalError(null);
        const next = await client.getExperimentalState();
        if (next) applyState(next, { force: true });
      } catch (err) {
        const friendly =
          err instanceof QuickToneApiError
            ? err.message
            : 'Não foi possível gravar o preset na pedaleira. Tente novamente.';
        setSaveModalError(friendly);
        setMessage(friendly);
      } finally {
        setWorking(false);
      }
    })();
  };

  if (!available) return null;

  const loaded = state?.loaded ?? false;
  const isHardwareMode = (state?.sourceMode ?? 'hardware') === 'hardware';
  const locked = working || (disabled && isHardwareMode);
  const saveLocked = working || disabled;
  const lastSave = state?.lastSave;
  const loadSlotLabel = slotIndexToBankCoordinate(loadSlot).displayBank;

  const activeBlockMeta =
    typeof selectedTab === 'number' ? getMg300BlockCatalog(selectedTab) : undefined;
  const activeBlockKey = activeBlockMeta ? String(activeBlockMeta.id) : '';
  const activeModelId =
    activeBlockMeta !== undefined
      ? (localBlockModels[activeBlockKey] ?? state?.blockModels?.[activeBlockKey] ?? 0)
      : 0;
  const activeModelSpec =
    activeBlockMeta !== undefined && activeModelId > 0
      ? getMg300ModelSpec(activeBlockMeta.id, activeModelId)
      : undefined;
  const activeBlockValues =
    activeBlockMeta !== undefined
      ? (localBlockParams[activeBlockKey] ?? [0, 0, 0, 0, 0, 0])
      : [];
  const activeBlockEnabled = activeModelId > 0;
  const cabModelLocal = localBlockModels['9'] ?? state?.blockModels?.['9'] ?? 0;
  const sourceBadge = state ? getSourceBadge(state.sourceMode) : null;

  return (
    <section
      data-testid="experimental-edit-panel"
      aria-label="Editor completo de presets da NUX MG-300"
      className="rounded-md border border-white/[0.08] bg-[#14161A] p-3.5 sm:p-4"
    >
      {/* Cabeçalho e ações principais (Carregar, Novo Preset, Importar .nuxpreset) */}
      <div className="flex flex-col gap-3 border-b border-white/[0.06] pb-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#F3F4F6]">
              Editor de Presets · 10 Blocos
            </span>
            {sourceBadge && loaded ? (
              <span
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${sourceBadge.className}`}
              >
                {sourceBadge.text}
              </span>
            ) : null}
          </div>
          <p className="font-sans text-xs text-[#8E95A2]">
            Edite modelos e parâmetros ao vivo, crie novos presets ou importe arquivos .nuxpreset
            para salvar em qualquer slot 1A–9D.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
            <select
              data-testid="exp-load-slot-select"
              aria-label="Slot de Usuário para carregar"
              disabled={disabled || working}
              value={loadSlot}
              onChange={(e) => setLoadSlot(Number(e.target.value))}
              className="min-h-[44px] min-w-0 max-w-full flex-1 rounded border border-white/15 bg-[#090A0C] px-2.5 font-mono text-xs text-[#F3F4F6] tabular-nums disabled:opacity-40 sm:flex-none"
            >
              {MG300_USER_SLOTS.map((coord) => {
                const match = presets.find(
                  (p) => p.slotIndex === coord.slotIndex && p.bankType === 'user',
                );
                return (
                  <option key={coord.slotIndex} value={coord.slotIndex}>
                    {coord.displayBank}
                    {match ? ` · ${match.name}` : ''}
                  </option>
                );
              })}
            </select>

            <button
              type="button"
              data-testid="experimental-load-btn"
              className="min-h-[44px] max-w-full shrink-0 truncate rounded border border-white/15 bg-[#1B1E24] px-3.5 font-mono text-xs font-semibold text-[#F3F4F6] transition-colors duration-150 hover:border-white/30 disabled:opacity-40"
              disabled={disabled || working}
              onClick={() => {
                cancelPendingEdits();
                void run(async () => {
                  setBundleInfo(null);
                  const loadedState = await client.loadExperimentalSlot(loadSlot);
                  applyState(loadedState, { force: true });
                  setSaveTargetSlot(loadedState.slot);
                });
              }}
            >
              {loaded && isHardwareMode && state?.slot === loadSlot
                ? `Recarregar ${loadSlotLabel}${state?.presetName ? ` (${state.presetName})` : ''}`
                : `Carregar Slot ${loadSlotLabel}`}
            </button>
          </div>

          <button
            type="button"
            data-testid="exp-new-preset-btn"
            disabled={working}
            onClick={() => {
              cancelPendingEdits();
              void run(async () => {
                setBundleInfo(null);
                const next = await client.createNewExperimentalPreset({
                  presetName: 'New Preset',
                  targetSlot: loadSlot,
                });
                applyState(next, { force: true });
                setSaveTargetSlot(next.slot);
              });
            }}
            className="min-h-[44px] shrink-0 rounded border border-white/15 bg-[#090A0C] px-3.5 font-mono text-xs font-semibold text-[#F3F4F6] transition-colors duration-150 hover:border-white/30 disabled:opacity-40"
          >
            Novo Preset
          </button>

          <input
            ref={fileInputRef}
            data-testid="exp-import-input"
            type="file"
            accept=".nuxpreset"
            className="hidden"
            onChange={(e) => void handleImportFile(e)}
          />
          <button
            type="button"
            data-testid="exp-import-btn"
            disabled={working}
            onClick={() => fileInputRef.current?.click()}
            className="min-h-[44px] shrink-0 rounded border border-white/15 bg-[#090A0C] px-3.5 font-mono text-xs font-semibold text-[#F3F4F6] transition-colors duration-150 hover:border-white/30 disabled:opacity-40"
          >
            Importar .nuxpreset
          </button>
        </div>
      </div>

      {loaded ? (
        <div className="mt-3.5 flex flex-col gap-3.5">
          {/* Seletor extra quando usuário importa bundle com 36 presets */}
          {bundleInfo && bundleInfo.slots.length > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-white/[0.08] bg-[#090A0C] p-2.5">
              <span className="font-mono text-xs text-[#8E95A2]">
                Pacote {bundleInfo.fileName} ({bundleInfo.slots.length} presets):
              </span>
              <select
                data-testid="exp-bundle-slot-select"
                aria-label="Selecionar preset do pacote importado"
                disabled={working}
                value={bundleInfo.selectedIndex}
                onChange={(e) => void handleSelectBundlePreset(Number(e.target.value))}
                className="min-h-[44px] max-w-full rounded border border-white/15 bg-[#14161A] px-2.5 font-mono text-xs text-[#F3F4F6]"
              >
                {bundleInfo.slots.map((entry) => (
                  <option key={entry.index} value={entry.index}>
                    {entry.displayBank} · {entry.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* Metadados do Preset: Nome (1..18 chars MG300) + BPM + Sync */}
          <div className="grid grid-cols-1 gap-2.5 rounded border border-white/[0.08] bg-[#090A0C] p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] uppercase tracking-wide text-[#8E95A2]">
                Nome do Preset (máx. 18 caracteres)
              </span>
              <input
                data-testid="exp-preset-name-input"
                type="text"
                maxLength={18}
                disabled={locked}
                value={localName}
                onChange={(e) => handleMetaChange(e.target.value, localBpm, localTimeFlag)}
                onBlur={() => flushMetaQuietly()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Ex.: Solo Clean"
                className="min-h-[44px] rounded border border-white/15 bg-[#14161A] px-3 font-mono text-xs text-[#F3F4F6]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] uppercase tracking-wide text-[#8E95A2]">
                BPM (40–240)
              </span>
              <input
                data-testid="exp-bpm-input"
                type="number"
                min={40}
                max={240}
                disabled={locked}
                value={localBpmText}
                onChange={(e) => handleBpmInputChange(e.target.value)}
                onBlur={handleBpmBlur}
                className="min-h-[44px] w-full rounded border border-white/15 bg-[#14161A] px-3 font-mono text-xs text-[#F3F4F6] tabular-nums sm:w-24"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="font-mono text-[11px] uppercase tracking-wide text-[#8E95A2]">
                Tempo Delay
              </span>
              <button
                type="button"
                data-testid="exp-time-flag-btn"
                aria-pressed={localTimeFlag === 1}
                disabled={locked}
                onClick={() => {
                  const nextFlag = localTimeFlag === 1 ? 0 : 1;
                  handleMetaChange(localName, localBpm, nextFlag);
                }}
                className={`min-h-[44px] rounded border px-3 font-mono text-xs font-semibold transition-colors duration-150 ${
                  localTimeFlag === 1
                    ? 'border-[#F59E0B]/60 bg-[#1B1710] text-[#F59E0B]'
                    : 'border-white/15 bg-[#14161A] text-[#8E95A2] hover:text-[#F3F4F6]'
                }`}
              >
                {localTimeFlag === 1 ? 'Sync BPM' : 'Livre (ms)'}
              </button>
            </div>
          </div>

          {state?.userIrWarning ? (
            <div
              data-testid="exp-user-ir-warning"
              className="rounded border border-[#F59E0B]/40 bg-[#1B1710] px-3 py-2 font-sans text-xs text-[#FCD34D]"
              role="note"
            >
              {state.userIrWarning}
            </div>
          ) : null}

          {/* Cadeia completa de 10 blocos + Níveis */}
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-11">
            {MG300_BLOCK_CATALOG.map((block) => {
              const modelId =
                localBlockModels[String(block.id)] ??
                state?.blockModels?.[String(block.id)] ??
                0;
              const isOn = modelId > 0;
              const isSelected = selectedTab === block.id;
              return (
                <button
                  key={block.id}
                  type="button"
                  data-testid={`exp-select-block-${block.code}`}
                  aria-pressed={isSelected}
                  disabled={locked}
                  onClick={() => setSelectedTab(block.id)}
                  className={`flex min-h-[48px] flex-col items-center justify-center rounded border px-1.5 py-1 font-mono text-[11px] font-semibold transition-colors duration-150 disabled:opacity-40 ${
                    isSelected
                      ? 'border-[#F59E0B]/70 bg-[#1B1710] text-[#F3F4F6]'
                      : 'border-white/[0.08] bg-[#090A0C] text-[#8E95A2] hover:border-white/20 hover:text-[#F3F4F6]'
                  }`}
                >
                  <span>{block.label}</span>
                  <span
                    className={`mt-1 h-1 w-4 rounded-full ${
                      isOn ? 'bg-[#22C55E]' : 'bg-white/15'
                    }`}
                  />
                </button>
              );
            })}

            <button
              type="button"
              data-testid="exp-select-levels"
              aria-pressed={selectedTab === 'levels'}
              disabled={locked}
              onClick={() => setSelectedTab('levels')}
              className={`flex min-h-[48px] flex-col items-center justify-center rounded border px-1.5 py-1 font-mono text-[11px] font-semibold transition-colors duration-150 disabled:opacity-40 ${
                selectedTab === 'levels'
                  ? 'border-[#F59E0B]/70 bg-[#1B1710] text-[#F3F4F6]'
                  : 'border-white/[0.08] bg-[#090A0C] text-[#8E95A2] hover:border-white/20 hover:text-[#F3F4F6]'
              }`}
            >
              <span>NÍVEIS</span>
              <span className="mt-0.5 font-mono text-[9px] text-[#8E95A2] tabular-nums">
                {localPatchVol}%
              </span>
            </button>
          </div>

          {/* Inspetor do bloco selecionado ou painel de níveis */}
          {activeBlockMeta ? (
            <ExperimentalBlockInspector
              block={activeBlockMeta}
              modelId={activeModelId}
              modelSpec={activeModelSpec}
              values={activeBlockValues}
              cabEnabled={cabModelLocal > 0}
              irVolume={localIrVol}
              irCut={localIrCut}
              disabled={locked}
              onToggleBlock={() => {
                cancelPendingParamEdits();
                void run(async () => {
                  if (metaDirtyRef.current) {
                    await flushMeta();
                  }
                  const next = await client.setExperimentalBlock(
                    activeBlockMeta.id,
                    !activeBlockEnabled,
                  );
                  applyState(next, { force: true });
                });
              }}
              onChangeModel={(nextModel) => {
                const previousModels = { ...localBlockModels };
                cancelPendingParamEdits();
                setLocalBlockModels((prev) => ({
                  ...prev,
                  [activeBlockKey]: nextModel,
                }));
                void run(async () => {
                  try {
                    if (metaDirtyRef.current) {
                      await flushMeta();
                    }
                    const next = await client.setExperimentalBlockModel(
                      activeBlockMeta.id,
                      nextModel,
                    );
                    applyState(next, { force: true });
                  } catch (err) {
                    setLocalBlockModels(previousModels);
                    throw err;
                  }
                });
              }}
              onChangeParam={(paramIndex, value) =>
                handleBlockParam(activeBlockMeta.id, paramIndex, value)
              }
              onChangeLevel={(target, value) => handleLevelChange(target, value)}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
          ) : (
            <ExperimentalLevelsPanel
              patchVolume={localPatchVol}
              irVolume={localIrVol}
              irCut={localIrCut}
              disabled={locked}
              onChangeLevel={handleLevelChange}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
          )}

          {/* Barra inferior de gravação permanente em slots de Usuário (1A..9D) */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
            <span className="font-sans text-xs text-[#8E95A2]">
              {state?.dirty
                ? 'Alterações pendentes — grave em um slot 1A–9D para persistir na pedaleira.'
                : `Sincronizado com o slot ${slotIndexToBankCoordinate(state?.slot ?? 15).displayBank}.`}
            </span>

            <button
              type="button"
              data-testid="exp-save-btn"
              disabled={saveLocked}
              onClick={() => {
                flushMetaQuietly();
                setSaveModalError(null);
                setSaveTargetSlot(state?.slot ?? MG300_EXPERIMENTAL_SLOT);
                setSaveModalOpen(true);
              }}
              className="min-h-[44px] rounded border border-[#F59E0B]/50 bg-[#1B1710] px-4 font-mono text-xs font-semibold text-[#F59E0B] transition-colors duration-150 hover:border-[#F59E0B] disabled:opacity-40"
            >
              Gravar na Pedaleira (1A–9D)
            </button>
          </div>
        </div>
      ) : null}

      <SavePresetModal
        isOpen={saveModalOpen}
        targetSlot={saveTargetSlot}
        presetName={localName || state?.presetName || 'New Preset'}
        bpm={localBpm}
        hasUserIr={state?.hasUserIr ?? false}
        userIrName={state?.userIrName ?? null}
        presets={presets}
        saving={working}
        error={saveModalError}
        onChangeTargetSlot={(slot) => {
          setSaveModalError(null);
          setSaveTargetSlot(slot);
        }}
        onClose={() => {
          setSaveModalError(null);
          setSaveModalOpen(false);
        }}
        onConfirm={handleConfirmSave}
      />

      {lastSave ? (
        <p className="mt-2.5 font-mono text-[11px] text-[#8E95A2] tabular-nums" role="status">
          {lastSave.verified
            ? `Última gravação no slot ${lastSave.displayBank}: salva e confirmada com sucesso.`
            : lastSave.ackReceived
              ? `Última gravação no slot ${lastSave.displayBank}: a pedaleira salvou, mas alguns ajustes não conferiram na verificação.`
              : `Última gravação no slot ${lastSave.displayBank}: a pedaleira não confirmou a gravação. Tente novamente.`}
        </p>
      ) : null}
      {message && !saveModalOpen ? (
        <p className="mt-2 font-sans text-xs text-[#EF4444]" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}
