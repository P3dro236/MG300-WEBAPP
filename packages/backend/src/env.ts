import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MONOREPO_ROOT = path.resolve(CURRENT_DIR, '../../..');

function stripSurroundingQuotes(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if (first === '"' && last === '"') {
      return raw.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    }
    if (first === "'" && last === "'") {
      return raw.slice(1, -1);
    }
  }
  const inlineCommentIdx = raw.search(/\s+#/);
  return inlineCommentIdx >= 0 ? raw.slice(0, inlineCommentIdx).trimEnd() : raw;
}

export function parseEnvContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trimStart()
      : trimmed;

    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const rawValue = withoutExport.slice(eqIdx + 1).trim();
    parsed[key] = stripSurroundingQuotes(rawValue);
  }

  return parsed;
}

/**
 * Loads `.env` from `process.cwd()` and `<monorepoRoot>` without external dependencies,
 * setting `process.env[k]` only when still `undefined`.
 */
export function loadEnvFiles(candidatePaths?: readonly string[]): string[] {
  const defaultPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(MONOREPO_ROOT, '.env'),
  ];
  const uniquePaths = Array.from(
    new Set((candidatePaths ?? defaultPaths).map((p) => path.resolve(p))),
  );
  const loadedFiles: string[] = [];

  for (const envPath of uniquePaths) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    try {
      const stats = fs.statSync(envPath);
      if (!stats.isFile()) {
        continue;
      }
      const content = fs.readFileSync(envPath, 'utf8');
      const entries = parseEnvContent(content);
      for (const [key, value] of Object.entries(entries)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      loadedFiles.push(envPath);
    } catch {
      // Ignore unreadable optional .env files
    }
  }

  return loadedFiles;
}
