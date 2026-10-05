// e2e, v1.0 on a copy of examples/prefabs in tmp: the inspector's slice lines over a 9-slice
// image; the gizmo stretches the pause panel by width/height (its title stays centred); the palette
// drops a panel and the inspector shows its size.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { idle, openEditor, pressMod, root, type EditorPage } from './harness';

const T = 120_000;

/** A scene of its own with a 9-slice image in the base (selectable — prefab insides are not). */
const SLICED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
  <rect id="bg" width="800" height="600" fill="#141a2e"/>
  <image id="frame" href="ui/art/panel.png" x="100" y="100" width="500" height="360" data-slices="40 96 40 40"/>
</svg>
`;

describe('editor e2e — v1.0: slices, resizable panel, palette (examples/prefabs copy)', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-v10-'));
    for (const f of ['popup-pause.svg', 'popup-pause.tml.svg', 'popup-pause.contract.xml', 'anim', 'ui']) cpSync(join(root, 'examples/prefabs', f), join(dir, f), { recursive: true });
    writeFileSync(join(dir, 'trempel.view.ts'), `export default { context: () => ({ t: (k) => ({ settings: 'Settings', exit: 'Exit', paused: 'Paused' })[k] ?? k }) };\n`);
    e = await openEditor(dir, 'popup-pause');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'the popup opens clean; the gizmo stretches the panel — width/height written, the title stays centred',
    async () => {
      expect(e.errors).toEqual([]);
      expect(await e.page.evaluate(() => window.tmlEdit!.issues().filter((i) => i.level === 'error').map((i) => i.message))).toEqual([]);
      const titleX = (): Promise<number> => e.page.evaluate(() => Number((window.tmlEdit!.session!.scene!.byId.get('pause/title') as unknown as { x: number }).x));
      expect(await titleX()).toBe(300);

      await e.page.evaluate(() => window.tml!.select('pause'));
      await idle(e.page);
      // the inspector shows the instance's size
      expect(await e.page.inputValue('#inspector input[data-key="size:width"]')).toBe('600');
      expect(await e.page.inputValue('#inspector input[data-key="size:height"]')).toBe('800');

      const L = await e.page.evaluate(() => window.tmlGizmo!.layout);
      const b = (await e.page.locator('#stage-box').boundingBox())!;
      const at = { x: b.x + L!.at['scale-x']!.x, y: b.y + L!.at['scale-x']!.y };
      await e.page.mouse.move(at.x, at.y);
      await e.page.mouse.down();
      await e.page.mouse.move(at.x - 15, at.y, { steps: 3 });
      expect(await e.page.textContent('#opstatus')).toMatch(/^Scale/);
      await e.page.keyboard.type('0.8'); // typed mid-drag: the factor
      await e.page.mouse.up();
      await idle(e.page);

      const doc = await e.page.evaluate(() => window.tmlEdit!.doc!.serialize());
      expect(doc).toMatch(/<use id="pause" href="ui\/panel.svg" x="120" y="100" width="480" height="800"/);
      expect(doc).not.toMatch(/id="pause"[^>]*transform/);
      // the panel is drawn at its new size: the 9-slice background and the anchored title
      expect(await titleX()).toBe(240);
      const bgW = await e.page.evaluate(() => Number((window.tmlEdit!.session!.scene!.byId.get('pause/bg') as unknown as { width: number }).width));
      expect(bgW).toBe(480);
      expect(await e.page.inputValue('#inspector input[data-key="size:width"]')).toBe('480');
      expect(e.errors).toEqual([]);
    },
    T,
  );

  it(
    'the palette (⌘P) → drag the panel onto the stage → the inspector shows its size (the minimum)',
    async () => {
      await e.page.click('#stage-wrap', { position: { x: 5, y: 5 } });
      await pressMod(e.page, 'p');
      await e.page.waitForSelector('#prefabs:not([hidden]) .card[data-prefab="ui/panel.svg"]');
      const box = (await e.page.locator('#stage-wrap').boundingBox())!;
      await e.page.dragAndDrop('#prefabs .card[data-prefab="ui/panel.svg"]', '#stage-wrap', { targetPosition: { x: box.width / 2, y: box.height / 3 } });
      await e.page.waitForFunction(() => window.tmlEdit!.doc!.serialize().includes('href="ui/panel.svg"') && window.tmlEdit!.selection.length === 1 && window.tmlEdit!.ref(window.tmlEdit!.selection[0]) !== 'pause');
      await idle(e.page);
      expect(await e.page.inputValue('#inspector input[data-key="size:width"]')).toBe('320');
      expect(await e.page.inputValue('#inspector input[data-key="size:height"]')).toBe('240');
      expect(await e.page.textContent('#inspector .row.size .muted')).toBe('min 320×240 · xy');
      // the size field writes width
      await e.page.fill('#inspector input[data-key="size:width"]', '400');
      await e.page.press('#inspector input[data-key="size:width"]', 'Enter');
      await idle(e.page);
      const id = await e.page.evaluate(() => window.tmlEdit!.ref(window.tmlEdit!.selection[0]));
      expect(await e.page.evaluate(() => window.tmlEdit!.doc!.serialize())).toMatch(new RegExp(`<use id="${id}" href="ui/panel.svg"[^>]* width="400"`));
      await e.page.click('#prefabs header button');
    },
    T,
  );
});

describe('editor e2e — v1.0: a 9-slice image in the base', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-v10s-'));
    cpSync(join(root, 'examples/prefabs/ui'), join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'sliced.svg'), SLICED);
    e = await openEditor(dir, 'sliced');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'the inspector has data-slices, the stage shows the four slice lines; S writes the size',
    async () => {
      await e.page.evaluate(() => window.tml!.select('frame'));
      await idle(e.page);
      expect(await e.page.inputValue('#inspector input[data-key="attr:data-slices"]')).toBe('40 96 40 40');
      const lines = await e.page.evaluate(() =>
        [...document.querySelectorAll('svg .slices line')].map((l) => ({
          cls: l.getAttribute('class'),
          x1: Number(l.getAttribute('x1')),
          y1: Number(l.getAttribute('y1')),
          x2: Number(l.getAttribute('x2')),
          y2: Number(l.getAttribute('y2')),
        })),
      );
      expect(lines).toEqual([
        { cls: 'slice l', x1: 140, y1: 100, x2: 140, y2: 460 },
        { cls: 'slice r', x1: 560, y1: 100, x2: 560, y2: 460 },
        { cls: 'slice t', x1: 100, y1: 196, x2: 600, y2: 196 },
        { cls: 'slice b', x1: 100, y1: 420, x2: 600, y2: 420 },
      ]);
      // S on it writes width/height (a 9-slice keeps its borders), not a transform
      await e.page.evaluate(() => window.tml!.op('S', { axis: 'x', value: 1.2 }));
      await idle(e.page);
      const doc = await e.page.evaluate(() => window.tmlEdit!.doc!.serialize());
      expect(doc).toMatch(/<image id="frame" href="ui\/art\/panel.png" x="50" y="100" width="600" height="360" data-slices/);
      expect(e.errors).toEqual([]);
    },
    T,
  );
});
