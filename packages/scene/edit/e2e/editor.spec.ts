// e2e: the editor page in headless Chromium over copies of the examples in tmp —
// examples/prefabs (gizmo drag, save, undo) and examples/motion (path tool, mask by bounds, contract).
// Each step goes through the UI (tree, handles, keys, context menu); the file on disk is the check.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, type SceneNode } from '../../src/core';
import { pathFromNode } from '../../src/geom/path';
import { changedLines, idle, openEditor, pressMod, root, type EditorPage } from './harness';

const T = 120_000;

const row = (id: string): string => `#tree li:has(> .name:text-is("#${id}"))`;

/** Drag the gizmo's XY square (free move, the G operator; release confirms). */
async function dragGizmo(e: EditorPage, dx: number, dy: number): Promise<void> {
  const box = await e.page.locator('#gizmo [data-h="move-xy"]').boundingBox();
  if (!box) throw new Error('no gizmo on the stage');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await e.page.mouse.move(x, y);
  await e.page.mouse.down();
  for (let i = 1; i <= 10; i++) await e.page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
  await e.page.mouse.up();
  await idle(e.page);
}

async function saved(e: EditorPage): Promise<void> {
  await pressMod(e.page, 's');
  await e.page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
}

const find = (n: SceneNode, id: string): SceneNode | undefined => {
  if (n.attrs.id === id) return n;
  for (const c of n.children) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return undefined;
};

describe('editor e2e — gizmo drag, save, undo (examples/prefabs copy)', () => {
  let dir = '';
  let e: EditorPage;
  let original = '';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-prefabs-'));
    for (const f of ['menu.svg', 'menu.tml.svg', 'menu.contract.xml', 'menu.state.json', 'ui']) cpSync(join(root, 'examples/prefabs', f), join(dir, f), { recursive: true });
    writeFileSync(join(dir, 'trempel.view.ts'), `export default { context: () => ({ t: (k) => k }) };\n`);
    original = readFileSync(join(dir, 'menu.svg'), 'utf8');
    e = await openEditor(dir, 'menu');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'select a node in the tree, drag the gizmo by 50 px, ⌘S — exactly one line of menu.svg changed',
    async () => {
      await e.page.click(row('settingsBtn'));
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.selection.map((p) => window.tmlEdit!.node(p)?.attrs.id))).toEqual(['settingsBtn']);
      const x0 = Number(find(parse(original), 'settingsBtn')!.attrs.x);
      await dragGizmo(e, -50, 0);
      await saved(e);
      const after = readFileSync(join(dir, 'menu.svg'), 'utf8');
      expect(changedLines(original, after)).toBe(1);
      const x = Number(find(parse(after), 'settingsBtn')!.attrs.x);
      const zoom = await e.page.evaluate(() => window.tmlEdit!.zoomValue() * window.tmlEdit!.fit.scale);
      // free move snaps to the neighbours' edges within 6 px of the screen
      expect(Math.abs(x - (x0 - 50 / zoom))).toBeLessThanOrEqual(6 / zoom + 0.5);
      expect(e.errors).toEqual([]);
    },
    T,
  );

  it(
    '⌘Z after the save, ⌘S again — the file is back byte for byte',
    async () => {
      await pressMod(e.page, 'z');
      await idle(e.page);
      await saved(e);
      expect(readFileSync(join(dir, 'menu.svg'), 'utf8')).toBe(original);
    },
    T,
  );
});

describe('editor e2e — examples/motion (copy in tmp)', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-motion-'));
    for (const f of ['scene.svg', 'scene.tml.svg', 'scene.contract.xml', 'scene.state.json', 'anim', 'art']) cpSync(join(root, 'examples/motion', f), join(dir, f), { recursive: true });
    e = await openEditor(dir, 'scene');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'path tool on #fly1: Alt+click on the contour inserts a point, the shape (pathFromNode) stays',
    async () => {
      const read = (): SceneNode => find(parse(readFileSync(join(dir, 'scene.svg'), 'utf8')), 'fly1')!;
      const before = pathFromNode(read());
      await e.page.evaluate(() => window.tmlEdit!.select([window.tmlEdit!.pathOfId('fly1')!]));
      await e.page.keyboard.press('Tab'); // blender scheme (figma: P)
      expect(await e.page.evaluate(() => window.tmlEdit!.tool)).toBe('path');
      const n0 = await e.page.locator('#pathtool .anchor').count();
      const pt = await e.page.evaluate(() => {
        const p = document.querySelector('#pathtool path.contour') as SVGPathElement;
        const q = p.getPointAtLength(p.getTotalLength() * 0.37);
        const r = document.getElementById('pathtool')!.getBoundingClientRect();
        return { x: r.left + q.x, y: r.top + q.y };
      });
      await e.page.keyboard.down('Alt');
      await e.page.mouse.click(pt.x, pt.y);
      await e.page.keyboard.up('Alt');
      await idle(e.page);
      expect(await e.page.locator('#pathtool .anchor').count()).toBe(n0 + 1);
      await saved(e);
      const after = pathFromNode(read());
      expect(Math.abs(after.length - before.length)).toBeLessThan(before.length * 0.002);
      for (let i = 0; i <= 20; i++) {
        const a = before.pointAt((before.length * i) / 20);
        const b = after.pointAt((after.length * i) / 20);
        expect(Math.hypot(a.x - b.x, a.y - b.y), `point ${i}/20`).toBeLessThan(1);
      }
      await e.page.keyboard.press('Escape');
      expect(await e.page.evaluate(() => window.tmlEdit!.tool)).toBe('select');
    },
    T,
  );

  it(
    'mask by bounds: a clipPath appears in defs, the node gets clip-path; view:shot of the scene has no errors',
    async () => {
      await e.page.click(row('bird'));
      await e.page.click(row('bird'), { button: 'right' });
      await e.page.click('#menu button:has-text("Mask by bounds")');
      await idle(e.page);
      await saved(e);
      const tree = parse(readFileSync(join(dir, 'scene.svg'), 'utf8'));
      const clip = find(tree, 'bird-clip');
      expect(clip?.tag).toBe('clipPath');
      expect(tree.children.find((c) => c.tag === 'defs')!.children).toContain(clip);
      expect(find(tree, 'bird')!.attrs['clip-path']).toBe('url(#bird-clip)');
      const shot = spawnSync(process.execPath, [join(root, 'view/shot.mjs'), join(dir, 'scene.svg'), '--out', join(dir, 'shot.png')], {
        cwd: root,
        encoding: 'utf8',
        timeout: T,
        env: { ...process.env, INIT_CWD: root },
      });
      const json = JSON.parse(shot.stdout) as { errors: unknown[] };
      expect(json.errors).toEqual([]);
      expect(shot.status).toBe(0);
    },
    T,
  );

  it(
    'removing a node the contract requires: the contract error shows in the panel',
    async () => {
      await e.page.click(row('satellite'));
      await e.page.keyboard.press('Delete');
      await idle(e.page);
      const issues = await e.page.locator('#issues li').allTextContents();
      expect(issues.some((t) => t.startsWith('contract') && t.includes('#satellite'))).toBe(true);
      expect(e.errors).toEqual([]);
    },
    T,
  );
});
