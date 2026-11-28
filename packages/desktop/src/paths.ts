import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planLocalDataDirectoryMigration } from '@quicktone/shared';

export function writeFileAtomicSync(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

export interface DesktopPaths {
  isPackaged: boolean;
  desktopRoot: string;
  monorepoRoot: string;
  dataDir: string;
  dataSubDir: string;
  logsDir: string;
  backupsDir: string;
  diagnosticsDir: string;
  desktopLogFilePath: string;
  midiLogFilePath: string;
  dpapiSessionPath: string;
  deviceIdentityPath: string;
  migrationSentinelPath: string;
  coreEntryPath: string;
  staticDir: string;
  preloadPath: string;
  legacyRootDir: string;
}

export interface ResolveDesktopPathsOptions {
  isPackaged?: boolean;
  resourcesPath?: string;
  userDataDir?: string;
  legacyRootDir?: string;
  coreEntryPath?: string;
  staticDir?: string;
  preloadPath?: string;
  desktopRoot?: string;
}

export interface LegacyMigrationExecutionResult {
  alreadyCompleted: boolean;
  copiedFiles: string[];
  skippedExistingTargets: string[];
  errors: string[];
  preserveSourceForRollback: true;
}

function findPackageRoot(startDir: string, expectedPackageName: string): string | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: unknown };
        if (pkg.name === expectedPackageName) {
          return current;
        }
      } catch {
        // Ignore unreadable package.json
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function resolveDesktopPaths(
  options: ResolveDesktopPathsOptions = {},
): DesktopPaths {
  const isPackaged = options.isPackaged ?? false;
  const detectedDesktopRoot =
    options.desktopRoot ??
    findPackageRoot(__dirname, '@quicktone/desktop') ??
    path.resolve(__dirname, '..');
  const monorepoRoot = path.resolve(detectedDesktopRoot, '..', '..');

  const envDataDir = process.env.MG_DATA_DIR?.trim();
  const dataDir = path.resolve(
    options.userDataDir?.trim() ||
      envDataDir ||
      path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'MG Control',
      ),
  );

  const resourcesRoot = path.resolve(
    options.resourcesPath?.trim() || process.resourcesPath || detectedDesktopRoot,
  );

  const envCoreEntry = process.env.MG_CORE_ENTRY?.trim();
  const coreEntryPath = path.resolve(
    options.coreEntryPath?.trim() ||
      envCoreEntry ||
      (isPackaged
        ? path.join(resourcesRoot, 'core', 'local-core.cjs')
        : path.join(monorepoRoot, 'packages', 'backend', 'dist', 'local-core.cjs')),
  );

  const envStaticDir = process.env.MG_STATIC_DIR?.trim();
  const staticDir = path.resolve(
    options.staticDir?.trim() ||
      envStaticDir ||
      (isPackaged
        ? path.join(resourcesRoot, 'frontend')
        : path.join(monorepoRoot, 'packages', 'frontend', 'dist')),
  );

  const preloadPath = path.resolve(
    options.preloadPath?.trim() || path.join(detectedDesktopRoot, 'dist', 'preload.js'),
  );

  const legacyRootDir = path.resolve(options.legacyRootDir?.trim() || monorepoRoot);
  const dataSubDir = path.join(dataDir, 'data');
  const logsDir = path.join(dataDir, 'logs');
  const backupsDir = path.join(dataDir, 'backups');
  const diagnosticsDir = path.join(dataDir, 'diagnostics');

  return {
    isPackaged,
    desktopRoot: detectedDesktopRoot,
    monorepoRoot,
    dataDir,
    dataSubDir,
    logsDir,
    backupsDir,
    diagnosticsDir,
    desktopLogFilePath: path.join(logsDir, 'desktop-main.log'),
    midiLogFilePath: path.join(logsDir, 'midi-diagnostics.log'),
    dpapiSessionPath: path.join(dataSubDir, 'auth-session.dpapi.json'),
    deviceIdentityPath: path.join(dataSubDir, 'device-identity.json'),
    migrationSentinelPath: path.join(dataSubDir, '.legacy-migration-v1.json'),
    coreEntryPath,
    staticDir,
    preloadPath,
    legacyRootDir,
  };
}

export function ensureDesktopDirectories(paths: DesktopPaths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.dataSubDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
  fs.mkdirSync(paths.diagnosticsDir, { recursive: true });
}

function collectLegacyCandidateRelativeFiles(legacyRootDir: string): string[] {
  if (!legacyRootDir || !fs.existsSync(legacyRootDir)) {
    return [];
  }

  const candidates: string[] = [];
  const fixedFiles = [
    'data/trusted-devices.json',
    'packages/backend/data/trusted-devices.json',
    'data/user-gear.json',
    'logs/midi-diagnostics.log',
    'logs/midi-diagnostics.prev.log',
  ];

  for (const rel of fixedFiles) {
    const abs = path.join(legacyRootDir, ...rel.split('/'));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      candidates.push(rel);
    }
  }

  for (const backupDirRel of ['backups', 'packages/backend/backups']) {
    const absBackupDir = path.join(legacyRootDir, ...backupDirRel.split('/'));
    if (!fs.existsSync(absBackupDir)) {
      continue;
    }
    try {
      for (const entry of fs.readdirSync(absBackupDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
          candidates.push(`${backupDirRel}/${entry.name}`);
        }
      }
    } catch {
      // Ignore unreadable legacy backup directory
    }
  }

  return candidates;
}

export function runNonDestructiveLegacyMigration(input: {
  legacyRootDir: string;
  targetUserDataDir: string;
  migrationSentinelPath?: string;
}): LegacyMigrationExecutionResult {
  const targetUserDataDir = path.resolve(input.targetUserDataDir);
  const sentinelPath =
    input.migrationSentinelPath ??
    path.join(targetUserDataDir, 'data', '.legacy-migration-v1.json');

  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });

  if (fs.existsSync(sentinelPath)) {
    return {
      alreadyCompleted: true,
      copiedFiles: [],
      skippedExistingTargets: [],
      errors: [],
      preserveSourceForRollback: true,
    };
  }

  const existingRelativeFiles = collectLegacyCandidateRelativeFiles(input.legacyRootDir);
  const plan = planLocalDataDirectoryMigration({
    legacyRootDir: input.legacyRootDir,
    targetUserDataDir,
    existingRelativeFiles,
  });

  const copiedFiles: string[] = [];
  const skippedExistingTargets: string[] = [];
  const errors: string[] = [];

  for (const op of plan.operations) {
    if (fs.existsSync(op.targetPath)) {
      skippedExistingTargets.push(op.targetPath);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(op.targetPath), { recursive: true });
      const tempTarget = `${op.targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try {
        fs.copyFileSync(op.sourcePath, tempTarget);
        fs.renameSync(tempTarget, op.targetPath);
      } catch (copyErr) {
        fs.rmSync(tempTarget, { force: true });
        throw copyErr;
      }
      copiedFiles.push(op.targetPath);
    } catch (err) {
      errors.push(
        `Falha ao migrar ${op.sourceRelativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (errors.length === 0) {
    writeFileAtomicSync(
      sentinelPath,
      JSON.stringify(
        {
          version: 1,
          migratedAt: new Date().toISOString(),
          copiedCount: copiedFiles.length,
          skippedExistingCount: skippedExistingTargets.length,
          preserveSourceForRollback: true,
        },
        null,
        2,
      ),
    );
  }

  return {
    alreadyCompleted: false,
    copiedFiles,
    skippedExistingTargets,
    errors,
    preserveSourceForRollback: true,
  };
}
