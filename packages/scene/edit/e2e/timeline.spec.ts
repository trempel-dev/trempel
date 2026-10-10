// e2e, 2.3: the timeline (keys dragged, an ease, an fx: marker, ⌘S → only the touched md lines), the
// agent's scenario through tml = the same diff as the UI, recording (● Rec + the G operator → a key,
// the base untouched), the agent's bridge (trempel-edit eval / save from the CLI into the open page,
// undo) — on a copy of examples/motion in tmp.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { idle, openEditor, pressMod, root, type EditorPage } from './harness';

const T = 120_000;
const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../../view/edit-bin.mjs', import.meta.url));
/** trempel-edit with its JSON answer (exit 1 — not ok — answers too). */
const cli = async (...args: string[]): Promise<Record<string, unknown> & { ok: boolean; errors?: string[] }> =>
  JSON.parse((await run(process.execPath, [BIN, ...args]).catch((x: { stdout: string }) => x)).stdout);

/** Lines of `b` not in `a` and of `a` not in `b` (position-wise). */
function changed(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split('\n');
  const y = b.split('\n');
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (y.indexOf(x[i], j) < 0) removed.push(x[i++]);
    else added.push(y[j++]);
  }
  return { removed: removed.filter((l) => l !== undefined), added };
}

const clipText = (e: EditorPage): Promise<string> => e.page.evaluate(() => window.tml!.clipsDoc('anim/motion.md')!.toString());

describe('editor e2e — 2.3: timeline, Rec, the agent bridge (examples/motion copy)', () => {
  let dir = '';
  let e: EditorPage;
  let md0 = '';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-tl-'));
    for (const f of ['scene.svg', 'scene.tml.svg', 'scene.contract.xml', 'scene.state.json', 'anim', 'art', '.trempel']) {
      cpSync(join(root, 'examples/motion', f), join(dir, f), { recursive: true });
    }
    md0 = readFileSync(join(dir, 'anim/motion.md'), 'utf8');
    e = await openEditor(dir, 'scene');
    await e.page.click('#bottom-tabs .tab[data-tab="clips"]');
    await e.page.selectOption('#clip-name', 'idle');
    await idle(e.page);
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'the timeline draws the clip: an events lane, a track per $track unfolded by column, a key per cell',
    async () => {
      const keys = await e.page.$$eval('#tl-grid .tl-key:not(.sum)', (els) => els.map((x) => `${(x as HTMLElement).dataset.target}.${(x as HTMLElement).dataset.column}@${(x as HTMLElement).dataset.t}`));
      expect(keys).toContain('mascotHead.rotation@1');
      expect(keys).toContain('mascotHead.tex@2.05');
      expect(keys).toContain('mascotBody.tint@1.2');
      expect(await e.page.$$eval('#tl-grid .tl-ev', (els) => els.map((x) => (x as HTMLElement).dataset.event))).toEqual(['blink']);
      expect(await e.page.locator('#tl-grid .tl-key.step[data-column="tex"][data-t="2.05"]').count()).toBe(1);
    },
    T,
  );

  it(
    'drag a key, change its ease, add an fx: marker, ⌘S — the md on disk differs only in the touched lines',
    async () => {
      // drag mascotHead.rotation@1 right by ~0.2 s
      const key = e.page.locator('#tl-grid .tl-key[data-target="mascotHead"][data-column="rotation"][data-t="1"]');
      const b = (await key.boundingBox())!;
      const pps = await e.page.evaluate(() => {
        const a = document.querySelector<HTMLElement>('#tl-grid .tl-key[data-t="0"]')!;
        const k = document.querySelector<HTMLElement>('#tl-grid .tl-key[data-target="mascotHead"][data-column="rotation"][data-t="1"]')!;
        return parseFloat(k.style.left) - parseFloat(a.style.left);
      });
      await e.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await e.page.mouse.down();
      await e.page.mouse.move(b.x + b.width / 2 + pps * 0.2, b.y + b.height / 2, { steps: 5 });
      await e.page.mouse.up();
      await idle(e.page);
      expect(changed(md0, await clipText(e))).toEqual({ removed: ['| 1.0  | 6        |            | inOut |'], added: ['| 1.2  | 6        |            | inOut |'] });
      // the key is selected: its ease in the side panel
      await e.page.selectOption('#tl-ease', 'out');
      await idle(e.page);
      expect(changed(md0, await clipText(e)).added).toEqual(['| 1.2  | 6        |            | out   |']);
      // an fx: marker at the playhead (0.8)
      await e.page.evaluate(() => window.tml!.anim.seek(0.8));
      await e.page.evaluate(() => {
        const tl = (window as unknown as { tmlTimeline: { keys: Map<string, unknown>; events: Map<string, unknown>; side(): void } }).tmlTimeline;
        tl.keys.clear();
        tl.events.clear();
        tl.side();
      });
      await e.page.fill('#tl-new-event', 'fx:burst@mascot');
      await e.page.press('#tl-new-event', 'Enter');
      await idle(e.page);
      expect(await e.page.$$eval('#tl-grid .tl-ev.fx', (els) => els.map((x) => (x as HTMLElement).dataset.event))).toEqual(['fx:burst@mascot']);
      // ⌘S: the base and the clip file
      await pressMod(e.page, 's');
      await e.page.waitForFunction(() => !window.tmlEdit!.doc!.dirty);
      const disk = readFileSync(join(dir, 'anim/motion.md'), 'utf8');
      const d = changed(md0, disk);
      // the moved row; the events table is re-aligned as a whole (its column grew) — nothing else
      expect(d.removed.sort()).toEqual(['| 1.0  | 6        |            | inOut |', '| 2.05 | blink |', '| t    | event |', '|------|-------|'].sort());
      expect(d.added.sort()).toEqual(['| 1.2  | 6        |            | out   |', '| t    | event           |', '|------|-----------------|', '| 0.8  | fx:burst@mascot |', '| 2.05 | blink           |'].sort());
      expect(disk.split('\n').length).toBe(md0.split('\n').length + 1);
    },
    T,
  );

  it(
    'the agent\'s «move every key of a track by 0.2 s» through tml = the same diff as the UI\'s box-select + drag',
    async () => {
      const before = await clipText(e);
      // UI: shift-click every key of mascotBody, drag by 0.2 s
      const keys = e.page.locator('#tl-grid .tl-key[data-target="mascotBody"]');
      const n = await keys.count();
      for (let i = 0; i < n; i++) await keys.nth(i).click({ modifiers: ['Shift'] });
      const pps = await e.page.evaluate(() => {
        const a = document.querySelector<HTMLElement>('#tl-grid .tl-key[data-target="mascotBody"][data-t="0"]')!;
        const k = document.querySelector<HTMLElement>('#tl-grid .tl-key[data-target="mascotBody"][data-t="1.2"]')!;
        return (parseFloat(k.style.left) - parseFloat(a.style.left)) / 1.2;
      });
      // move the first two rows (the last one sits on $duration)
      await e.page.evaluate(() => {
        const tl = (window as unknown as { tmlTimeline: { keys: Map<string, { t: number }> } }).tmlTimeline;
        for (const [k, v] of [...tl.keys]) if (v.t > 2) tl.keys.delete(k);
      });
      const b = (await e.page.locator('#tl-grid .tl-key[data-target="mascotBody"][data-column="y"][data-t="0"]').boundingBox())!;
      await e.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await e.page.mouse.down();
      await e.page.mouse.move(b.x + b.width / 2 + pps * 0.2, b.y + b.height / 2, { steps: 5 });
      await e.page.mouse.up();
      await idle(e.page);
      const ui = await clipText(e);
      expect(ui).not.toBe(before);
      await e.page.evaluate(() => window.tml!.doc!.undo());
      await idle(e.page);
      expect(await clipText(e)).toBe(before);
      // the agent: the same through tml (one undo step)
      await e.page.evaluate(() =>
        window.tml!.run(`
          const d = tml.clipsDoc();
          const tr = d.clip('idle').tracks.find((t) => t.target === 'mascotBody');
          const keys = tr.columns.flatMap((column) => tr.keys[column].filter((k) => k.t < 2).map((k) => ({ target: 'mascotBody', column, t: k.t })));
          return d.exec('key.move', { clip: 'idle', keys, dt: 0.2 });
        `),
      );
      await idle(e.page);
      expect(await clipText(e)).toBe(ui);
    },
    T,
  );

  it(
    'Rec: the playhead at 0.5, the G operator moves #mascotHead — a key of the clip, the base untouched',
    async () => {
      const base = await e.page.evaluate(() => window.tml!.doc!.serialize());
      const before = await clipText(e);
      await e.page.evaluate(() => {
        window.tml!.anim.seek(0.5);
        window.tml!.anim.rec = true;
      });
      expect(await e.page.evaluate(() => window.tmlEdit!.readOnly)).toBeNull();
      await e.page.evaluate(() => window.tml!.select('mascotHead'));
      await idle(e.page);
      const s = (await e.page.locator('#stage-box').boundingBox())!;
      await e.page.mouse.move(s.x + s.width * 0.7, s.y + s.height * 0.3);
      for (const k of ['g', 'x', '1', '0', 'Enter']) await e.page.keyboard.press(k);
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tml!.doc!.serialize())).toBe(base);
      // the key: a new column x and a row at 0.5 in #mascotHead's table (re-aligned as a whole), nothing else
      const d = changed(before, await clipText(e));
      expect(d.added.some((l) => /^\| 0\.5 +\| /.test(l))).toBe(true);
      expect([...d.removed, ...d.added].every((l) => l.startsWith('|'))).toBe(true);
      const head = await e.page.evaluate(() => window.tml!.clipsDoc()!.clip('idle')!.tracks.find((t) => t.target === 'mascotHead')!);
      expect(head.columns).toContain('x');
      expect(head.keys.x.map((k) => [k.t, k.value])).toEqual([[0.5, '10']]);
      await e.page.evaluate(() => window.tml!.doc!.undo());
      await e.page.evaluate(() => (window.tml!.anim.rec = false));
      await idle(e.page);
      expect(await clipText(e)).toBe(before);
    },
    T,
  );

  it(
    'the agent bridge: trempel-edit eval changes the open page (one undo step), save writes the file',
    async () => {
      await e.page.evaluate(() => window.tml!.anim.stop());
      await idle(e.page);
      const port = new URL(e.url).port;
      const svg0 = readFileSync(join(dir, 'scene.svg'), 'utf8');
      const r = await cli('eval', '--port', port, "tml.doc.exec('node.setAttr', { node: 'sky', name: 'fill', value: '#000000' }).ok");
      expect(r).toMatchObject({ ok: true, value: true, dirty: true });
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.node(window.tmlEdit!.pathOfId('sky')!)!.attrs.fill)).toBe('#000000');
      expect(await e.page.evaluate(() => window.tml!.doc!.history.at(-1)!.label)).toBe('agent');
      expect(await e.page.evaluate(() => window.tmlEdit!.logs.some((l) => l.text.startsWith('agent: '))).valueOf()).toBe(true);
      await e.page.evaluate(() => window.tml!.doc!.undo());
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.node(window.tmlEdit!.pathOfId('sky')!)!.attrs.fill)).toBe('#13233f');
      // a failing script: ok false, the document as it was
      const bad = await cli('eval', '--port', port, 'throw new Error("nope")');
      expect(bad.ok).toBe(false);
      expect(bad.errors![0]).toContain('nope');
      await cli('eval', '--port', port, "tml.doc.exec('node.setAttr', { node: 'sky', name: 'fill', value: '#102030' })");
      expect((await cli('state', '--port', port)).value).toMatchObject({ scene: 'scene', dirty: true });
      expect(await cli('save', '--port', port)).toMatchObject({ ok: true, dirty: false });
      const svg = readFileSync(join(dir, 'scene.svg'), 'utf8');
      expect(changed(svg0, svg).added).toEqual(['  <rect id="sky" width="800" height="500" fill="#102030"/>']);
    },
    T,
  );
});
