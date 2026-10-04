// e2e, editor batch 3-A: the modal operators by keys (G X 120 under a rotated parent,
// R 45 → the inspector), the gizmo (drag the ring, type 90 mid-drag), the F3 palette (node.setId
// through the form), a heir without its own base (a note, not an error) — on scenes in tmp.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { idle, openEditor, root, type EditorPage } from './harness';

const T = 120_000;

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
  <rect id="bg" width="800" height="500" fill="#13233f"/>
  <g id="arm" transform="translate(300 200) rotate(30)">
    <rect id="box" x="0" y="0" width="80" height="50" fill="#f80"/>
  </g>
  <rect id="top" x="560" y="300" width="100" height="60" fill="#4af"/>
  <circle id="dot" cx="150" cy="380" r="30" fill="#6d6"/>
</svg>
`;

/** A base element's attributes from the document (not the file: no save needed). */
const attrs = (e: EditorPage, id: string): Promise<Record<string, string>> =>
  e.page.evaluate((id) => {
    const ed = window.tmlEdit!;
    return { ...ed.node(ed.pathOfId(id)!)!.attrs };
  }, id);

/** Put the pointer over the stage (operators started by a key measure from it). */
async function overStage(e: EditorPage, fx = 0.7, fy = 0.3): Promise<void> {
  const b = (await e.page.locator('#stage-box').boundingBox())!;
  await e.page.mouse.move(b.x + b.width * fx, b.y + b.height * fy);
}

async function type(e: EditorPage, keys: string): Promise<void> {
  for (const k of keys) await e.page.keyboard.press(k);
}

describe('editor e2e — batch 3-A: operators, gizmo, F3 (scene in tmp)', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-b3-'));
    writeFileSync(join(dir, 'scene.svg'), SCENE);
    e = await openEditor(dir, 'scene');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'G → X → 120 → Enter moves #box exactly 120 along its local X (the parent is turned 30°); Esc of the next one leaves no trace',
    async () => {
      await e.page.evaluate(() => window.tml!.select('box'));
      await idle(e.page);
      await overStage(e);
      await e.page.keyboard.press('g');
      expect(await e.page.isVisible('#opstatus')).toBe(true);
      await e.page.keyboard.press('x');
      await type(e, '120');
      expect(await e.page.textContent('#opstatus')).toMatch(/^Сдвиг X \(лок\.\): 120 px/);
      await e.page.keyboard.press('Enter');
      await idle(e.page);
      expect(await e.page.isVisible('#opstatus')).toBe(false);
      const a = await attrs(e, 'box');
      expect(Number(a.x)).toBe(120);
      expect(Number(a.y)).toBe(0);
      expect(await e.page.evaluate(() => window.tmlEdit!.doc!.history.length)).toBe(1);

      // a second operator, moved by the mouse and cancelled: the document and undo untouched
      const before = await e.page.evaluate(() => window.tmlEdit!.doc!.serialize());
      await e.page.keyboard.press('g');
      await e.page.mouse.move(300, 300, { steps: 4 });
      await e.page.keyboard.press('Escape');
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.doc!.serialize())).toBe(before);
      expect(await e.page.evaluate(() => window.tmlEdit!.doc!.history.length)).toBe(1);
      expect(e.errors).toEqual([]);
    },
    T,
  );

  it(
    'R → 45 → Enter: rotate 45 in the inspector (about the node centre)',
    async () => {
      await e.page.evaluate(() => window.tml!.select('top'));
      await idle(e.page);
      await overStage(e, 0.2, 0.2);
      await e.page.keyboard.press('r');
      await type(e, '45');
      expect(await e.page.textContent('#opstatus')).toMatch(/^Поворот: 45°/);
      await e.page.keyboard.press('Enter');
      await idle(e.page);
      expect(await e.page.inputValue('#inspector input[data-key="rot"]')).toBe('45');
      expect(await e.page.inputValue('#inspector input[data-key="pv:0"]')).toBe('610');
      expect((await attrs(e, 'top')).transform).toMatch(/^translate\(610[ ,]330\) rotate\(45\) translate\(-610[ ,]-330\)$/);
    },
    T,
  );

  it(
    'gizmo: drag the ring and type 90 mid-drag — rotate 90 on release, one undo entry',
    async () => {
      await e.page.evaluate(() => window.tml!.select('dot'));
      await idle(e.page);
      const n0 = await e.page.evaluate(() => window.tmlEdit!.doc!.history.length);
      const L = await e.page.evaluate(() => window.tmlGizmo!.layout);
      const b = (await e.page.locator('#stage-box').boundingBox())!;
      const at = { x: b.x + L!.at.rotate!.x, y: b.y + L!.at.rotate!.y }; // on the ring, between the axes
      await e.page.mouse.move(at.x, at.y);
      await e.page.mouse.down();
      await e.page.mouse.move(at.x + 10, at.y + 25, { steps: 3 });
      expect(await e.page.textContent('#opstatus')).toMatch(/^Поворот: /);
      await type(e, '90');
      await e.page.mouse.move(at.x + 20, at.y + 40, { steps: 2 }); // the typed value wins over the pointer
      await e.page.mouse.up();
      await idle(e.page);
      expect(await e.page.inputValue('#inspector input[data-key="rot"]')).toBe('90');
      expect(await e.page.evaluate(() => window.tmlEdit!.doc!.history.length)).toBe(n0 + 1);
    },
    T,
  );

  it(
    'F3 → node.setId → the form (node prefilled) → the node is renamed',
    async () => {
      await e.page.evaluate(() => window.tml!.select('dot'));
      await idle(e.page);
      await overStage(e);
      await e.page.keyboard.press('F3');
      await e.page.waitForSelector('#palette input');
      await e.page.fill('#palette input', 'setId');
      await e.page.keyboard.press('Enter');
      await e.page.waitForSelector('#cmd-form');
      expect(await e.page.inputValue('#cmd-form input[name="node"]')).toBe('dot');
      await e.page.fill('#cmd-form input[name="id"]', 'ball');
      await e.page.keyboard.press('Enter');
      await idle(e.page);
      expect(await e.page.$('#cmd-form')).toBeNull();
      expect(await e.page.evaluate(() => window.tmlEdit!.pathOfId('ball'))).not.toBeNull();
      expect(await e.page.evaluate(() => window.tmlEdit!.pathOfId('dot'))).toBeNull();
    },
    T,
  );
});

describe('editor e2e — a heir without its own base (examples/prefabs copy)', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-b3p-'));
    for (const f of ['menu.svg', 'menu.tml.svg', 'menu.contract.xml', 'menu.state.json', 'ui']) cpSync(join(root, 'examples/prefabs', f), join(dir, f), { recursive: true });
    writeFileSync(join(dir, 'trempel.view.ts'), `export default { context: () => ({ t: (k) => k }) };\n`);
    e = await openEditor(dir, 'menu');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'ui/button-green: «наследник от button — база правится там», no red error; «открыть» opens ui/button',
    async () => {
      await e.page.evaluate(() => window.tml!.open('ui/button-green'));
      await idle(e.page);
      expect(await e.page.isVisible('#nobase')).toBe(true);
      expect(await e.page.textContent('#nobase')).toContain('наследник от button');
      expect(await e.page.evaluate(() => window.tmlEdit!.issues().filter((i) => i.level === 'error').length)).toBe(0);
      await e.page.click('#nobase button');
      await e.page.waitForFunction(() => window.tmlEdit!.entry?.id === 'ui/button' && !!window.tmlEdit!.doc);
      expect(await e.page.isVisible('#nobase')).toBe(false);
    },
    T,
  );
});
