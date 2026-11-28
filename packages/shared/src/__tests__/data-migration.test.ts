import { describe, expect, it } from 'vitest';
import {
  PersistedAppDataV2Schema,
  anonymizeLocalDataSnapshot,
  migrateLocalStoragePayloadV1ToV2,
  planLocalDataDirectoryMigration,
} from '../data-migration.js';

describe('@quicktone/shared — S02 Non-Destructive Data Migration & Anonymization', () => {
  it('anonymizes personal Windows paths (backslash and forward slash), ::ffff:-mapped LAN IPs, gear fields, device names, and token hashes', () => {
    const rawSnapshot = {
      localStorageRaw: JSON.stringify({
        version: 1,
        updatedAt: '2026-11-27T04:00:00.000Z',
        presets: [
          {
            id: '1A',
            slotIndex: 0,
            bankType: 'user',
            bankNumber: 1,
            patchLetter: 'A',
            displayBank: '1A',
            name: 'Lead 1A',
            patchVolume: 60,
            sourceFile: 'C:\\Users\\pedro\\Documents\\NUX\\Lead1A.nuxpreset',
            isDuplicate: false,
            updatedAt: '2026-11-27T04:00:00.000Z',
            midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 0 },
          },
          {
            id: '1B',
            slotIndex: 1,
            bankType: 'user',
            bankNumber: 1,
            patchLetter: 'B',
            displayBank: '1B',
            name: 'Clean 1B',
            patchVolume: 52,
            sourceFile: 'C:/Users/pedro/Downloads/Clean1B.nuxpreset',
            isDuplicate: false,
            updatedAt: '2026-11-27T04:00:00.000Z',
            midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 1 },
          },
        ],
        preferences: { filter: 'user', viewMode: 'stage', lastVolume: 72 },
      }),
      trustedDevices: [
        {
          deviceId: 'dev-1',
          deviceName: 'Galaxy S25+ de Pedro',
          remoteIp: '::ffff:192.168.1.44',
          tokenHash: 'secret-sha256-value',
          createdAt: '2026-11-27T04:00:00.000Z',
          lastConnectedAt: '2026-11-27T04:05:00.000Z',
          expiresAtMs: 1999999999999,
        },
      ],
      userGear: {
        guitarModel: 'C:\\Users\\pedro\\Gear\\Almach',
        outputTarget: 'C:/Users/pedro/FRFR',
        pickupSummary: 'HH',
        recommendations: ['Salvar preset fora de C:\\Users\\pedro'],
        updatedAt: '2026-11-27T04:45:27.471Z',
      },
      relativePaths: [
        'C:/Users/pedro/Documents/NUX/Backup.nuxpreset',
        'packages/backend/backups/slot-14-2026-11-27T04-55-42-952Z.json',
      ],
    };

    const anonymized = anonymizeLocalDataSnapshot(rawSnapshot);
    const serialized = JSON.stringify(anonymized);
    expect(serialized).not.toContain('pedro');
    expect(serialized).not.toContain('Pedro');
    expect(serialized).not.toContain('192.168.1.44');
    expect(serialized).not.toContain('secret-sha256-value');
    expect(anonymized.trustedDevices?.[0]?.remoteIp).toBe('192.0.2.10');
    expect(anonymized.userGear?.outputTarget).toContain('C:/Users/REDACTED/FRFR');
    expect(anonymized.userGear?.recommendations[0]).toContain('C:\\Users\\REDACTED');
    expect(anonymized.relativePaths?.[0]).toContain('C:/Users/REDACTED/');
  });

  it('migrates anonymized localStorage v1 payload to validated v2 and handles corrupt/empty/future-version edge cases', () => {
    const emptyReport = migrateLocalStoragePayloadV1ToV2(null, '2026-11-28T01:00:00.000Z');
    expect(PersistedAppDataV2Schema.safeParse(emptyReport.data).success).toBe(true);
    expect(emptyReport.preservedPresets).toBe(0);

    const invalidJson = migrateLocalStoragePayloadV1ToV2('{bad json', '2026-11-28T01:00:00.000Z');
    expect(invalidJson.droppedCorruptEntries).toBe(1);
    expect(invalidJson.warnings.length).toBeGreaterThan(0);

    const arrayRoot = migrateLocalStoragePayloadV1ToV2('[]', '2026-11-28T01:00:00.000Z');
    expect(arrayRoot.droppedCorruptEntries).toBe(1);

    const futureVersion = migrateLocalStoragePayloadV1ToV2(
      JSON.stringify({ version: 99, presets: [] }),
      '2026-11-28T01:00:00.000Z',
    );
    expect(futureVersion.warnings[0]).toContain('Versão futura');

    const anonymizedV1 = anonymizeLocalDataSnapshot({
      localStorageRaw: JSON.stringify({
        version: 1,
        updatedAt: '   ',
        presets: [
          {
            id: '1A',
            slotIndex: 0,
            bankType: 'user',
            bankNumber: 1,
            patchLetter: 'A',
            displayBank: '1A',
            name: 'Clean Strat',
            patchVolume: 55,
            sourceFile: 'C:\\Users\\pedro\\Documents\\NUX\\Clean.nuxpreset',
            isDuplicate: false,
            updatedAt: '2026-11-27T04:00:00.000Z',
            midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 0 },
          },
          {
            id: '1B',
            slotIndex: 1,
            bankType: 'user',
            bankNumber: 1,
            patchLetter: 'B',
            displayBank: '1B',
            name: 'User 1B',
            patchVolume: 50,
            origin: 'placeholder',
            isDuplicate: false,
            updatedAt: '2026-11-27T04:00:00.000Z',
            midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 1 },
          },
          { broken: true },
        ],
        preferences: {
          filter: 'user',
          viewMode: 'stage',
          lastVolume: 180, // out-of-range must be sanitized away
        },
      }),
    });

    const firstPass = migrateLocalStoragePayloadV1ToV2(
      anonymizedV1.localStorageRaw,
      '2026-11-28T01:00:00.000Z',
    );
    expect(PersistedAppDataV2Schema.safeParse(firstPass.data).success).toBe(true);
    expect(firstPass.sourceUntouched).toBe(true);
    expect(firstPass.data.version).toBe(2);
    expect(firstPass.data.migratedFromVersion).toBe(1);
    expect(firstPass.preservedPresets).toBe(1);
    expect(firstPass.droppedPlaceholders).toBe(1);
    expect(firstPass.droppedCorruptEntries).toBe(1);
    expect(firstPass.data.preferences.lastVolume).toBeUndefined();

    const secondPass = migrateLocalStoragePayloadV1ToV2(
      JSON.stringify(firstPass.data),
      '2026-11-28T01:05:00.000Z',
    );
    expect(secondPass.data).toEqual(firstPass.data);

    const corruptV2Meta = migrateLocalStoragePayloadV1ToV2(
      JSON.stringify({ ...firstPass.data, migratedFromVersion: 0 }),
      '2026-11-28T01:05:00.000Z',
    );
    expect(PersistedAppDataV2Schema.safeParse(corruptV2Meta.data).success).toBe(true);
    expect(corruptV2Meta.data.migratedFromVersion).toBeUndefined();
  });

  it('plans non-destructive copy of legacy disk data (both packages/backend and root cwd layouts) with deduplication', () => {
    const plan = planLocalDataDirectoryMigration({
      legacyRootDir: 'C:\\LegacyRepo',
      targetUserDataDir: 'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control',
      existingRelativeFiles: [
        'packages/backend/backups/slot-14-2026-11-27T04-55-42-952Z.json',
        'backups/slot-14-2026-11-27T04-55-42-952Z.json', // duplicate target
        'backups/slot-15-2026-11-27T05-00-00-000Z.json', // root-level cwd backup
        'data/trusted-devices.json', // root-level cwd trusted devices
        'packages/backend/data/trusted-devices.json', // duplicate target
        './data/user-gear.json',
        'logs/midi-diagnostics.log',
        'logs/midi-diagnostics.prev.log',
        'README.md',
      ],
    });

    expect(plan.preserveSourceForRollback).toBe(true);
    expect(plan.operations.every((op) => op.overwrite === false)).toBe(true);
    expect(plan.operations.map((op) => op.targetPath)).toEqual([
      'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control\\backups\\slot-14-2026-11-27T04-55-42-952Z.json',
      'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control\\backups\\slot-15-2026-11-27T05-00-00-000Z.json',
      'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control\\data\\trusted-devices.json',
      'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control\\data\\user-gear.json',
      'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control\\logs\\midi-diagnostics.log',
      'C:\\Users\\REDACTED\\AppData\\Roaming\\MG Control\\logs\\midi-diagnostics.prev.log',
    ]);
    expect(plan.skippedPaths).toEqual(['README.md']);
  });
});
