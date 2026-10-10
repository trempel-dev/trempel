// hub.spec.ts — the page end to end: the list → a project → run `dev` (the kit's service on a free
// port) → its URL answers → stop (the URL goes down); two kit versions — two editors.
import { expect, test, type APIRequestContext } from '@playwright/test';

const CASUAL = '@trempel/template-casual';

// A dev server listens on `localhost`: IPv4 on Linux, `::1` on macOS — try both loopbacks.
async function answer(request: APIRequestContext, url: string, timeout = 10_000) {
  let last: unknown;
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      return await request.get(url.replace('localhost', host), { timeout });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

test('projects → casual → dev → the URL answers → stop', async ({ page, request }) => {
  await page.goto('/');
  const cards = page.getByTestId('project-card');
  await expect(cards).toHaveCount(2);
  const casual = page.locator(`[data-project="${CASUAL}"]`);
  await expect(casual.getByTestId('kit-version')).toHaveText('kit 2.4.1');
  await casual.getByTestId('project-link').click();
  await expect(page.getByTestId('project-name')).toHaveText(CASUAL);

  const dev = page.locator('[data-action="dev"]');
  await expect(dev.locator('.tag.layer-kit')).toBeVisible();
  await dev.getByTestId('run').click();
  const link = dev.getByTestId('service-url');
  await expect(link).toBeVisible({ timeout: 30_000 });
  const url = (await link.getAttribute('href'))!;
  expect(url).toMatch(/^http:\/\/localhost:\d+\/$/);
  await expect(dev.getByTestId('run-status')).toHaveText('ready', { timeout: 30_000 });
  const res = await answer(request, url);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('<script');
  await expect(page.getByTestId('log')).toContainText('[hub] ready');

  // the processes page lists it
  await page.goto('/#/processes');
  const proc = page.locator('[data-testid="process"][data-action="dev"]');
  await expect(proc).toContainText(CASUAL);
  await expect(proc).toContainText(url);
  await page.screenshot({ path: 'test-results/hub-processes.png', fullPage: true });

  await proc.getByTestId('stop').click();
  await expect(page.getByText('No services running.')).toBeVisible({ timeout: 15_000 });
  await expect(answer(request, url, 3000)).rejects.toThrow();

  // the run stays in the project's history, stopped
  await page.goto('/');
  await page.locator(`[data-project="${CASUAL}"]`).getByTestId('project-link').click();
  await expect(page.getByTestId('runs').locator('tr', { hasText: 'dev' }).first()).toContainText('stopped');
});

test('two kit versions: each project its own editor', async ({ page }) => {
  await page.goto('/');
  const old = page.locator('[data-project="old-game"]');
  await expect(old.getByTestId('kit-version')).toHaveText('kit 2.2.0');
  await page.screenshot({ path: 'test-results/hub-projects.png', fullPage: true });
  await old.getByTestId('project-link').click();
  const editor = page.locator('[data-action="editor"]');
  await expect(editor).toContainText('The editor of kit 2.2.0.');
  await expect(editor.locator('.tag.layer-kit')).toBeVisible();
  await editor.getByTestId('run').click();
  await expect(page.getByTestId('log')).toContainText('the editor of kit 2.2.0');
  await expect(page.getByTestId('log-status')).toHaveText('exited');

  await page.goto('/');
  await page.locator(`[data-project="${CASUAL}"]`).getByTestId('project-link').click();
  const cur = page.locator('[data-action="editor"]');
  await expect(cur).toContainText('service');
  await expect(cur).toContainText('The editor page of the scene package');
  await page.screenshot({ path: 'test-results/hub-project.png', fullPage: true });
});
