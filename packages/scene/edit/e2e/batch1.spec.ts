// e2e, editor batch 1: pan/zoom by the view (pinch, two-finger scroll), the console
// (tml.run one undo step) and a macro from the ⌘K palette — on a copy of examples/motion in tmp
// (with its .trempel/macros).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { idle, openEditor, pressMod, root, type EditorPage } from './harness';

const T = 120_000;

/** A wheel event on the stage at a client point (what a trackpad sends: pinch = ctrlKey). */
async function wheel(e: EditorPage, at: { x: number; y: number }, init: { deltaX?: number; deltaY?: number; ctrlKey?: boolean }): Promise<void> {
  await e.page.evaluate(
    ({ at, init }) => {
      const wrap = document.getElementById('stage-wrap')!;
      wrap.dispatchEvent(new WheelEvent('wheel', { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, deltaMode: 0, ...init }));
    },
    { at, init },
  );
}

/** Scene point under a client point (by the editor's own view). */
const sceneAt = (e: EditorPage, at: { x: number; y: number }): Promise<{ x: number; y: number }> =>
  e.page.evaluate((at) => {
    const ed = window.tmlEdit!;
    const r = document.getElementById('stage-box')!.getBoundingClientRect();
    const [a, , , d, tx, ty] = ed.view();
    return { x: (at.x - r.left - tx) / a, y: (at.y - r.top - ty) / d };
  }, at);

const serialized = (e: EditorPage): Promise<string> => e.page.evaluate(() => window.tmlEdit!.doc!.serialize());

describe('editor e2e — batch 1: pan/zoom, console, macros (examples/motion copy)', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-b1-'));
    for (const f of ['scene.svg', 'scene.tml.svg', 'scene.contract.xml', 'scene.state.json', 'anim', 'art', '.trempel']) cpSync(join(root, 'examples/motion', f), join(dir, f), { recursive: true });
    e = await openEditor(dir, 'scene');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'pinch (wheel + ctrlKey) zooms to the cursor: the scene point under it stays',
    async () => {
      const box = (await e.page.locator('#stage-box').boundingBox())!;
      const at = { x: Math.round(box.x + box.width * 0.3), y: Math.round(box.y + box.height * 0.6) }; // MouseEvent.clientX is whole px
      const z0 = await e.page.evaluate(() => window.tmlEdit!.zoomValue());
      const before = await sceneAt(e, at);
      for (let i = 0; i < 5; i++) await wheel(e, at, { deltaY: -12, ctrlKey: true });
      const z1 = await e.page.evaluate(() => window.tmlEdit!.zoomValue());
      expect(z1).toBeGreaterThan(z0 * 1.5);
      const after = await sceneAt(e, at);
      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.01);
      // the canvas really went there: its box is the view's
      const canvas = (await e.page.locator('#canvas-slot canvas').boundingBox())!;
      const o = await e.page.evaluate(() => window.tmlEdit!.origin());
      expect(Math.abs(canvas.x - (box.x + o.x))).toBeLessThan(1);
      await pressMod(e.page, '0');
      expect(await e.page.evaluate(() => [window.tmlEdit!.zoom, window.tmlEdit!.offset])).toEqual([null, { x: 0, y: 0 }]);
    },
    T,
  );

  it(
    'two-finger scroll pans: the gizmo moves by the same delta; the pan lands in the URL',
    async () => {
      await e.page.evaluate(() => window.tml!.select('satellite'));
      await idle(e.page);
      const xy = '#gizmo [data-h="move-xy"]';
      const p0 = (await e.page.locator(xy).boundingBox())!;
      const box = (await e.page.locator('#stage-box').boundingBox())!;
      await wheel(e, { x: box.x + 100, y: box.y + 100 }, { deltaX: 40, deltaY: -25 });
      const p1 = (await e.page.locator(xy).boundingBox())!;
      expect(p1.x - p0.x).toBeCloseTo(-40, 0);
      expect(p1.y - p0.y).toBeCloseTo(25, 0);
      await expect.poll(() => e.page.evaluate(() => location.search), { timeout: 3000 }).toContain('ox=-40&oy=25');
      await pressMod(e.page, '0');
    },
    T,
  );

  it(
    'console: tml.doc.exec(node.move) + ⌘Enter moves the node; ⌘Z brings it back',
    async () => {
      const orig = await serialized(e);
      await e.page.click('#bottom-tabs .tab[data-tab="console"]');
      await e.page.fill('#console-in', "tml.doc.exec('node.move',{node:'satellite',dx:10,dy:0})");
      await pressMod(e.page, 'Enter');
      await e.page.waitForFunction(() => window.tmlEdit!.doc!.canUndo);
      await idle(e.page);
      expect(await serialized(e)).toContain('id="satellite" transform="translate(690 130)"');
      expect(await e.page.locator('#console-out .c-result').last().textContent()).toContain('"ok":true');
      expect(await e.page.inputValue('#console-in')).toBe('');
      await e.page.keyboard.press('Escape'); // leave the field: ⌘Z is the page's again
      await pressMod(e.page, 'z');
      await idle(e.page);
      expect(await serialized(e)).toBe(orig);
      // history: ↑ brings the script back
      await e.page.focus('#console-in');
      await e.page.keyboard.press('ArrowUp');
      expect(await e.page.inputValue('#console-in')).toContain('node.move');
      await e.page.fill('#console-in', '');
      await e.page.keyboard.press('Escape');
    },
    T,
  );

  it(
    'macro from the ⌘K palette applies as one step and one ⌘Z rolls it back',
    async () => {
      const orig = await serialized(e);
      await e.page.evaluate(() => window.tml!.select(['sun', 'satellite', 'window']));
      await idle(e.page);
      const lefts = await e.page.evaluate(() => ['sun', 'satellite', 'window'].map((id) => window.tml!.bounds(id)!.x));
      await pressMod(e.page, 'k');
      await e.page.waitForSelector('#palette input');
      await e.page.keyboard.type('левому');
      await e.page.keyboard.press('Enter');
      await e.page.waitForFunction(() => window.tmlEdit!.doc!.history.length > 0 && !window.tmlEdit!.doc!.grouping);
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.doc!.history.map((h) => h.label))).toEqual(['Выровнять выделение по левому краю']);
      const after = await e.page.evaluate(() => ['sun', 'satellite', 'window'].map((id) => window.tml!.bounds(id)!.x));
      for (const x of after) expect(x).toBeCloseTo(Math.min(...lefts), 1);
      await pressMod(e.page, 'z');
      await idle(e.page);
      expect(await serialized(e)).toBe(orig);
      expect(e.errors).toEqual([]);
    },
    T,
  );
});
