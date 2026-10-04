// e2e, v0.9 prefabs on a copy of examples/prefabs in tmp: the palette (⌘P) → drag a button
// onto the stage → an instance; a parameter in the inspector → the label changes; a double click opens
// the prefab; a prefab edited (in the editor, and on disk) → the instances are redrawn; detach → the
// children become editable.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { idle, openEditor, pressMod, root, type EditorPage } from './harness';

const T = 120_000;

/** What a drawn Pixi Text of the scene shows: text and fill (lowercase hex / number as is). */
const label = (e: EditorPage, id: string): Promise<{ text: string; fill: string } | null> =>
  e.page.evaluate((id) => {
    const h = window.tmlEdit!.session?.scene?.byId.get(id) as unknown as { text?: string; style?: { fill?: { color?: unknown } } } | undefined;
    if (!h) return null;
    return { text: String(h.text), fill: String(h.style?.fill?.color ?? '') };
  }, id);

const row = (id: string): string => `#tree li:has(> .name:text-is("#${id}"))`;

describe('editor e2e — v0.9 prefabs (examples/prefabs copy)', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-prefabs-'));
    for (const f of ['menu.svg', 'menu.tml.svg', 'menu.contract.xml', 'menu.state.json', 'ui']) cpSync(join(root, 'examples/prefabs', f), join(dir, f), { recursive: true });
    // the example's module imports the repo by relative path — in tmp, the same texts inline
    writeFileSync(join(dir, 'trempel.view.ts'), `export default { context: () => ({ t: (k) => ({ menu: 'Меню', play: 'Играть', settings: 'Настройки', exit: 'Выход' })[k] ?? k }) };\n`);
    e = await openEditor(dir, 'menu');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'the scene opens clean: instances are one row each (⟶ href), their insides grey; labels drawn',
    async () => {
      expect(e.errors).toEqual([]);
      expect(await e.page.evaluate(() => window.tmlEdit!.issues().filter((i) => i.level === 'error').map((i) => i.message))).toEqual([]);
      await expect(e.page.textContent(`${row('shopBtn')} .href`)).resolves.toBe('⟶ ui/button-green.svg');
      // collapsed instance: expand and see the prefab's rows read-only
      await e.page.click(`${row('shopBtn')} .tw`);
      expect(await e.page.getAttribute(row('shopBtn/label'), 'class')).toContain('foreign');
      expect(await label(e, 'playBtn/label')).toMatchObject({ text: 'Играть · 120' });
      expect(await label(e, 'shopBtn/label')).toMatchObject({ text: 'Магазин' });
    },
    T,
  );

  it(
    'palette ⌘P → drag the button onto the stage → an instance there; a parameter in the inspector → the label',
    async () => {
      await e.page.click('#stage-wrap', { position: { x: 5, y: 5 } }); // focus the page, not an input
      await pressMod(e.page, 'p');
      await e.page.waitForSelector('#prefabs:not([hidden]) .card[data-prefab="ui/button.svg"]');
      await e.page.waitForFunction(() => (document.querySelector('#prefabs .card[data-prefab="ui/button.svg"] img') as HTMLImageElement | null)?.src.startsWith('data:image/png'), null, { timeout: 30_000 });

      const box = (await e.page.locator('#stage-wrap').boundingBox())!;
      await e.page.dragAndDrop('#prefabs .card[data-prefab="ui/button.svg"]', '#stage-wrap', { targetPosition: { x: box.width / 2, y: box.height / 2 } });
      await e.page.waitForFunction(() => window.tmlEdit!.doc!.serialize().includes('<use id="button" href="ui/button.svg"'));
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.selection.map((p) => window.tmlEdit!.ref(p)))).toEqual(['button']);
      // a new instance without its required parameters — the inspector says so
      await e.page.waitForSelector('#inspector .err:text("не задан data-label")');
      expect(await label(e, 'button/label')).toMatchObject({ text: 'Кнопка' });

      await e.page.fill('#inspector [data-key="param:data-label"]', 'Новая');
      await e.page.press('#inspector [data-key="param:data-label"]', 'Enter');
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.doc!.serialize())).toContain('data-label="Новая"');
      expect(await label(e, 'button/label')).toMatchObject({ text: 'Новая' });
      await e.page.click('#prefabs header button'); // close the palette
      expect(await e.page.isHidden('#prefabs')).toBe(true);
    },
    T,
  );

  it(
    'double click on an instance opens the prefab; an edit there, saved → the menu draws it',
    async () => {
      await pressMod(e.page, 's'); // the dropped button is saved — opening another scene does not ask
      await e.page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
      await e.page.dblclick(`${row('exitBtn')} .name`);
      await e.page.waitForFunction(() => window.tmlEdit!.entry?.id === 'ui/button' && !!window.tmlEdit!.doc);
      await idle(e.page);
      const r = await e.page.evaluate(() => window.tmlEdit!.exec('node.setAttr', { node: 'label', name: 'fill', value: '#ffdd00' })!.ok);
      expect(r).toBe(true);
      await pressMod(e.page, 's');
      await e.page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
      expect(readFileSync(join(dir, 'ui/button.svg'), 'utf8')).toContain('fill="#ffdd00"');

      await e.page.evaluate(() => window.tml!.open('menu'));
      await e.page.waitForFunction(() => window.tmlEdit!.entry?.id === 'menu');
      await idle(e.page);
      expect((await label(e, 'exitBtn/label'))!.fill).toBe(String(0xffdd00));
    },
    T,
  );

  it(
    'a prefab changed on disk → the open scene redraws its instances',
    async () => {
      const file = join(dir, 'ui/button.svg');
      writeFileSync(file, readFileSync(file, 'utf8').replace('fill="#ffdd00"', 'fill="#00ccff"'));
      await e.page.waitForFunction(
        () => {
          const h = window.tmlEdit!.session?.scene?.byId.get('playBtn/label') as unknown as { style?: { fill?: { color?: unknown } } } | undefined;
          return h?.style?.fill?.color === 0x00ccff;
        },
        null,
        { timeout: 30_000 },
      );
    },
    T,
  );

  it(
    'detach → a <g> with the prefab content; its children are editable rows',
    async () => {
      await e.page.click(row('exitBtn'));
      await e.page.click('#inspector [data-key="detach"]');
      await idle(e.page);
      const text = await e.page.evaluate(() => window.tmlEdit!.doc!.serialize());
      expect(text).toContain('<g id="exitBtn" transform="translate(280 450)" data-size="240 72">');
      expect(text).not.toContain('<use id="exitBtn"');
      const path = await e.page.getAttribute(row('exitBtn/label'), 'data-path');
      expect(path).toMatch(/^\d+\/\d+$/);
      await e.page.click(row('exitBtn/label'));
      expect(await e.page.evaluate(() => window.tmlEdit!.selection.map((p) => window.tmlEdit!.ref(p)))).toEqual(['exitBtn/label']);
      expect(e.errors).toEqual([]);
    },
    T,
  );
});
