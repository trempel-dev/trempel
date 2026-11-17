import { defineConfig, devices } from '@playwright/test';

// e2e runs against the BUILDS (vite preview): dist-web (game.spec.ts) and dist-yt (youtube.spec.ts,
// SDK stubbed). `npm run e2e` builds both first. E2E_PORT moves the servers.
const PORT = Number(process.env.E2E_PORT ?? 4280);
export const YT_PORT = PORT + 1;
// WebGL: Metal on a Mac; elsewhere (CI runners without a GPU) Chromium's software GL.
const GL = process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}/`, viewport: { width: 414, height: 800 } },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 414, height: 800 }, hasTouch: true, launchOptions: { args: GL } },
    },
  ],
  webServer: [
    { command: `npx vite preview --mode web --port ${PORT} --strictPort`, port: PORT, reuseExistingServer: false },
    { command: `npx vite preview --mode youtube --port ${YT_PORT} --strictPort`, port: YT_PORT, reuseExistingServer: false },
  ],
});
