// e2e, v1.1 collections on a copy of examples/collections (game/scene on the shared skin `@skin`,
// the project file .trempel/project.mdz) in tmp: the scene with @-links opens clean; the prefab palette
// shows the collection as a group of its own; a card dragged from it is written as `href="@skin/…"`;
// ⌘S writes the base with that one line more — the scene's other @-links untouched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changedLines, idle, openEditor, pressMod, root, type EditorPage } from './harness';

const T = 120_000;
const EXAMPLE = join(root, 'examples/collections');

describe('editor e2e — v1.1 collections (examples/collections copy)', () => {
  let proj = '';
  let dir = '';
  let e: EditorPage;
  let before = '';
  beforeAll(async () => {
    proj = mkdtempSync(join(tmpdir(), 'tml-edit-coll-'));
    cpSync(EXAMPLE, proj, { recursive: true });
    dir = join(proj, 'game');
    before = readFileSync(join(dir, 'scene.svg'), 'utf8');
    e = await openEditor(dir, 'scene');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (proj) rmSync(proj, { recursive: true, force: true });
  });

  it(
    'the scene with @skin links opens without errors; the skin prefabs are expanded',
    async () => {
      expect(e.errors).toEqual([]);
      expect(await e.page.evaluate(() => window.tmlEdit!.issues().filter((i) => i.level === 'error').map((i) => i.message))).toEqual([]);
      expect(before).toContain('href="@skin/icon-button.svg"');
      expect(await e.page.evaluate(() => !!window.tmlEdit!.session?.scene?.byId.get('hudPanel/bg'))).toBe(true);
    },
    T,
  );

  it(
    'palette: the collection is a group; a card dragged from it writes href="@skin/…"; ⌘S — one line more',
    async () => {
      await e.page.click('#stage-wrap', { position: { x: 5, y: 5 } });
      await pressMod(e.page, 'p');
      await e.page.waitForSelector('#prefabs:not([hidden]) .group[data-group="@skin"]');
      const card = '#prefabs .card[data-prefab="@skin/button.svg"]';
      await e.page.waitForSelector(card);
      await e.page.waitForFunction((sel) => (document.querySelector(`${sel} img`) as HTMLImageElement | null)?.src.startsWith('data:image/png'), card, { timeout: 30_000 });
      const box = (await e.page.locator('#stage-wrap').boundingBox())!;
      await e.page.dragAndDrop(card, '#stage-wrap', { targetPosition: { x: box.width / 2, y: box.height / 2 } });
      await e.page.waitForFunction(() => window.tmlEdit!.doc!.serialize().includes('<use id="button" href="@skin/button.svg"'));
      await idle(e.page);
      // a new instance without its required parameters — the editor says so (as for a folder prefab)
      const errs = await e.page.evaluate(() => window.tmlEdit!.issues().filter((i) => i.level === 'error').map((i) => i.message));
      expect(errs.filter((m) => !/^#button: не задан параметр data-/.test(m))).toEqual([]);
      expect(errs.join('\n')).toContain('его требует @skin/button.svg');
      expect(await e.page.evaluate(() => !!window.tmlEdit!.session?.scene?.byId.get('button/bg'))).toBe(true);

      await pressMod(e.page, 's');
      await e.page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
      const after = readFileSync(join(dir, 'scene.svg'), 'utf8');
      expect(after).toContain('href="@skin/button.svg"');
      // one line inserted, every line of the scene (its @-links too) kept as written
      const old = new Set(before.split('\n'));
      expect(after.split('\n').filter((l) => !old.has(l))).toEqual([expect.stringContaining('<use id="button" href="@skin/button.svg"')]);
      expect(changedLines(before, after)).toBe(2); // the insertion + the closing tag it moved down
      for (const l of before.split('\n')) expect(after).toContain(l);
    },
    T,
  );
});
