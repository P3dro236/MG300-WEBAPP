import { z } from 'zod';
import { type Preset, PresetSchema } from './contracts.js';
import { filterVisibleLibraryPresets, isPlaceholderPreset } from './mg300-protocol.js';

export const LEGACY_STORAGE_KEY_V1 = 'mg300_webapp_storage_v1' as const;
export const TARGET_STORAGE_KEY_V2 = 'mgcontrol_storage_v2' as const;

export const PersistedPreferencesV2Schema = z.object({
  filter: z.enum(['user', 'factory']).default('user'),
  viewMode: z.enum(['stage', 'matrix']).default('matrix'),
  lastVolume: z.number().int().min(0).max(100).optional(),
});
export type PersistedPreferencesV2 = z.infer<typeof PersistedPreferencesV2Schema>;

export const PersistedAppDataV2Schema = z.object({
  version: z.literal(2),
  migratedFromVersion: z.number().int().positive().optional(),
  updatedAt: z.string().trim().min(1),
  presets: z.array(PresetSchema),
  preferences: PersistedPreferencesV2Schema,
});
export type PersistedAppDataV2 = z.infer<typeof PersistedAppDataV2Schema>;

export interface LocalStorageMigrationReport {
  data: PersistedAppDataV2;
  preservedPresets: number;
  droppedCorruptEntries: number;
  droppedPlaceholders: number;
  warnings: string[];
  sourceUntouched: true;
}

function sanitizePresetsNonDestructive(rawPresets: unknown): {
  presets: Preset[];
  droppedCorruptEntries: number;
  droppedPlaceholders: number;
} {
  if (!Array.isArray(rawPresets)) {
    return {
      presets: [],
      droppedCorruptEntries: rawPresets === undefined ? 0 : 1,
      droppedPlaceholders: 0,
    };
  }

  let droppedCorruptEntries = 0;
  let droppedPlaceholders = 0;
  const valid: Preset[] = [];

  for (const item of rawPresets) {
    const parsed = PresetSchema.safeParse(item);
    if (!parsed.success) {
      droppedCorruptEntries += 1;
      continue;
    }
    if (isPlaceholderPreset(parsed.data)) {
      droppedPlaceholders += 1;
      continue;
    }
    valid.push(parsed.data);
  }

  const visible = filterVisibleLibraryPresets(valid).sort((a, b) => a.slotIndex - b.slotIndex);
  return {
    presets: visible,
    droppedCorruptEntries,
    droppedPlaceholders,
  };
}

function sanitizePreferences(rawPrefs: unknown): PersistedPreferencesV2 {
  const defaults: PersistedPreferencesV2 = {
    filter: 'user',
    viewMode: 'matrix',
  };
  if (!rawPrefs || typeof rawPrefs !== 'object') {
    return defaults;
  }

  const obj = rawPrefs as Record<string, unknown>;
  const filter = obj.filter === 'factory' || obj.filter === 'user' ? obj.filter : 'user';
  const viewMode = obj.viewMode === 'stage' || obj.viewMode === 'matrix' ? obj.viewMode : 'matrix';
  const lastVolume =
    typeof obj.lastVolume === 'number' &&
    Number.isFinite(obj.lastVolume) &&
    obj.lastVolume >= 0 &&
    obj.lastVolume <= 100
      ? Math.round(obj.lastVolume)
      : undefined;

  return {
    filter,
    viewMode,
    ...(lastVolume !== undefined ? { lastVolume } : {}),
  };
}

/**
 * Pure non-destructive transformer from legacy browser `mg300_webapp_storage_v1`
 * (or already-migrated v2) JSON payload into validated `PersistedAppDataV2`.
 */
export function migrateLocalStoragePayloadV1ToV2(
  rawJson: string | null | undefined,
  nowIso: string = new Date().toISOString(),
): LocalStorageMigrationReport {
  const warnings: string[] = [];
  const emptyData: PersistedAppDataV2 = PersistedAppDataV2Schema.parse({
    version: 2,
    updatedAt: nowIso.trim() || new Date().toISOString(),
    presets: [],
    preferences: { filter: 'user', viewMode: 'matrix' },
  });

  if (!rawJson || !rawJson.trim()) {
    return {
      data: emptyData,
      preservedPresets: 0,
      droppedCorruptEntries: 0,
      droppedPlaceholders: 0,
      warnings,
      sourceUntouched: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    warnings.push('Payload JSON legado inválido; retornando estado v2 limpo.');
    return {
      data: emptyData,
      preservedPresets: 0,
      droppedCorruptEntries: 1,
      droppedPlaceholders: 0,
      warnings,
      sourceUntouched: true,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push('Estrutura raiz legada inválida; retornando estado v2 limpo.');
    return {
      data: emptyData,
      preservedPresets: 0,
      droppedCorruptEntries: 1,
      droppedPlaceholders: 0,
      warnings,
      sourceUntouched: true,
    };
  }

  const record = parsed as Record<string, unknown>;
  const rawVersion = typeof record.version === 'number' ? record.version : 1;
  if (rawVersion > 2) {
    warnings.push(`Versão futura (${rawVersion}) detectada; preservando estrutura padrão v2.`);
    return {
      data: emptyData,
      preservedPresets: 0,
      droppedCorruptEntries: 0,
      droppedPlaceholders: 0,
      warnings,
      sourceUntouched: true,
    };
  }

  const presetScan = sanitizePresetsNonDestructive(record.presets);
  const preferences = sanitizePreferences(record.preferences);
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.trim().length > 0
      ? record.updatedAt.trim()
      : emptyData.updatedAt;

  if (presetScan.droppedCorruptEntries > 0) {
    warnings.push(
      `${presetScan.droppedCorruptEntries} entrada(s) corrompida(s) descartada(s) durante a migração.`,
    );
  }

  const validMigratedFromVersion =
    rawVersion === 2 &&
    typeof record.migratedFromVersion === 'number' &&
    Number.isInteger(record.migratedFromVersion) &&
    record.migratedFromVersion > 0
      ? record.migratedFromVersion
      : undefined;

  const migrated = PersistedAppDataV2Schema.parse({
    version: 2,
    ...(rawVersion === 1
      ? { migratedFromVersion: 1 }
      : validMigratedFromVersion !== undefined
        ? { migratedFromVersion: validMigratedFromVersion }
        : {}),
    updatedAt,
    presets: presetScan.presets,
    preferences,
  });

  return {
    data: migrated,
    preservedPresets: migrated.presets.length,
    droppedCorruptEntries: presetScan.droppedCorruptEntries,
    droppedPlaceholders: presetScan.droppedPlaceholders,
    warnings,
    sourceUntouched: true,
  };
}

export type LocalDataMigrationCategory = 'backup' | 'trusted_devices' | 'user_gear' | 'logs';

export interface LocalDataCopyOperation {
  category: LocalDataMigrationCategory;
  sourceRelativePath: string;
  sourcePath: string;
  targetPath: string;
  overwrite: false;
}

export interface LocalDataMigrationPlan {
  operations: LocalDataCopyOperation[];
  skippedPaths: string[];
  preserveSourceForRollback: true;
}

interface DiskMigrationRule {
  category: LocalDataMigrationCategory;
  pattern: RegExp;
  resolveTargetRel: (relPosix: string) => string;
}

const DISK_MIGRATION_RULES: readonly DiskMigrationRule[] = [
  {
    category: 'backup',
    pattern: /^(?:packages\/backend\/)?backups\/([^/]+\.json)$/i,
    resolveTargetRel: (rel) => {
      const fileName = rel.slice(rel.lastIndexOf('/') + 1);
      return `backups/${fileName}`;
    },
  },
  {
    category: 'trusted_devices',
    pattern: /^(?:packages\/backend\/)?data\/trusted-devices\.json$/i,
    resolveTargetRel: () => 'data/trusted-devices.json',
  },
  {
    category: 'user_gear',
    pattern: /^data\/user-gear\.json$/i,
    resolveTargetRel: () => 'data/user-gear.json',
  },
  {
    category: 'logs',
    pattern: /^logs\/(midi-diagnostics(?:\.prev)?\.log)$/i,
    resolveTargetRel: (rel) => {
      const fileName = rel.slice(rel.lastIndexOf('/') + 1);
      return `logs/${fileName}`;
    },
  },
];

function normalizeToPosix(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

function joinTargetPath(baseDir: string, relativePosixPath: string): string {
  const usesBackslash = baseDir.includes('\\');
  const cleanBase = baseDir.replace(/[\\/]+$/, '');
  const cleanRel = relativePosixPath.replace(/^\/+/, '');
  if (usesBackslash) {
    return `${cleanBase}\\${cleanRel.replace(/\//g, '\\')}`;
  }
  return `${cleanBase}/${cleanRel}`;
}

/**
 * Generates a deterministic, deduplicated, non-destructive copy plan from legacy
 * repo-relative or cwd-relative paths into `%APPDATA%\MG Control\` (`userData`).
 */
export function planLocalDataDirectoryMigration(input: {
  legacyRootDir: string;
  targetUserDataDir: string;
  existingRelativeFiles: readonly string[];
}): LocalDataMigrationPlan {
  const operations: LocalDataCopyOperation[] = [];
  const skippedPaths: string[] = [];
  const plannedTargets = new Set<string>();

  for (const rawFile of input.existingRelativeFiles) {
    const rel = normalizeToPosix(rawFile);
    const matchedRule = DISK_MIGRATION_RULES.find((rule) => rule.pattern.test(rel));

    if (!matchedRule) {
      skippedPaths.push(rawFile);
      continue;
    }

    const targetRel = matchedRule.resolveTargetRel(rel);
    const targetPath = joinTargetPath(input.targetUserDataDir, targetRel);
    const dedupeKey = targetPath.toLowerCase();
    if (plannedTargets.has(dedupeKey)) {
      continue;
    }

    plannedTargets.add(dedupeKey);
    operations.push({
      category: matchedRule.category,
      sourceRelativePath: rel,
      sourcePath: joinTargetPath(input.legacyRootDir, rel),
      targetPath,
      overwrite: false,
    });
  }

  return {
    operations,
    skippedPaths,
    preserveSourceForRollback: true,
  };
}

export interface LocalDataSnapshot {
  localStorageRaw?: string | null;
  trustedDevices?: Array<{
    deviceId: string;
    deviceName: string;
    remoteIp: string;
    tokenHash: string;
    createdAt: string;
    lastConnectedAt: string;
    expiresAtMs: number;
  }>;
  userGear?: {
    guitarModel: string;
    outputTarget: string;
    pickupSummary: string;
    recommendations: string[];
    updatedAt: string;
  } | null;
  relativePaths?: string[];
}

function redactWindowsUsernameInPath(value: string): string {
  return value
    .replace(/([A-Za-z]:\\\\Users\\\\)([^\\"]+)/gi, '$1REDACTED')
    .replace(/([A-Za-z]:[\\/]Users[\\/])([^\\/"]+)/gi, '$1REDACTED');
}

function redactPrivateIp(ip: string): string {
  const trimmed = ip.trim();
  const normalized = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  if (
    /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(normalized) ||
    /^(?:fc|fd)[0-9a-f]{2}:/i.test(normalized)
  ) {
    return '192.0.2.10';
  }
  return trimmed;
}

/**
 * Produces an anonymized copy of local data snapshots for safe migration testing
 * without exposing personal Windows paths (`\` or `/`), LAN IPs (including `::ffff:`-mapped),
 * device names, or token hashes.
 */
export function anonymizeLocalDataSnapshot(snapshot: LocalDataSnapshot): LocalDataSnapshot {
  let anonymizedStorage = snapshot.localStorageRaw ?? null;
  if (typeof anonymizedStorage === 'string' && anonymizedStorage.trim().length > 0) {
    try {
      const parsed = JSON.parse(anonymizedStorage) as Record<string, unknown>;
      if (Array.isArray(parsed.presets)) {
        parsed.presets = parsed.presets.map((entry) => {
          if (entry && typeof entry === 'object' && 'sourceFile' in entry) {
            const rec = entry as Record<string, unknown>;
            return {
              ...rec,
              ...(typeof rec.sourceFile === 'string'
                ? { sourceFile: redactWindowsUsernameInPath(rec.sourceFile) }
                : {}),
            };
          }
          return entry;
        });
      }
      anonymizedStorage = JSON.stringify(parsed);
    } catch {
      anonymizedStorage = redactWindowsUsernameInPath(anonymizedStorage);
    }
  }

  return {
    ...(snapshot.localStorageRaw !== undefined ? { localStorageRaw: anonymizedStorage } : {}),
    ...(snapshot.trustedDevices
      ? {
          trustedDevices: snapshot.trustedDevices.map((device, index) => ({
            ...device,
            deviceName: `Device-${index + 1}`,
            remoteIp: redactPrivateIp(device.remoteIp),
            tokenHash: `redacted-hash-${index + 1}`.padEnd(64, '0'),
          })),
        }
      : {}),
    ...(snapshot.userGear !== undefined
      ? {
          userGear: snapshot.userGear
            ? {
                ...snapshot.userGear,
                guitarModel: redactWindowsUsernameInPath(snapshot.userGear.guitarModel),
                outputTarget: redactWindowsUsernameInPath(snapshot.userGear.outputTarget),
                pickupSummary: redactWindowsUsernameInPath(snapshot.userGear.pickupSummary),
                recommendations: snapshot.userGear.recommendations.map((rec) =>
                  redactWindowsUsernameInPath(rec),
                ),
              }
            : null,
        }
      : {}),
    ...(snapshot.relativePaths
      ? {
          relativePaths: snapshot.relativePaths.map((p) => redactWindowsUsernameInPath(p)),
        }
      : {}),
  };
}
