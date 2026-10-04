// main.ts — FindDiff, the first casual's blank (Trempel v0.9.1; `npm run dev` → /examples/finddiff/).
//
//   - scene.svg: the left picture is an <image>, the right one — the prefab picture.svg (<use>, v0.9):
//     the same art plus five changes on top; the difference zones are <ellipse display="none"> in
//     #diffs — not drawn, but hit (MountedScene.hitTestAll goes by geometry, hidden nodes included);
//   - a click on either picture (the left one is mapped onto the right) → hitTestAll → the first zone
//     not found yet is shown (setProp display) and plays the clip `found` (anim/found.md): the outline
//     draws itself (dash = stroke-dashoffset from pathLength to 0) and pulses its scale around data-pivot;
//   - scene.tml.svg binds the score; the contract asks for #diffs with zones d1…dN.
//
// The clips are compiled from the md clip at start (the canon; `npm run anim:compile` makes the .json a
// shipped game would load). The static still: `npm run view -- examples/finddiff`.

import { Application, Rectangle } from 'pixi.js';
import { Animator, compileClips, mount, PixiBackend, reactive, type SceneSource } from '../../src/index';

const files = import.meta.glob<string>('./*.{svg,xml}', { query: '?raw', import: 'default', eager: true });
const clipFiles = import.meta.glob<string>('./anim/*.md', { query: '?raw', import: 'default', eager: true });
const art = import.meta.glob<string>('./art/*.png', { query: '?url', import: 'default', eager: true });

/** Offset of the right picture from the left one (scene units): a click on the left is looked up on the right. */
const PICTURE_DX = 400;
const ZONE = /^d\d+$/;

/** A scene by its base path (`picture.svg`): base, heir, contract from the bundle. */
const loadScene = (url: string): SceneSource | null => {
  const stem = `./${url.replace(/\.svg$/, '')}`;
  const src = { base: files[`${stem}.svg`], heir: files[`${stem}.tml.svg`], contract: files[`${stem}.contract.xml`] };
  return src.base != null || src.heir != null ? src : null;
};

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({ width: 800, height: 440, background: 0x1b2238, antialias: true });
  document.getElementById('stage')?.appendChild(app.canvas);
  const log = document.getElementById('log')!;
  const say = (text: string): void => {
    log.textContent = text;
  };

  const backend = new PixiBackend();
  const state = reactive({ found: 0, total: 0 });
  const scene = mount({
    ...loadScene('scene.svg')!,
    loadScene,
    resolveHref: (href) => art[`./${href}`] ?? href,
    backend,
    context: { state },
    container: app.stage,
  });
  await scene.ready;

  const zones = [...scene.byId.keys()].filter((id) => ZONE.test(id));
  state.total = zones.length;
  const found = new Set<string>();

  const clips = compileClips(clipFiles['./anim/found.md']);
  const animator = new Animator(backend, { now: () => performance.now() }, (id) => scene.byId.get(id));
  app.ticker.add(() => animator.tick());

  // The canvas is the scene 1:1 (800×440, the viewBox), so a pointer's global point is a scene point.
  app.stage.eventMode = 'static';
  app.stage.hitArea = new Rectangle(0, 0, 800, 440);
  app.stage.on('pointertap', (e) => {
    const x = e.global.x < PICTURE_DX ? e.global.x + PICTURE_DX : e.global.x;
    const zone = scene.hitTestAll(x, e.global.y).find((id) => ZONE.test(id) && !found.has(id));
    if (!zone) {
      say('мимо');
      return;
    }
    found.add(zone);
    state.found = found.size;
    const node = scene.byId.get(zone)!;
    backend.setProp(node, 'display', 'inline');
    animator.play(clips.found, { targets: { target: node } });
    say(found.size === zones.length ? 'все отличия найдены' : `нашли ${zone}`);
  });
  say(`найдите ${zones.length} отличий — клик по любой из картинок`);
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = String(e?.message ?? e);
});
