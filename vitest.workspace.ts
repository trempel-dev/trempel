// Two vitest projects: `unit` (npm test — no browser) and `e2e` (npm run test:e2e — the editor
// pages and view:shot in headless Chromium). e2e files run one at a time (each starts a Vite
// server and a SwiftShader browser; in parallel they starve each other into timeouts) under a
// machine-wide lock (edit/e2e/lock.ts), ports from E2E_PORT_BASE when set.

import { defineWorkspace } from 'vitest/config';

const E2E = ['edit/e2e/**/*.spec.ts', 'test/view-shot.test.ts'];

export default defineWorkspace([
  {
    extends: './vite.config.ts',
    test: {
      name: 'unit',
      include: ['test/**/*.test.ts', 'editor/**/*.test.ts', 'edit/**/*.test.ts'],
      exclude: ['**/node_modules/**', ...E2E],
    },
  },
  {
    extends: './vite.config.ts',
    test: {
      name: 'e2e',
      include: E2E,
      fileParallelism: false,
      testTimeout: 120_000,
      hookTimeout: 120_000,
      globalSetup: ['edit/e2e/lock.ts'],
    },
  },
]);
