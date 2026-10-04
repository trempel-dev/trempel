// main.ts — the Trempel v0.7–v0.8 motion example (`npm run dev` → /examples/motion/).
//
//   - clips: anim/motion.md compiled to anim/motion.json — the bird flies along #fly1 in <defs>
//     (motion by fraction of length, $orient: auto), the two-part rig breathes with relative keys
//     and blinks by a tex swap;
//   - logic: the satellite runs along #orbit at its own speed through scene.path() — the same
//     geometry, no clip;
//   - mask: #window is cut by <clipPath id="win">; a click toggles it (tml:bind-clip-path);
//   - v0.8: the glow is additive (mix-blend-mode: plus-lighter), the bird flaps by sprite variants
//     (data-views + the `view` column), the body pulses its tint, the arm waves around its shoulder
//     (data-pivot) and comes in front of the body (data-z + the `z` column).
//
// The static still of this scene: `npm run view -- examples/motion`.

import { Application } from 'pixi.js';
import { Animator, mount, PixiBackend, reactive, type AnimClip } from '../../src/index';

import baseSvg from './scene.svg?raw';
import heirSvg from './scene.tml.svg?raw';
import contractXml from './scene.contract.xml?raw';
import clipsJson from './anim/motion.json';

const SATELLITE_SPEED = 120; // scene units per second

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({ width: 800, height: 500, background: 0x07080f, antialias: true });
  document.getElementById('stage')?.appendChild(app.canvas);

  const backend = new PixiBackend();
  const state = reactive({ open: true, caption: 'клик по окну — маска вкл/выкл' });
  const scene = mount({
    base: baseSvg,
    heir: heirSvg,
    contract: contractXml,
    backend,
    context: {
      state,
      toggle: () => {
        state.open = !state.open;
      },
    },
    container: app.stage,
  });
  await scene.ready;

  const clips = clipsJson as unknown as Record<string, AnimClip>;
  const animator = new Animator(backend, { now: () => performance.now() }, (id) => scene.byId.get(id), {
    path: (id) => scene.path(id),
  });
  animator.play(clips.fly);
  animator.play(clips.idle, { onMarker: (name) => console.debug('[motion] marker', name) });
  animator.play(clips.wave);

  const orbit = scene.path('orbit');
  const satellite = scene.byId.get('satellite')!;
  let s = 0;
  app.ticker.add((ticker) => {
    animator.tick();
    s += (SATELLITE_SPEED * ticker.deltaMS) / 1000; // a closed path wraps by itself
    const p = orbit.pointAt(s);
    backend.setProp(satellite, 'x', p.x);
    backend.setProp(satellite, 'y', p.y);
  });
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = String(e?.message ?? e);
});
