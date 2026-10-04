// harness.ts — e2e plumbing: the editor's dev server over a folder (edit/vite.config.ts, like
// `npm run edit`) and a headless Chromium page on it (SwiftShader WebGL, as view:shot).
// Ports: E2E_PORT_BASE + n when set (parallel runs of the repo keep apart), else any free one.
// One browser per test file (module state — vitest isolates files), closed with its last page;
// Playwright waits up to 60 s; the optimizer cache is the e2e's own (.vite-edit-e2e), so a running
// `npm run edit` (.vite-edit) is never re-optimized under the test or the other way round.

import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import type { ViteDevServer } from 'vite';

export const root = fileURLToPath(new URL('../..', import.meta.url));

let portSeq = 0;
export const WAIT = 60_000;
let shared: { browser: Promise<Browser>; users: number } | null = null;

async function browserFor(): Promise<Browser> {
  const { chromium } = await import('playwright');
  shared ??= { browser: chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }), users: 0 };
  shared.users++;
  return shared.browser;
}

async function releaseBrowser(): Promise<void> {
  if (!shared) return;
  if (--shared.users > 0) return;
  const b = shared.browser;
  shared = null;
  await (await b).close();
}

export interface EditorPage {
  server: ViteDevServer;
  browser: Browser;
  page: Page;
  url: string;
  errors: string[];
  close(): Promise<void>;
}

export async function openEditor(dir: string, scene: string): Promise<EditorPage> {
  const { createServer } = await import('vite');
  process.env.TML_VIEW_DIR = dir;
  process.env.TML_VIEW_QUIET = '1';
  delete process.env.TML_VIEW_MODULE;
  const base = Number(process.env.E2E_PORT_BASE);
  const port = Number.isFinite(base) && base > 0 ? base + 10 + portSeq++ : 0;
  const server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    cacheDir: fileURLToPath(new URL('../../node_modules/.vite-edit-e2e', import.meta.url)),
    server: { port, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('vite did not report a local URL');
  const browser = await browserFor();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}?scene=${encodeURIComponent(scene)}`, { timeout: WAIT });
  await page.waitForFunction(() => !!window.tmlEdit?.doc, null, { timeout: WAIT });
  await idle(page);
  return {
    server,
    browser,
    page,
    url,
    errors,
    async close() {
      await context.close().catch(() => {});
      await releaseBrowser();
      await server.close();
    },
  };
}

/** Wait until the editor drew the newest state. */
export const idle = (page: Page): Promise<void> => page.evaluate(() => window.tmlEdit!.idle());

/** ⌘S on macOS, Ctrl+S elsewhere (the page decides by navigator.platform). */
export async function pressMod(page: Page, key: string): Promise<void> {
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.keyboard.press(`${mac ? 'Meta' : 'Control'}+${key}`);
}

/** Lines that differ (same line count expected for in-place edits). */
export function changedLines(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}
