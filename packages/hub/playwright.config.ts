import { defineConfig, devices } from '@playwright/test';

// e2e of the hub page: `e2e/serve.mjs` makes a hub home with fixture projects (the monorepo's
// casual template added by hand, a project on an old kit under the scanned root) and serves the
// hub on HUB_E2E_PORT.
const PORT = Number(process.env.HUB_E2E_PORT ?? 4390);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}/`, viewport: { width: 1200, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 900 } } }],
  webServer: { command: `node e2e/serve.mjs ${PORT}`, url: `http://127.0.0.1:${PORT}/api/state`, reuseExistingServer: false, timeout: 60_000 },
});
