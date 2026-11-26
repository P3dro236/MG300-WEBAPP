import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MG300_EXPERIMENTAL_SLOT,
  MG300_USER_SLOT_MAX,
  MG300_USER_SLOT_MIN,
  sanitizeMg300PresetName,
} from '@quicktone/shared';
import {
  type ExperimentalEditState,
  type ExperimentalImportBundleSlot,
  type QuickToneApiClient,
  QuickToneApiError,
} from '../api/client';

const SEND_THROTTLE_MS = 35;
const META_DEBOUNCE_MS = 300;
const LOCAL_ECHO_GUARD_MS = 400;
const MAX_CLIENT_UPLOAD_BYTES = 512 * 1024;

function clampUserSlot(slotIndex: number): number {
  if (
    Number.isInteger(slotIndex) &&
    slotIndex >= MG300_USER_SLOT_MIN &&
    slotIndex <= MG300_USER_SLOT_MAX
  ) {
    return slotIndex;
  }
  return MG300_EXPERIMENTAL_SLOT;
}

function clampBpm(value: number): number {
  return Math.max(40, Math.min(240, Math.round(Number.isFinite(value) ? value : 120)));
}

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

export interface BundleImportInfo {
  fileName: string;
  contentBase64: string;
  selectedIndex: number;
  slots: ExperimentalImportBundleSlot[];
}

export interface UseToneEditorSessionOptions {
  client: QuickToneApiClient;
  isAuthorized: boolean;
  syncEpoch: number;
  subscribeExperimentalSync: (listener: (state: ExperimentalEditState) => void) => () => void;
}

export function useToneEditorSession({
  client,
  isAuthorized,
  syncEpoch,
  subscribeExperimentalSync,
}: UseToneEditorSessionOptions) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<ExperimentalEditState | null>(null);
  const [localBlockModels, setLocalBlockModels] = useState<Record<string, number>>({});
  const [localBlockParams, setLocalBlockParams] = useState<Record<string, number[]>>({});
  const [localName, setLocalName] = useState('');
  const [localBpm, setLocalBpm] = useState(120);
  const [localBpmText, setLocalBpmText] = useState('120');
  const [localTimeFlag, setLocalTimeFlag] = useState(0);
  const [localPatchVol, setLocalPatchVol] = useState(50);
  const [localIrVol, setLocalIrVol] = useState(20);
  const [localIrCut, setLocalIrCut] = useState(0);
  const [bundleInfo, setBundleInfo] = useState<BundleImportInfo | null>(null);
  const [bundleItemDirty, setBundleItemDirty] = useState(false);
  const [hasPendingEdits, setHasPendingEdits] = useState(false);
  const [metaDirty, setMetaDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingFns = useRef(new Map<string, () => Promise<void>>());
  const isDraggingRef = useRef(false);
  const lastLocalEditAtRef = useRef(0);
  const metaDirtyRef = useRef(false);
  const metaVersionRef = useRef(0);
  const metaInFlightRef = useRef<Promise<void> | null>(null);
  const editEpochRef = useRef(0);
  const hasInitialLoadRef = useRef(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const bundleInfoRef = useRef(bundleInfo);
  bundleInfoRef.current = bundleInfo;
  const localBlockModelsRef = useRef(localBlockModels);
  localBlockModelsRef.current = localBlockModels;

  const cancelPendingEdits = useCallback((): void => {
    editEpochRef.current += 1;
    metaVersionRef.current += 1;
    for (const timer of pendingTimers.current.values()) {
      clearTimeout(timer);
    }
    pendingTimers.current.clear();
    pendingFns.current.clear();
    isDraggingRef.current = false;
    lastLocalEditAtRef.current = 0;
    metaDirtyRef.current = false;
    setHasPendingEdits(false);
    setMetaDirty(false);
    setBundleItemDirty(false);
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
    setHasPendingEdits(pendingTimers.current.size > 0);
  }, []);

  const applyState = useCallback(
    (next: ExperimentalEditState, options: { force?: boolean } = {}) => {
      const force = options.force ?? true;
      setState(next);

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
    if (!isAuthorized) return;
    let cancelled = false;
    const force = !hasInitialLoadRef.current && syncEpoch === 0;
    client
      .getExperimentalState()
      .then((initial) => {
        if (cancelled || !initial) return;
        hasInitialLoadRef.current = true;
        setAvailable(true);
        applyState(initial, { force });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, isAuthorized, applyState, syncEpoch]);

  useEffect(() => {
    return subscribeExperimentalSync((synced) => {
      setAvailable(true);
      applyState(synced, { force: false });
    });
  }, [subscribeExperimentalSync, applyState]);

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

  const isDirty = Boolean(state?.loaded && (state.dirty || metaDirty || hasPendingEdits));

  useEffect(() => {
    if (!isDirty || typeof window === 'undefined') {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

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
      throw err;
    } finally {
      setWorking(false);
    }
  }, []);

  const scheduleThrottled = useCallback(
    (key: string, fn: () => Promise<void>, delayMs = SEND_THROTTLE_MS): void => {
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
      setHasPendingEdits(true);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fns.delete(key);
          setHasPendingEdits(timers.size > 0);
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
    },
    [],
  );

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
    setHasPendingEdits(pendingTimers.current.size > 0);
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
          if (editEpochRef.current !== epoch) return;
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
        setHasPendingEdits(pendingTimers.current.size > 0);
      }
      if (metaInFlightRef.current) {
        await metaInFlightRef.current;
      }
      if (!metaDirtyRef.current && bpmOverride === undefined && stateRef.current) {
        return;
      }
      const capturedVersion = metaVersionRef.current;
      const effectiveBpm = clampBpm(bpmOverride ?? localBpm);
      const epoch = editEpochRef.current;
      await sendMetaSerialized(
        {
          presetName: sanitizeMg300PresetName(localName, 'Timbre'),
          bpm: effectiveBpm,
          timeFlag: localTimeFlag,
        },
        epoch,
      );
      if (editEpochRef.current === epoch && metaVersionRef.current === capturedVersion) {
        metaDirtyRef.current = false;
        setMetaDirty(false);
      }
    },
    [localName, localBpm, localTimeFlag, sendMetaSerialized],
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

  const handleMetaChange = useCallback(
    (nextName: string, nextBpm: number, nextTimeFlag: number): void => {
      metaVersionRef.current += 1;
      const capturedVersion = metaVersionRef.current;
      metaDirtyRef.current = true;
      setMetaDirty(true);
      if (bundleInfoRef.current) {
        setBundleItemDirty(true);
      }
      setLocalName(nextName);
      setLocalBpm(nextBpm);
      setLocalTimeFlag(nextTimeFlag);
      const clampedBpm = clampBpm(nextBpm);
      const epoch = editEpochRef.current;
      scheduleThrottled(
        'meta',
        async () => {
          await sendMetaSerialized(
            {
              presetName: sanitizeMg300PresetName(nextName, 'Timbre'),
              bpm: clampedBpm,
              timeFlag: nextTimeFlag,
            },
            epoch,
          );
          if (editEpochRef.current === epoch && metaVersionRef.current === capturedVersion) {
            metaDirtyRef.current = false;
            setMetaDirty(false);
          }
        },
        META_DEBOUNCE_MS,
      );
    },
    [scheduleThrottled, sendMetaSerialized],
  );

  const handleBpmInputChange = useCallback(
    (raw: string): void => {
      setLocalBpmText(raw);
      const trimmed = raw.trim();
      if (trimmed === '') {
        metaVersionRef.current += 1;
        metaDirtyRef.current = true;
        setMetaDirty(true);
        if (bundleInfoRef.current) {
          setBundleItemDirty(true);
        }
        return;
      }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        handleMetaChange(localName, parsed, localTimeFlag);
      }
    },
    [handleMetaChange, localName, localTimeFlag],
  );

  const handleBpmBlur = useCallback((): void => {
    const trimmed = localBpmText.trim();
    const parsed = trimmed === '' ? localBpm : Number(trimmed);
    const clamped = clampBpm(Number.isFinite(parsed) ? parsed : localBpm);
    setLocalBpm(clamped);
    setLocalBpmText(String(clamped));
    flushMetaQuietly(clamped);
  }, [localBpmText, localBpm, flushMetaQuietly]);

  const loadSlot = useCallback(
    async (slotIndex: number): Promise<void> => {
      const targetSlot = clampUserSlot(slotIndex);
      cancelPendingEdits();
      setAvailable(true);
      await run(async () => {
        setBundleInfo(null);
        const loadedState = await client.loadExperimentalSlot(targetSlot);
        applyState(loadedState, { force: true });
      }).catch(() => undefined);
    },
    [client, cancelPendingEdits, run, applyState],
  );

  const createNewTone = useCallback(
    async (targetSlot?: number): Promise<void> => {
      const safeSlot = clampUserSlot(
        targetSlot ?? stateRef.current?.slot ?? MG300_EXPERIMENTAL_SLOT,
      );
      cancelPendingEdits();
      setAvailable(true);
      await run(async () => {
        setBundleInfo(null);
        const next = await client.createNewExperimentalPreset({
          presetName: 'Novo Timbre',
          targetSlot: safeSlot,
        });
        applyState(next, { force: true });
      }).catch(() => undefined);
    },
    [client, cancelPendingEdits, run, applyState],
  );

  const importNuxPresetFile = useCallback(
    async (file: File): Promise<void> => {
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
        setBundleItemDirty(false);
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
      }).catch(() => undefined);
    },
    [client, cancelPendingEdits, run, applyState],
  );

  const selectBundlePreset = useCallback(
    async (index: number): Promise<void> => {
      const activeBundle = bundleInfoRef.current;
      if (!activeBundle) return;
      cancelPendingEdits();
      await run(async () => {
        const res = await client.importNuxPresetFile({
          fileName: activeBundle.fileName,
          contentBase64: activeBundle.contentBase64,
          bundleSlotIndex: index,
        });
        applyState(res.state, { force: true });
        setBundleItemDirty(false);
        setBundleInfo((prev) => (prev ? { ...prev, selectedIndex: index } : null));
      }).catch(() => undefined);
    },
    [client, cancelPendingEdits, run, applyState],
  );

  const toggleBlock = useCallback(
    (blockId: number, currentlyEnabled: boolean): void => {
      cancelPendingParamEdits();
      if (bundleInfoRef.current) {
        setBundleItemDirty(true);
      }
      void run(async () => {
        if (metaDirtyRef.current) {
          await flushMeta();
        }
        const next = await client.setExperimentalBlock(blockId, !currentlyEnabled);
        applyState(next, { force: true });
      }).catch(() => undefined);
    },
    [client, cancelPendingParamEdits, run, flushMeta, applyState],
  );

  const changeBlockModel = useCallback(
    (blockId: number, nextModel: number): void => {
      const key = String(blockId);
      const previousModel =
        localBlockModelsRef.current[key] ?? stateRef.current?.blockModels?.[key] ?? 0;
      cancelPendingParamEdits();
      if (bundleInfoRef.current) {
        setBundleItemDirty(true);
      }
      setLocalBlockModels((prev) => ({
        ...prev,
        [key]: nextModel,
      }));
      void run(async () => {
        try {
          if (metaDirtyRef.current) {
            await flushMeta();
          }
          const next = await client.setExperimentalBlockModel(blockId, nextModel);
          applyState(next, { force: true });
        } catch (err) {
          setLocalBlockModels((prev) => ({
            ...prev,
            [key]: previousModel,
          }));
          throw err;
        }
      }).catch(() => undefined);
    },
    [client, cancelPendingParamEdits, run, flushMeta, applyState],
  );

  const handleBlockParam = useCallback(
    (blockId: number, index: number, value: number): void => {
      const key = String(blockId);
      if (bundleInfoRef.current) {
        setBundleItemDirty(true);
      }
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
    },
    [client, scheduleThrottled],
  );

  const handleLevelChange = useCallback(
    (target: 'patchVolume' | 'irVolume' | 'irCut', value: number): void => {
      if (bundleInfoRef.current) {
        setBundleItemDirty(true);
      }
      if (target === 'patchVolume') setLocalPatchVol(value);
      if (target === 'irVolume') setLocalIrVol(value);
      if (target === 'irCut') setLocalIrCut(value);
      const scheduledEpoch = editEpochRef.current;
      scheduleThrottled(`lvl:${target}`, async () => {
        const next = await client.setExperimentalLevel(target, value);
        if (editEpochRef.current !== scheduledEpoch) return;
        setState(next);
      });
    },
    [client, scheduleThrottled],
  );

  const confirmSave = useCallback(
    async (confirmedSlot: number): Promise<boolean> => {
      const safeSlot = clampUserSlot(confirmedSlot);
      setWorking(true);
      setMessage(null);
      try {
        await flushPendingParamEdits();
        await flushMeta();
        await client.saveExperimentalSlot(safeSlot);
        const next = await client.getExperimentalState();
        if (next) applyState(next, { force: true });
        setBundleItemDirty(false);
        return true;
      } catch (err) {
        setMessage(
          err instanceof QuickToneApiError
            ? err.message
            : 'Não foi possível salvar o timbre na pedaleira. Tente novamente.',
        );
        return false;
      } finally {
        setWorking(false);
      }
    },
    [client, flushPendingParamEdits, flushMeta, applyState],
  );

  const discardAndReset = useCallback(
    async (midiConnected: boolean): Promise<void> => {
      cancelPendingEdits();
      const currentState = stateRef.current;
      if (currentState?.loaded && currentState.sourceMode === 'hardware' && midiConnected) {
        const targetSlot = clampUserSlot(currentState.slot);
        try {
          setBundleInfo(null);
          const reloaded = await client.loadExperimentalSlot(targetSlot);
          applyState(reloaded, { force: true });
          if (!reloaded.dirty) {
            return;
          }
        } catch {
          // Fall through to discard endpoint / local reset
        }
      }

      setBundleInfo(null);
      try {
        const cleared = await client.discardExperimentalEdit();
        applyState(cleared, { force: true });
      } catch {
        setState((prev) =>
          prev
            ? {
                ...prev,
                loaded: false,
                dirty: false,
              }
            : null,
        );
      }
    },
    [cancelPendingEdits, client, applyState],
  );

  const clearError = useCallback(() => setMessage(null), []);

  return {
    available,
    state,
    isDirty,
    bundleItemDirty,
    localBlockModels,
    localBlockParams,
    localName,
    localBpm,
    localBpmText,
    localTimeFlag,
    localPatchVol,
    localIrVol,
    localIrCut,
    bundleInfo,
    message,
    working,
    clearError,
    cancelPendingEdits,
    discardAndReset,
    loadSlot,
    createNewTone,
    importNuxPresetFile,
    selectBundlePreset,
    toggleBlock,
    changeBlockModel,
    handleBlockParam,
    handleLevelChange,
    handleMetaChange,
    handleBpmInputChange,
    handleBpmBlur,
    flushMetaQuietly,
    handleDragStart,
    handleDragEnd,
    confirmSave,
  };
}

export type ToneEditorSession = ReturnType<typeof useToneEditorSession>;
