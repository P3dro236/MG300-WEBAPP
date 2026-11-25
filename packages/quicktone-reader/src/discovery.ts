import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MG300_MIDI_CC,
  Preset,
  PresetsDirectoryStatus,
  PresetsResponse,
  slotIndexToBankCoordinate,
} from '@quicktone/shared';
import { createFactoryPresets, parseNuxPresetBuffer } from './parser.js';

export const DEFAULT_QUICKTONE_CANDIDATE_PATHS: readonly string[] = Array.from(
  new Set([
    'C:\\Users\\pedro\\Documents\\NUX',
    'C:\\Users\\pedro\\CrossDevice\\S25+ de Pedro\\storage\\Download',
    'C:\\Users\\pedro\\Downloads',
    path.join(os.homedir(), 'Documents', 'NUX'),
    path.join(os.homedir(), 'Downloads'),
  ]),
);

export interface QuickToneDiscoveryOptions {
  directoryPath?: string | null;
  includeFactoryPresets?: boolean;
  candidatePaths?: readonly string[];
  debounceMs?: number;
}

const MAX_PRESET_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB safety cap above 300 KB MG300AllPreset.nuxpreset

function isSupportedPresetFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.nuxpreset')) {
    return true;
  }
  if (
    lower.endsWith('.json') &&
    lower !== 'package.json' &&
    lower !== 'package-lock.json' &&
    lower !== 'tsconfig.json'
  ) {
    return true;
  }
  return false;
}

function reassignPresetToSlot(preset: Preset, newSlotIndex: number, isDuplicate: boolean): Preset {
  const coordinate = slotIndexToBankCoordinate(newSlotIndex);
  return {
    ...preset,
    id: coordinate.displayBank,
    slotIndex: coordinate.slotIndex,
    bankType: coordinate.bankType,
    bankNumber: coordinate.bankNumber,
    patchLetter: coordinate.patchLetter,
    displayBank: coordinate.displayBank,
    isDuplicate,
    midiMapping: {
      ...preset.midiMapping,
      protocol: 'mg300-cc60',
      ccNumber: MG300_MIDI_CC.PRESET_SELECT,
      ccValue: coordinate.slotIndex,
      programNumber: coordinate.slotIndex,
      bankMsb: 0,
      bankLsb: coordinate.bankType === 'factory' ? 1 : 0,
    },
  };
}

export class QuickToneDiscoveryService {
  private explicitDirectoryPath: string | null;
  private resolvedDirectoryPath: string | null = null;
  private includeFactoryPresets: boolean;
  private readonly candidatePaths: readonly string[];
  private readonly debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(result: PresetsResponse) => void>();
  private lastResult: PresetsResponse;

  constructor(options: QuickToneDiscoveryOptions = {}) {
    this.explicitDirectoryPath =
      options.directoryPath !== undefined && options.directoryPath !== null
        ? options.directoryPath.trim()
        : null;
    this.includeFactoryPresets = options.includeFactoryPresets ?? false;
    this.candidatePaths = options.candidatePaths ?? DEFAULT_QUICKTONE_CANDIDATE_PATHS;
    this.debounceMs = options.debounceMs ?? 60;
    this.lastResult = {
      presets: this.includeFactoryPresets ? createFactoryPresets() : [],
      directory: this.explicitDirectoryPath,
      directoryStatus: this.explicitDirectoryPath ? 'unconfigured' : 'unconfigured',
      warnings: [],
    };
  }

  public getDirectory(): string | null {
    return this.resolvedDirectoryPath ?? this.explicitDirectoryPath;
  }

  public getIncludeFactoryPresets(): boolean {
    return this.includeFactoryPresets;
  }

  public setIncludeFactoryPresets(include: boolean): void {
    this.includeFactoryPresets = include;
  }

  public getLastResult(): PresetsResponse {
    return this.lastResult;
  }

  public async setDirectory(
    newPath: string,
    includeFactoryPresets?: boolean,
  ): Promise<PresetsResponse> {
    this.explicitDirectoryPath = newPath.trim();
    if (includeFactoryPresets !== undefined) {
      this.includeFactoryPresets = includeFactoryPresets;
    }
    const result = await this.discover();
    if (this.listeners.size > 0) {
      this.restartWatcher();
      for (const listener of this.listeners) {
        listener(result);
      }
    }
    return result;
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  private async resolveTargetDirectory(): Promise<{
    directory: string | null;
    status: PresetsDirectoryStatus;
    warnings: string[];
  }> {
    if (this.explicitDirectoryPath !== null) {
      if (this.explicitDirectoryPath.length === 0) {
        return {
          directory: null,
          status: 'unconfigured',
          warnings: ['QuickTone presets directory path is empty.'],
        };
      }
      const exists = await this.directoryExists(this.explicitDirectoryPath);
      if (!exists) {
        return {
          directory: this.explicitDirectoryPath,
          status: 'directory_not_found',
          warnings: [
            `QuickTone presets directory not found: "${this.explicitDirectoryPath}". Configure a valid folder path.`,
          ],
        };
      }
      return {
        directory: this.explicitDirectoryPath,
        status: 'ok',
        warnings: [],
      };
    }

    let firstExistingDir: string | null = null;
    for (const candidate of this.candidatePaths) {
      if (await this.directoryExists(candidate)) {
        if (!firstExistingDir) {
          firstExistingDir = candidate;
        }
        try {
          const entries = await fs.promises.readdir(candidate);
          if (entries.some((name) => name.toLowerCase().endsWith('.nuxpreset'))) {
            return {
              directory: candidate,
              status: 'ok',
              warnings: [],
            };
          }
        } catch {
          // Ignore unreadable candidate and continue searching
        }
      }
    }

    if (firstExistingDir) {
      return {
        directory: firstExistingDir,
        status: 'ok',
        warnings: [],
      };
    }

    return {
      directory: null,
      status: 'directory_not_found',
      warnings: [
        `No default QuickTone presets directory found among candidate paths (${this.candidatePaths.join(', ')}).`,
      ],
    };
  }

  /**
   * Performs a 100% read-only scan of the configured or auto-discovered QuickTone preset directory.
   */
  public async discover(): Promise<PresetsResponse> {
    const resolved = await this.resolveTargetDirectory();
    this.resolvedDirectoryPath = resolved.directory;

    if (resolved.status !== 'ok' || !resolved.directory) {
      const fallbackResult: PresetsResponse = {
        presets: this.includeFactoryPresets ? createFactoryPresets() : [],
        directory: resolved.directory,
        directoryStatus: resolved.status,
        warnings: [...resolved.warnings],
      };
      this.lastResult = fallbackResult;
      return fallbackResult;
    }

    const targetDir = resolved.directory;
    const warnings: string[] = [...resolved.warnings];

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    } catch (err) {
      const errorResult: PresetsResponse = {
        presets: this.includeFactoryPresets ? createFactoryPresets() : [],
        directory: targetDir,
        directoryStatus: 'error',
        warnings: [
          ...warnings,
          `Failed to read presets directory "${targetDir}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      };
      this.lastResult = errorResult;
      return errorResult;
    }

    const presetFiles = dirEntries
      .filter((entry) => entry.isFile() && isSupportedPresetFileName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => {
        const aIsBundle = a.toLowerCase() === 'mg300allpreset.nuxpreset';
        const bIsBundle = b.toLowerCase() === 'mg300allpreset.nuxpreset';
        if (aIsBundle && !bIsBundle) return -1;
        if (!aIsBundle && bIsBundle) return 1;
        return a.localeCompare(b, 'en', { sensitivity: 'base' });
      });

    const userPresets: Preset[] = [];
    const usedUserSlots = new Set<number>();
    const seenNormalizedNames = new Map<string, { displayBank: string; fileName: string }>();

    const findNextFreeUserSlot = (preferredSlot: number): number => {
      if (preferredSlot >= 0 && preferredSlot < 36 && !usedUserSlots.has(preferredSlot)) {
        return preferredSlot;
      }
      for (let slot = 0; slot < 36; slot++) {
        if (!usedUserSlots.has(slot)) {
          return slot;
        }
      }
      return -1;
    };

    for (const fileName of presetFiles) {
      const fullPath = path.join(targetDir, fileName);
      const defaultSlot = findNextFreeUserSlot(0);
      if (defaultSlot < 0) {
        warnings.push(
          `Skipped preset file "${fileName}": all 36 user slots (1A..9D) are already assigned.`,
        );
        continue;
      }

      let fileBuffer: Buffer;
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(fullPath);
        if (stats.size > MAX_PRESET_FILE_BYTES) {
          warnings.push(
            `Ignored oversized preset file "${fileName}" (${stats.size} bytes > ${MAX_PRESET_FILE_BYTES} bytes limit).`,
          );
          continue;
        }
        fileBuffer = await fs.promises.readFile(fullPath);
      } catch (err) {
        warnings.push(
          `Failed to read file "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const uint8 = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);

      let parsedResult;
      try {
        parsedResult = parseNuxPresetBuffer(
          uint8,
          fullPath,
          defaultSlot,
          stats.mtime.toISOString(),
        );
      } catch (err) {
        warnings.push(
          `Ignored invalid preset file "${fileName}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      warnings.push(...parsedResult.warnings);

      for (const parsedPreset of parsedResult.presets) {
        const normalizedName = parsedPreset.name.trim().toLowerCase();
        const existingWithSameName = seenNormalizedNames.get(normalizedName);
        const slotCollision = usedUserSlots.has(parsedPreset.slotIndex);

        let isDuplicate = false;
        if (existingWithSameName) {
          isDuplicate = true;
          warnings.push(
            `Duplicate preset name "${parsedPreset.name}" detected in "${fileName}" (already loaded at ${existingWithSameName.displayBank} from "${existingWithSameName.fileName}").`,
          );
        }

        let assignedSlot = parsedPreset.slotIndex;
        if (slotCollision) {
          const reassignedSlot = findNextFreeUserSlot(parsedPreset.slotIndex);
          if (reassignedSlot < 0) {
            warnings.push(
              `Skipped extra preset "${parsedPreset.name}" in "${fileName}": all 36 user slots (1A..9D) are already assigned.`,
            );
            continue;
          }
          if (reassignedSlot !== parsedPreset.slotIndex) {
            if (parsedResult.presets.length === 1 && !existingWithSameName) {
              // Two V2 files explicitly requested the same slotIndex
              isDuplicate = true;
              warnings.push(
                `Duplicate slot assignment ${parsedPreset.displayBank} in "${fileName}"; reassigned to ${
                  slotIndexToBankCoordinate(reassignedSlot).displayBank
                }.`,
              );
            }
            assignedSlot = reassignedSlot;
          }
        }

        const finalizedPreset = reassignPresetToSlot(parsedPreset, assignedSlot, isDuplicate);
        usedUserSlots.add(finalizedPreset.slotIndex);
        if (!existingWithSameName) {
          seenNormalizedNames.set(normalizedName, {
            displayBank: finalizedPreset.displayBank,
            fileName,
          });
        }
        userPresets.push(finalizedPreset);
      }
    }

    userPresets.sort((a, b) => a.slotIndex - b.slotIndex);

    const allPresets: Preset[] = this.includeFactoryPresets
      ? [...userPresets, ...createFactoryPresets()]
      : userPresets;

    const response: PresetsResponse = {
      presets: allPresets,
      directory: targetDir,
      directoryStatus: 'ok',
      warnings,
    };

    this.lastResult = response;
    return response;
  }

  public async scan(): Promise<PresetsResponse> {
    return this.discover();
  }

  public async reload(): Promise<PresetsResponse> {
    const result = await this.discover();
    for (const listener of this.listeners) {
      listener(result);
    }
    return result;
  }

  private restartWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Ignore close error
      }
      this.watcher = null;
    }

    const dirToWatch = this.resolvedDirectoryPath ?? this.explicitDirectoryPath;
    if (!dirToWatch) {
      return;
    }

    try {
      if (!fs.existsSync(dirToWatch)) {
        return;
      }
      this.watcher = fs.watch(dirToWatch, { persistent: false }, (_eventType, filename) => {
        if (filename && !isSupportedPresetFileName(filename)) {
          return;
        }
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          void this.reload();
        }, this.debounceMs);
      });
      this.watcher.on('error', () => {
        // Prevent unhandled watcher errors on directory deletion/rename
      });
    } catch {
      // Directory cannot be watched; manual reload() remains available
    }
  }

  /**
   * Monitors the preset directory for file additions, modifications, or removals.
   * Returns an unsubscribe function that stops watching when no listeners remain.
   */
  public watchDirectory(onChange: (result: PresetsResponse) => void): () => void {
    this.listeners.add(onChange);
    if (!this.watcher) {
      this.restartWatcher();
    }

    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0) {
        this.stopWatching();
      }
    };
  }

  public stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Ignore
      }
      this.watcher = null;
    }
  }
}
