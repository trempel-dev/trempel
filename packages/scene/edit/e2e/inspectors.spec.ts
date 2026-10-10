// e2e, 2.3: a scene that extends another one (no base of its own — a project heir): the base is
// read-only, the clips and the heir's effects are edited and saved; the consumer's inspectors
// (trempel.view.ts `inspectors`): a panel for the inspected node of its tml:type, a palette whose
// effect dropped on the stage becomes an effect node of the heir (heir.insertFx), an agent API
// (tml.inspect) — with a stand-in inspector (the kit's particle editor is tested in the kit's e2e).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { idle, openEditor, pressMod, type EditorPage } from './harness';

const T = 120_000;

const PARENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <g id="stage">
    <rect id="bg" width="400" height="300" fill="#204060"/>
  </g>
  <g id="spot" transform="translate(100 100)" data-effect="sparkle">
    <circle r="6" fill="#ffd54a"/>
  </g>
</svg>
`;
const HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="parent.svg">
  <tml:ref id="spot" tml:type="fx"/>
</svg>
`;
const CLIPS = `# $clip pop
$duration: 1

## $track bg
| t | alpha | ease |
|---|---|---|
| 0 | 1 | inOut |
| 1 | 0.5 | |
`;
// A stand-in inspector of `fx` nodes: shows the node, sets tml:effect; a palette of two effects; an API.
const MODULE = `export default {
  inspectors: {
    fx: {
      panel(host) {
        const el = document.createElement('div');
        el.id = 'stub-panel';
        el.textContent = host.node.id + ':' + (host.node.tml.effect ?? host.node.attrs['data-effect'] ?? '');
        const b = document.createElement('button');
        b.id = 'stub-set';
        b.onclick = () => host.exec('heir.setAttr', { node: host.node.id, name: host.node.inserted ? 'data-effect' : 'tml:effect', value: 'burst' });
        el.append(b);
        return { el, dispose() {} };
      },
      palette(host) {
        const el = document.createElement('div');
        for (const name of ['burst', 'smoke']) {
          const i = document.createElement('div');
          i.className = 'stub-fx';
          i.textContent = name;
          i.draggable = true;
          i.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-trempel-fx', name));
          el.append(i);
        }
        return { el, dispose() {} };
      },
      api(host) {
        return { files: () => host.files.list('') };
      },
    },
  },
};
`;

describe('editor e2e — 2.3: a scene extending another one, inspectors of the view module', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-insp-'));
    writeFileSync(join(dir, 'parent.svg'), PARENT);
    writeFileSync(join(dir, 'scene.tml.svg'), HEIR);
    mkdirSync(join(dir, 'anim'));
    writeFileSync(join(dir, 'anim/pop.md'), CLIPS);
    writeFileSync(join(dir, 'trempel.view.ts'), MODULE);
    e = await openEditor(dir, 'scene');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'the base is read-only (another scene\'s); the clips are edited and saved; no base file appears',
    async () => {
      expect(await e.page.evaluate(() => window.tml!.doc!.heirOnly)).toBe(true);
      const r = await e.page.evaluate(() => window.tml!.doc!.exec('node.setAttr', { node: 'bg', name: 'fill', value: '#000' }));
      expect(r.errors![0]).toMatch(/^E_EDITOR_READONLY: /);
      const k = await e.page.evaluate(() => window.tml!.clipsDoc()!.exec('key.set', { clip: 'pop', target: 'bg', column: 'alpha', t: 0.5, value: 0.25 }));
      expect(k.ok).toBe(true);
      await idle(e.page);
      await pressMod(e.page, 's');
      await e.page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
      expect(readFileSync(join(dir, 'anim/pop.md'), 'utf8')).toBe(CLIPS.replace('| 0 | 1 | inOut |\n', '| 0 | 1 | inOut |\n| 0.5 | 0.25 | inOut |\n'));
      expect(existsSync(join(dir, 'scene.svg'))).toBe(false);
      expect(readFileSync(join(dir, 'parent.svg'), 'utf8')).toBe(PARENT);
    },
    T,
  );

  it(
    'the inspector of fx: the selected node\'s panel; its command changes the heir (tml:effect on the ref)',
    async () => {
      expect(await e.page.evaluate(() => typeof (window.tml!.inspect.fx as { files?: unknown }).files)).toBe('function');
      await e.page.evaluate(() => window.tml!.select('spot'));
      await idle(e.page);
      await e.page.waitForSelector('#stub-panel');
      expect(await e.page.textContent('#stub-panel')).toBe('spot:sparkle');
      await e.page.click('#stub-set');
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tml!.doc!.serializeHeir())).toBe(HEIR.replace('tml:type="fx"/>', 'tml:type="fx" tml:effect="burst"/>'));
      await e.page.waitForFunction(() => document.querySelector('#stub-panel')?.textContent === 'spot:burst');
    },
    T,
  );

  it(
    'the palette: an effect dropped on the stage → an effect node of the heir in the selected group; ⌘S writes the heir',
    async () => {
      await e.page.evaluate(() => window.tml!.select('stage'));
      await idle(e.page);
      const box = (await e.page.locator('#stage-box').boundingBox())!;
      await e.page.evaluate(
        ({ x, y }) => {
          const dt = new DataTransfer();
          dt.setData('application/x-trempel-fx', 'smoke');
          document.getElementById('stage-wrap')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      await idle(e.page);
      const heir = await e.page.evaluate(() => window.tml!.doc!.serializeHeir()!);
      const added = heir.split('\n').filter((l) => !HEIR.includes(l) && !l.includes('tml:effect="burst"'));
      expect(added.length).toBe(1);
      expect(added[0]).toMatch(/^ {2}<g id="smokeFx" tml:insert="into stage" tml:type="fx" transform="translate\(\d+ \d+\)" data-effect="smoke"\/>$/);
      // the inserted node is inspected (it has no base path)
      await e.page.waitForFunction(() => window.tmlEdit!.inspected === 'smokeFx');
      await e.page.waitForFunction(() => document.querySelector('#stub-panel')?.textContent === 'smokeFx:smoke');
      expect(await e.page.locator('#tree li.inspectable', { hasText: '#smokeFx' }).count()).toBe(1);
      await pressMod(e.page, 's');
      await e.page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
      expect(readFileSync(join(dir, 'scene.tml.svg'), 'utf8')).toBe(heir);
      expect(e.errors).toEqual([]);
    },
    T,
  );
});
