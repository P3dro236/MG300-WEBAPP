import {
  type Preset,
  PresetSchema,
  filterVisibleLibraryPresets,
  isPlaceholderPreset,
} from '@quicktone/shared';

export const APP_STORAGE_KEY = 'mg300_webapp_storage_v1';
export const APP_STORAGE_VERSION = 1;

export type StoredPresetFilter = 'user' | 'factory';
export type StoredViewMode = 'stage' | 'matrix';

export interface StoredPreferences {
  filter: StoredPresetFilter;
  viewMode: StoredViewMode;
  lastVolume?: number;
}

export interface PersistedAppData {
  version: number;
  updatedAt: string;
  presets: Preset[];
  preferences: StoredPreferences;
}

function getDefaultViewMode(): StoredViewMode {
  if (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 640) {
    return 'stage';
  }
  return 'matrix';
}

export function createDefaultPersistedData(): PersistedAppData {
  return {
    version: APP_STORAGE_VERSION,
    updatedAt: new Date().toISOString(),
    presets: [],
    preferences: {
      filter: 'user',
      viewMode: getDefaultViewMode(),
    },
  };
}

function sanitizePreferences(raw: unknown, fallback: StoredPreferences): StoredPreferences {
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  const filter: StoredPresetFilter =
    obj.filter === 'factory' || obj.filter === 'user' ? obj.filter : fallback.filter;
  const viewMode: StoredViewMode =
    obj.viewMode === 'stage' || obj.viewMode === 'matrix'
      ? obj.viewMode
      : fallback.viewMode;
  const lastVolume =
    typeof obj.lastVolume === 'number' &&
    Number.isFinite(obj.lastVolume) &&
    obj.lastVolume >= 0 &&
    obj.lastVolume <= 100
      ? Math.round(obj.lastVolume)
      : fallback.lastVolume;

  return {
    filter,
    viewMode,
    ...(lastVolume !== undefined ? { lastVolume } : {}),
  };
}

function sanitizePresetsArray(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const valid: Preset[] = [];
  for (const item of raw) {
    const parsed = PresetSchema.safeParse(item);
    if (parsed.success && !isPlaceholderPreset(parsed.data)) {
      valid.push(parsed.data);
    }
  }
  return filterVisibleLibraryPresets(valid).sort((a, b) => a.slotIndex - b.slotIndex);
}

/**
 * Loads versioned presets and UI preferences from localStorage without losing valid data
 * if individual entries or the JSON payload are partially corrupted.
 */
export function loadPersistedAppData(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): PersistedAppData {
  const defaults = createDefaultPersistedData();
  if (!storage) {
    return defaults;
  }

  let rawText: string | null = null;
  try {
    rawText = storage.getItem(APP_STORAGE_KEY);
  } catch {
    return defaults;
  }

  if (!rawText) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return defaults;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.version === 'number' && obj.version > APP_STORAGE_VERSION) {
      return defaults;
    }

    const presets = sanitizePresetsArray(obj.presets);
    const preferences = sanitizePreferences(obj.preferences, defaults.preferences);
    const updatedAt =
      typeof obj.updatedAt === 'string' && obj.updatedAt.length > 0
        ? obj.updatedAt
        : defaults.updatedAt;

    return {
      version: APP_STORAGE_VERSION,
      updatedAt,
      presets,
      preferences,
    };
  } catch {
    return defaults;
  }
}

export function savePersistedAppData(
  data: PersistedAppData,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    const payload: PersistedAppData = {
      version: APP_STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      presets: sanitizePresetsArray(data.presets),
      preferences: sanitizePreferences(
        data.preferences,
        createDefaultPersistedData().preferences,
      ),
    };
    storage.setItem(APP_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges incoming server/hardware presets with locally stored presets.
 * Never overwrites valid stored presets with an empty or placeholder-only response.
 */
export function mergePresetsSafely(
  existing: readonly Preset[],
  incoming: readonly Preset[],
): Preset[] {
  const cleanExisting = filterVisibleLibraryPresets(
    existing.filter((p) => !isPlaceholderPreset(p)),
  );
  const cleanIncoming = filterVisibleLibraryPresets(
    incoming.filter((p) => !isPlaceholderPreset(p)),
  );

  if (cleanIncoming.length === 0) {
    return [...cleanExisting].sort((a, b) => a.slotIndex - b.slotIndex);
  }

  const bySlot = new Map<number, Preset>();
  for (const preset of cleanExisting) {
    bySlot.set(preset.slotIndex, preset);
  }
  for (const preset of cleanIncoming) {
    bySlot.set(preset.slotIndex, preset);
  }

  return filterVisibleLibraryPresets(Array.from(bySlot.values())).sort(
    (a, b) => a.slotIndex - b.slotIndex,
  );
}
