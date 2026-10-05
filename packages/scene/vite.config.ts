/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Two vitest projects: `unit` (npm test — no browser) and `e2e` (npm run test:e2e — the editor
// pages and view:shot in headless Chromium). e2e files run one at a time (each starts a Vite
// server and a SwiftShader browser; in parallel they starve each other into timeouts) under a
// machine-wide lock (edit/e2e/lock.ts), ports from E2E_PORT_BASE when set.
const E2E = ['edit/e2e/**/*.spec.ts', 'test/view-shot.test.ts', 'test/flatten-shot.test.ts'];

// A checkout reached through symlinks: preserveSymlinks keeps Vite resolving modules against
// the paths as linked.
export default defineConfig({
  resolve: {
    preserveSymlinks: true,
  },
  test: {
    environment: 'node',
    // editor/ imports the core as its package entry (as it runs from dist); tests read the source.
    alias: [
      { find: /^@trempel\/scene\/core$/, replacement: fileURLToPath(new URL('./src/core.ts', import.meta.url)) },
      { find: /^@trempel\/scene\/internal\/(.*)$/, replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}$1` },
    ],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts', 'editor/**/*.test.ts', 'edit/**/*.test.ts'],
          exclude: ['**/node_modules/**', ...E2E],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: E2E,
          // one file at a time (vitest 3 has no per-project fileParallelism: one fork runs them all)
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120_000,
          hookTimeout: 120_000,
          globalSetup: ['edit/e2e/lock.ts'],
        },
      },
    ],
  },
});
