// e2e, editor batch 2: clips on the stage (select, seek, ⏹ = the rest pose byte for
// byte, read-only while posed), the reference layer (under / over the scene), the similarity macro,
// onion when paused, «снимок для видео» → renders/ — on a copy of examples/motion in tmp.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { idle, openEditor, root, type EditorPage } from './harness';

const T = 120_000;

/** A solid 8×8 PNG (RGBA magenta) — the reference for the pixel checks. */
async function magentaPng(file: string): Promise<void> {
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } }).png().toFile(file);
}

/** Bounds of a node of the runtime (canvas px) by id. */
const runtimeBounds = (e: EditorPage, id: string): Promise<number[]> =>
  e.page.evaluate((id) => {
    const ed = window.tmlEdit!;
    const h = ed.session!.scene!.byId.get(id)!;
    const b = ed.backend!.getBounds(h);
    return [b.x, b.y, b.w, b.h].map((v) => Math.round(v * 100) / 100);
  }, id);

/** sha-ish digest of the scene layer at 1:1 (tml.pixels — no reference, no onion). */
const sceneDigest = (e: EditorPage): Promise<string> =>
  e.page.evaluate(async () => {
    const p = await window.tml!.pixels();
    let h = 0x811c9dc5;
    for (let i = 0; i < p.data.length; i++) h = Math.imul(h ^ p.data[i], 0x01000193) >>> 0;
    return `${p.width}x${p.height}:${h.toString(16)}`;
  });

/** RGBA of the stage near the scene's top-left corner (background + reference + scene, as drawn). */
const cornerPixel = (e: EditorPage): Promise<number[]> =>
  e.page.evaluate(() => {
    const ed = window.tmlEdit!;
    const px = ed.app.renderer.extract.pixels({ target: ed.holder, resolution: 1 });
    // the extract starts at the holder's drawn bounds (strokes may reach past the viewBox)
    const b = ed.holder.getLocalBounds();
    const x = Math.round(ed.world.x + 2 - b.x);
    const y = Math.round(ed.world.y + 2 - b.y);
    const i = (y * px.width + x) * 4;
    return [...px.pixels.subarray(i, i + 4)];
  });

describe('editor e2e — batch 2: clips, reference, onion, snapshot (examples/motion copy)', () => {
  let dir = '';
  let e: EditorPage;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-b2-'));
    for (const f of ['scene.svg', 'scene.tml.svg', 'scene.contract.xml', 'scene.state.json', 'scene.mockup.png', 'anim', 'art', '.trempel']) {
      cpSync(join(root, 'examples/motion', f), join(dir, f), { recursive: true });
    }
    await magentaPng(join(dir, 'magenta.png'));
    e = await openEditor(dir, 'scene');
  }, T);
  afterAll(async () => {
    await e?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'the Clips tab lists the clips; select + seek 0.5 moves the bird; the stage is read-only; ⏹ — the rest pose byte for byte',
    async () => {
      const rest = await sceneDigest(e);
      await e.page.click('#bottom-tabs .tab[data-tab="clips"]');
      const options = await e.page.$$eval('#clip-name option', (os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      expect(options).toEqual(['fly', 'idle', 'wave']);
      // played from the md clip itself (`$tex` in it); the compiled motion.json is the game's, not read
      expect(await e.page.evaluate(() => window.tml!.clips.map((c) => [c.name, c.file]))).toEqual([
        ['fly', 'anim/motion.md'],
        ['idle', 'anim/motion.md'],
        ['wave', 'anim/motion.md'],
      ]);

      await e.page.selectOption('#clip-name', 'fly');
      const at0 = await runtimeBounds(e, 'bird');
      await e.page.evaluate(() => window.tml!.anim.seek(0.5));
      const at05 = await runtimeBounds(e, 'bird');
      expect(at05).not.toEqual(at0);
      expect(Math.hypot(at05[0] - at0[0], at05[1] - at0[1])).toBeGreaterThan(10);
      expect(await e.page.evaluate(() => [window.tml!.anim.clip, window.tml!.anim.time])).toEqual(['fly', 0.5]);
      expect(Number(await e.page.inputValue('#clip-t'))).toBeCloseTo(0.5);

      // read-only: a reason in the header, no handles, a click on the stage selects nothing
      const why = await e.page.evaluate(() => JSON.stringify({ ro: window.tmlEdit!.readOnly, logs: window.tmlEdit!.logs.map((l) => l.text) }));
      expect(await e.page.isVisible('#readonly'), why).toBe(true);
      await e.page.evaluate(() => window.tml!.select('sun'));
      expect(await e.page.$$('#gizmo .gz')).toHaveLength(0);

      // the same frame again is the same picture (seek is exact, no drift)
      const posed = await sceneDigest(e);
      await e.page.evaluate(() => window.tml!.anim.seek(1.7));
      await e.page.evaluate(() => window.tml!.anim.seek(0.5));
      expect(await sceneDigest(e)).toBe(posed);
      expect(posed).not.toBe(rest);

      await e.page.click('#clip-stop');
      await idle(e.page);
      expect(await e.page.evaluate(() => window.tmlEdit!.readOnly)).toBeNull();
      expect(await e.page.isVisible('#readonly')).toBe(false);
      expect(await sceneDigest(e)).toBe(rest);
      expect(e.errors).toEqual([]);
    },
    T,
  );

  it(
    'play / pause on the player clock: time moves, pause holds it',
    async () => {
      await e.page.evaluate(() => {
        window.tml!.anim.speed = 2;
        window.tml!.anim.play('idle');
      });
      await e.page.waitForFunction(() => window.tml!.anim.time > 0.2, null, { timeout: 10_000 });
      await e.page.click('#clip-pause');
      const t = await e.page.evaluate(() => window.tml!.anim.time);
      await e.page.waitForTimeout(300);
      expect(await e.page.evaluate(() => [window.tml!.anim.playing, window.tml!.anim.time])).toEqual([false, t]);
      await e.page.evaluate(() => window.tml!.anim.stop());
      await idle(e.page);
    },
    T,
  );

  it(
    'reference: picked up from scene.mockup.png; under the scene it shows where the scene is not drawn, over — everywhere',
    async () => {
      expect(await e.page.evaluate(() => window.tml!.reference.file)).toBe('scene.mockup.png');
      await e.page.evaluate(() => window.tml!.reference.set('magenta.png', { opacity: 100, over: false }));
      // under: the sky covers it
      let px = await cornerPixel(e);
      expect(px[0] === 255 && px[1] === 0 && px[2] === 255).toBe(false);
      // hide the sky (eye, editor-only) — the reference shows through
      await e.page.evaluate(() => {
        const ed = window.tmlEdit!;
        ed.toggleHidden(ed.pathOfId('sky')!);
      });
      px = await cornerPixel(e);
      expect(px.slice(0, 3)).toEqual([255, 0, 255]);
      await e.page.evaluate(() => {
        const ed = window.tmlEdit!;
        ed.toggleHidden(ed.pathOfId('sky')!);
      });
      // over: on top of the sky
      await e.page.evaluate(() => window.tml!.reference.set('magenta.png', { opacity: 100, over: true }));
      px = await cornerPixel(e);
      expect(px.slice(0, 3)).toEqual([255, 0, 255]);
      // the choice is remembered per scene (localStorage), not written to the file
      const stored = await e.page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('tml-edit:reference:')));
      expect(stored.length).toBe(1);
      expect(JSON.parse(stored[0][1])).toEqual({ file: 'magenta.png', opacity: 100, over: true });
      expect(readFileSync(join(dir, 'scene.svg'), 'utf8')).toBe(readFileSync(join(root, 'examples/motion/scene.svg'), 'utf8'));
    },
    T,
  );

  it(
    'the similarity macro prints a table per image against the reference (scene.mockup.png: the arm raised)',
    async () => {
      await e.page.evaluate(() => window.tml!.reference.set('scene.mockup.png', { opacity: 50, over: false }));
      const r = await e.page.evaluate(() => window.tml!.macros.run('similarity'));
      expect(String(r)).toMatch(/\d\.\d{3}\D+\d+\D+0\.85: /);
      const out = await e.page.textContent('#console-out');
      expect(out).toContain('scene.mockup.png');
      expect(out).toContain('800×500');
      expect(out).toMatch(/birdImg\s+\d\.\d{3}/);
    },
    T,
  );

  it(
    'onion when paused: two layers over the scene; playing — none',
    async () => {
      await e.page.evaluate(() => {
        window.tml!.anim.seek; // touch
        window.tml!.anim.play('wave');
        window.tml!.anim.pause();
        window.tml!.anim.seek(0.6);
        window.tml!.anim.onion(true);
      });
      const layers = await e.page.evaluate(() => {
        const clips = (window as unknown as { tmlClips: { onionLayers: number } }).tmlClips;
        const over = window.tmlEdit!.over.children.filter((c) => c.label === 'onion').length;
        return [clips.onionLayers, over];
      });
      expect(layers).toEqual([2, 2]);
      await e.page.evaluate(() => window.tml!.anim.play());
      expect(await e.page.evaluate(() => (window as unknown as { tmlClips: { onionLayers: number } }).tmlClips.onionLayers)).toBe(0);
      await e.page.evaluate(async () => {
        window.tml!.anim.onion(false);
        await window.tml!.anim.stop();
      });
      await idle(e.page);
    },
    T,
  );

  it(
    'the video snapshot writes renders/scene-<time>.png: viewBox 1:1, rest pose, the background of the setting',
    async () => {
      await e.page.evaluate(() => window.tml!.anim.play('wave'));
      await e.page.fill('#shot-bg', '#00ff00');
      await e.page.dispatchEvent('#shot-bg', 'change');
      await e.page.click('#shot-take');
      await e.page.waitForFunction(() => window.tmlEdit!.logs.some((l) => l.text.startsWith('video snapshot: renders/')), null, { timeout: 30_000 });
      expect(await e.page.evaluate(() => window.tmlEdit!.readOnly)).toBeNull(); // the clip was stopped
      const files = existsSync(join(dir, 'renders')) ? readdirSync(join(dir, 'renders')) : [];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^scene-\d{8}-\d{6}\.png$/);
      const sharp = (await import('sharp')).default;
      const meta = await sharp(join(dir, 'renders', files[0])).metadata();
      expect([meta.width, meta.height]).toEqual([800, 500]);
      // transparent: an RGBA PNG whose corner is clear where nothing is drawn (the sky hidden)
      await e.page.evaluate(() => {
        const ed = window.tmlEdit!;
        ed.toggleHidden(ed.pathOfId('sky')!);
      });
      const file = await e.page.evaluate(() => window.tml!.snapshot({ background: null }));
      const { data, info } = await sharp(join(dir, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect(data[3]).toBe(0);
      writeFileSync(join(dir, 'done'), '');
      expect(e.errors).toEqual([]);
    },
    T,
  );
});
