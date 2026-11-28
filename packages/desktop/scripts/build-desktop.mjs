import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');
const distDir = path.join(desktopRoot, 'dist');

fs.mkdirSync(distDir, { recursive: true });

const mainResult = await esbuild.build({
  entryPoints: [path.join(desktopRoot, 'src', 'main.ts')],
  outfile: path.join(distDir, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  legalComments: 'none',
});

if (mainResult.errors.length > 0) {
  console.error('[build-desktop] Main build failed:', mainResult.errors);
  process.exit(1);
}

const preloadOut = path.join(distDir, 'preload.js');
const preloadResult = await esbuild.build({
  entryPoints: [path.join(desktopRoot, 'src', 'preload.ts')],
  outfile: preloadOut,
  bundle: true,
  platform: 'neutral',
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  legalComments: 'none',
});

if (preloadResult.errors.length > 0) {
  console.error('[build-desktop] Preload build failed:', preloadResult.errors);
  process.exit(1);
}

const preloadCode = fs.readFileSync(preloadOut, 'utf8');
const requireMatches = [...preloadCode.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)];
const disallowedRequires = requireMatches
  .map((match) => match[1])
  .filter((specifier) => specifier !== 'electron');

if (disallowedRequires.length > 0) {
  console.error(
    `[build-desktop] Sandbox violation in dist/preload.js: disallowed require(${disallowedRequires.join(', ')})`,
  );
  process.exit(1);
}

console.log(
  `[build-desktop] Built main.js (${fs.statSync(path.join(distDir, 'main.js')).size} B) and preload.js (${fs.statSync(preloadOut).size} B)`,
);
