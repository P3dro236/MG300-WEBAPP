import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(backendRoot, 'src', 'index.ts');
const outFile = path.join(backendRoot, 'dist', 'local-core.cjs');

fs.mkdirSync(path.dirname(outFile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [entryPoint],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: "var __mgImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': '__mgImportMetaUrl',
  },
});

if (result.errors.length > 0) {
  console.error('[build-core] Build failed with errors:', result.errors);
  process.exit(1);
}

if (result.warnings.length > 0) {
  console.warn('[build-core] Build warnings:', result.warnings);
}

const stats = fs.statSync(outFile);
console.log(
  `[build-core] Built ${path.relative(backendRoot, outFile)} (${stats.size} bytes, ${result.warnings.length} warnings)`,
);
