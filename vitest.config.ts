import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@quicktone/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@quicktone/reader': path.resolve(__dirname, 'packages/quicktone-reader/src/index.ts'),
      '@quicktone/midi': path.resolve(__dirname, 'packages/midi-service/src/index.ts'),
      '@quicktone/backend': path.resolve(__dirname, 'packages/backend/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/**/__tests__/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [
      ['packages/frontend/**', 'jsdom'],
      ['packages/shared/**', 'node'],
      ['packages/quicktone-reader/**', 'node'],
      ['packages/midi-service/**', 'node'],
      ['packages/backend/**', 'node'],
    ],
  },
});
