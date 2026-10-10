// editor-fx.spec.ts — kit 2.3: the particle editor of the scene editor (kitView → inspectors.fx).
// The scene package's editor (`npm run edit`) over a scene with an effect node whose effect is one
// system of a converter's systems.json (the game imports it; kitView({ effectSources }) says where):
// rate ×2 and a new colour → the preview changes; save → only that system's lines of systems.json
// change; the palette's effect dropped on the stage → an effect node of the heir; view:shot of the
// scene with the effect — the same picture 10 runs out of 10.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/** What the editor page exposes (the scene package's edit page: window.tmlEdit, window.tml). */
interface EditPage {
  doc: { dirty: boolean; serializeHeir(): string | undefined } | null;
  session: { scene: { components: Map<string, unknown> } | null } | null;
  idle(): Promise<void>;
}
interface EditTml {
  doc: { serializeHeir(): string | undefined } | null;
  select(nodes: string | string[]): string[];
  inspect: Record<string, unknown>;
}
declare global {
  interface Window {
    tmlEdit?: EditPage;
    tml?: EditTml;
  }
}

const require = createRequire(import.meta.url);
const scene = dirname(require.resolve('@trempel/scene/package.json'));
const here = dirname(fileURLToPath(import.meta.url));
// inside the template (its imports resolve like the game's), a dot-folder git ignores
const DIR = join(here, '..', `.e2e-editor-fx-${process.pid}`);
const PORT = Number(process.env.E2E_PORT ?? 4280) + 7;

const conf = (key: string, rate: number, color: number[]) => ({
  key, cls: 'auto', unit: [100, 100], pos: [0, 0], duration: 1, loop: true, prewarm: false, startDelay: 0,
  lifetime: [0.6, 1], speed: 0.6, size: 0.12, color, rotation: 0, flipRotation: 0, gravity: 0, max: 200, rate,
  bursts: [], shape: { type: 'circle', radius: 0.3, thickness: 1, arc: 6.283185307179586, scale: [1, 1] },
  render: { mode: 'billboard', lengthScale: 1, velocityScale: 0 }, texture: 'circle', blend: 'add', tint: [1, 1, 1, 1],
});
// a converter's file: one-space indent, three systems; the scene's effect is the middle one
const SYSTEMS = JSON.stringify([conf('a', 4, [1, 1, 1, 1]), conf('glow', 12, [1, 0.8, 0.3, 1]), conf('c', 6, [0.3, 0.6, 1, 1])], null, 1);

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <rect id="bg" width="400" height="300" fill="#141a26"/>
  <g id="stage">
    <g id="hint" transform="translate(200 150)" data-effect="glow" data-seed="3"/>
  </g>
</svg>
`;
const HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">
  <tml:ref id="hint" tml:type="fx"/>
</svg>
`;
const MODULE = `import { kitView } from '@trempel/kit/view';
import systems from './fx/particles/systems.json';

export default kitView({
  skin: false,
  effects: { glow: [systems[1]], pair: [systems[0], systems[2]] },
  effectSources: { 'fx/particles/systems.json': systems },
  background: '#141a26',
});
`;

let server: ChildProcess | null = null;

async function waitUp(url: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the editor did not start at ${url}`);
}

/** Particles alive in the node's effect now. */
const particles = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const c = window.tmlEdit!.session!.scene!.components.get('hint') as { node: { host: { keys(): string[]; run(k: string): { effect: { emitters: { sim: { count: number } }[] } } } } };
    const h = c.node.host;
    return h.keys().reduce((s, k) => s + (h.run(k)?.effect?.emitters.reduce((n, e) => n + e.sim.count, 0) ?? 0), 0);
  });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'fx/particles'), { recursive: true });
  writeFileSync(join(DIR, 'scene.svg'), SCENE);
  writeFileSync(join(DIR, 'scene.tml.svg'), HEIR);
  writeFileSync(join(DIR, 'fx/particles/systems.json'), SYSTEMS);
  writeFileSync(join(DIR, 'trempel.view.ts'), MODULE);
  server = spawn(process.execPath, [join(scene, 'edit/cli.mjs'), DIR, '--port', String(PORT)], { stdio: 'ignore', env: { ...process.env, TML_VIEW_QUIET: '1' } });
  await waitUp(`http://localhost:${PORT}/__tml/scenes`);
});

test.afterAll(async () => {
  server?.kill();
  rmSync(DIR, { recursive: true, force: true });
});

test('the fx inspector: rate ×2 and a colour change the preview; save rewrites only that system of systems.json', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`http://localhost:${PORT}/?scene=scene`);
  await page.waitForFunction(() => !!window.tmlEdit?.doc, null, { timeout: 120_000 });
  await page.evaluate(() => window.tmlEdit!.idle());
  await page.evaluate(() => window.tml!.select('hint'));
  await page.waitForSelector('.fx-inspector [data-key="rate"]');
  expect(await page.textContent('.fx-inspector .muted')).toContain('fx/particles/systems.json · systems 1');
  // the preview: particles of the node at 1 s with the rate as written, then ×2
  await page.waitForTimeout(1200);
  const before = await particles(page);
  await page.fill('.fx-inspector [data-key="rate"]', '24');
  await page.press('.fx-inspector [data-key="rate"]', 'Enter');
  await page.locator('.fx-inspector details:has(summary:text("colour")) input[data-key="color"]').evaluate((i: HTMLInputElement) => {
    i.value = '#ff2040';
    i.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1200);
  expect(await particles(page)).toBeGreaterThan(before * 1.5);
  expect(await page.evaluate(() => (window.tml!.inspect.fx as { get(n: string): { rate: number; color: number[] }[] }).get('glow')[0])).toMatchObject({ rate: 24, color: [1, 0.125, 0.251, 1] });
  // save: only the edited system's lines of the converter's file
  await page.click('.fx-inspector [data-key="save"]');
  await page.waitForFunction(() => (window.tml!.inspect.fx as { unsaved(): string[] }).unsaved().length === 0);
  const a = SYSTEMS.split('\n');
  const b = readFileSync(join(DIR, 'fx/particles/systems.json'), 'utf8').split('\n');
  expect(b.length).toBe(a.length);
  const changedAt = a.map((l, i) => (l !== b[i] ? i : -1)).filter((i) => i >= 0);
  const glow = a.findIndex((l) => l.includes('"key": "glow"'));
  const next = a.findIndex((l, i) => i > glow && l.includes('"key": "c"'));
  expect(changedAt.length).toBeGreaterThan(0);
  expect(changedAt.every((i) => i > glow && i < next)).toBe(true);
  expect(JSON.parse(b.join('\n'))[1]).toMatchObject({ key: 'glow', rate: 24 });
  // the agent's «rate ×2» through tml.inspect.fx — the same edit as the panel's, saved the same way
  await page.evaluate(() => (window.tml!.inspect.fx as { update(n: string, f: (c: { rate: number }[]) => void): void }).update('glow', (c) => void (c[0].rate *= 2)));
  await page.evaluate(() => (window.tml!.inspect.fx as { save(n: string): Promise<string> }).save('glow'));
  expect(JSON.parse(readFileSync(join(DIR, 'fx/particles/systems.json'), 'utf8'))[1].rate).toBe(48);
});

test('the palette: an effect dropped on the stage → an effect node of the heir in the selected group', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`http://localhost:${PORT}/?scene=scene`);
  await page.waitForFunction(() => !!window.tmlEdit?.doc, null, { timeout: 120_000 });
  await page.evaluate(() => window.tml!.select('stage'));
  await page.waitForSelector('.fx-palette .fx-item[data-effect="sparkle"]');
  const box = (await page.locator('#stage-box').boundingBox())!;
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await page.dispatchEvent('.fx-palette .fx-item[data-effect="sparkle"]', 'dragstart', { dataTransfer: dt });
  await page.dispatchEvent('#stage-wrap', 'drop', { dataTransfer: dt, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  await page.evaluate(() => window.tmlEdit!.idle());
  const heir = await page.evaluate(() => window.tml!.doc!.serializeHeir()!);
  const added = heir.split('\n').filter((l) => !HEIR.split('\n').includes(l));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatch(/^ {2}<g id="sparkleFx" tml:insert="into stage" tml:type="fx" transform="translate\(-?\d+ -?\d+\)" data-effect="sparkle"\/>$/);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
  expect(readFileSync(join(DIR, 'scene.tml.svg'), 'utf8')).toBe(heir);
});

test('view:shot of the scene with the effect: 10 runs, bit for bit', async () => {
  test.setTimeout(600_000);
  // the editor is done with the folder: view:shot is a tool of its own
  server?.kill();
  server = null;
  const shots = new Set<string>();
  const order: string[] = [];
  for (let i = 0; i < 10; i++) {
    const out = join(DIR, `shot-${i}.png`);
    const json = execFileSync(process.execPath, [join(scene, 'view/bin.mjs'), 'view:shot', join(DIR, 'scene'), '--out', out, '--settle', '1'], { encoding: 'utf8', timeout: 180_000 });
    expect(JSON.parse(json).errors).toEqual([]);
    const h = createHash('sha1').update(readFileSync(out)).digest('hex');
    shots.add(h);
    order.push(h.slice(0, 6));
  }
  expect(shots.size, order.join(' ')).toBe(1);
});
