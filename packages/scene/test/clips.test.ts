// v0.7 clips: clip tables → anim.json (compileClips) and how the player plays them — relative
// x/y/rotation and scale multipliers from the scene's rest pose, ease "from this key to the next",
// step, tex, events, loop; motion along a path by fraction of length (orient, offset, closed loop,
// transformed parent). v0.5 absolute anim.json stays as it was.

import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { compileClips, compileClipsResult } from '../src/anim/compile';
import { Animator } from '../src/anim/player';
import type { AnimClip } from '../src/anim/types';
import { TrempelError } from '../src/errors';
import { parse } from '../src/parser';
import { PixiBackend } from '../src/render/pixi';
import { mount, type MountedScene } from '../src/scene';
import { createMockBackend, createMockClock, isMockNode } from './helpers/mockBackend';

const DEG = Math.PI / 180;

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
  <defs id="defs">
    <path id="fly1" d="M0 0 C0 0 0 0 300 0"/>
    <path id="ell" d="M0 0 L100 0 L100 100"/>
    <circle id="orbit" cx="0" cy="0" r="10"/>
  </defs>
  <g id="world" transform="translate(100 50) scale(2)">
    <g id="bird"/>
  </g>
  <g id="part" transform="translate(50 60) rotate(30) scale(2 3)">
    <image href="x.png" width="1" height="1"/>
  </g>
  <g id="two"><image href="a.png"/><image href="b.png"/></g>
  <rect id="box" width="5" height="5"/>
</svg>`;

describe('compileClips — tables → anim.json', () => {
  it('columns, empty cells, units, ease moved to the next key, events, duration/loop', () => {
    const clips = compileClips(`
# $clip idle
$duration: 2.4
$loop: true

Prose between blocks is fine.

## $track part
| t   | x  | rotation | scale | alpha | ease  |
|-----|----|----------|-------|-------|-------|
| 0   | 0  | 0        | 1     | 0     | out   |
| 1.2 | -3 |          | 1.1   |       | step  |
| 2.4 | 0  | 90       |       | 1     |       |

## $events
| t   | event    |
|-----|----------|
| 2   | sfx:coin |
| 0.3 | wave     |
`);
    const c = clips.idle;
    expect(c.duration).toBe(2.4);
    expect(c.loop).toBe(true);
    expect(c.markers).toEqual([{ t: 0.3, name: 'wave' }, { t: 2, name: 'sfx:coin' }]);
    const tr = (p: string) => c.tracks.find((t) => t.property === p)!;
    // x: ease of row 0 (out) lands on key 1, ease of row 1 (step) on key 2.
    expect(tr('x')).toEqual({
      target: 'part',
      property: 'x',
      relative: true,
      keys: [{ t: 0, v: 0 }, { t: 1.2, v: -3, ease: 'out' }, { t: 2.4, v: 0, ease: 'step' }],
    });
    // rotation: degrees → radians; row 1 is empty — the out ease of row 0 goes to the next rotation key.
    expect(tr('rotation').keys).toEqual([{ t: 0, v: 0 }, { t: 2.4, v: 90 * DEG, ease: 'out' }]);
    // scale → scale.x + scale.y multipliers.
    expect(tr('scale.x').keys).toEqual([{ t: 0, v: 1 }, { t: 1.2, v: 1.1, ease: 'out' }]);
    expect(tr('scale.y')).toMatchObject({ relative: true, keys: [{ t: 0, v: 1 }, { t: 1.2, v: 1.1, ease: 'out' }] });
    // alpha is absolute.
    expect(tr('alpha')).toEqual({ target: 'part', property: 'alpha', keys: [{ t: 0, v: 0 }, { t: 2.4, v: 1, ease: 'out' }] });
  });

  it('tex → href string keys (mapped), bezier ease, motion with $path/$orient/$offset', () => {
    const clips = compileClips(
      `# $clip c
## $track part
| t | tex   | y | ease          |
|---|-------|---|---------------|
| 0 | idle  | 0 | [0.1,0,0.2,1] |
| 1 | blink | 5 |               |

## $track bird
$path: fly1
$orient: auto
$orient-offset: 90
$offset: 0, -12
| t | motion |
|---|--------|
| 0 | 0      |
| 2 | 1      |
`,
      parse(SCENE),
      { tex: (n) => `art/${n}.png` },
    );
    const [href, y, motion] = clips.c.tracks;
    expect(href).toEqual({ target: 'part', property: 'href', keys: [{ t: 0, v: 'art/idle.png' }, { t: 1, v: 'art/blink.png' }] });
    expect(y.keys[1].ease).toEqual([0.1, 0, 0.2, 1]);
    expect(motion).toEqual({
      target: 'bird',
      property: 'motion',
      path: 'fly1',
      orient: 'auto',
      orientOffset: 90 * DEG,
      offset: [0, -12],
      keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }],
    });
  });

  it('every problem at once: ids, paths, columns, eases, times', () => {
    const { errors } = compileClipsResult(
      `# $clip bad
$duration: 1
$speed: 2
## $track ghost
| t | x |
|---|---|
| 0 | 1 |
## $track bird
$path: nope
| t | motion | ease   |
|---|--------|--------|
| 0 | 0      | wobbly |
| 0 | 1      |        |
## $track box
| t | foo | x |
|---|-----|---|
| 0 | 1   | a |
| 2 |     | 1 |
## $track bird
$path: world
| t | motion |
|---|--------|
| 0 | 0      |
## $track two
| t | tex |
|---|-----|
| 0 | a   |
## $track fly1
| t | x |
|---|---|
| 0 | 1 |
`,
      parse(SCENE),
    );
    expect(errors).toEqual([
      '$clip bad: неизвестный атрибут $speed (есть: $duration, $loop, $tex).',
      '$clip bad / $track ghost: узла #ghost в сцене нет.',
      '$clip bad / $track bird, строка 4: t=0 — времена должны идти по возрастанию.',
      '$clip bad / $track box: неизвестные колонки foo (есть: t, x, y, rotation, scale, scaleX, scaleY, skewX, skewY, alpha, tint, z, tex, view, motion, dash, strokeWidth, strokeAlpha, width, height, ease).',
      '$clip bad / $track box, строка 4: t=2 позже $duration 1.',
      '$clip bad / $track box, строка 3: x="a" — не число.',
      '$clip bad / $track bird: $path world — это <g>, путём может быть path, line, circle, ellipse, rect.',
      '$clip bad / $track two: tex — у #two 2 <image> внутри; подменить можно, только когда картинка одна.',
      '$clip bad / $track fly1: #fly1 в <defs> — служебная геометрия не анимируется.',
    ]);
    expect(() => compileClips('# $clip x\n## $track a\n| t | x |\n|---|---|\n| 0 | z |\n')).toThrow(TrempelError);
  });

  it('a bad ease, motion without $path and $path without motion are reported', () => {
    const { errors } = compileClipsResult(`# $clip c
## $track a
| t | x | ease   |
|---|---|--------|
| 0 | 0 | wobbly |
## $track b
| t | motion |
|---|--------|
| 0 | 0      |
## $track c
$path: fly1
| t | x |
|---|---|
| 0 | 0 |
`);
    expect(errors).toEqual([
      '$clip c / $track a, строка 3: ease «wobbly» неизвестен (есть: linear, quadIn, quadOut, quadInOut, cubicInOut, backOut, elasticOut, in, out, inOut, outBack, inBack, outBounce, step или [x1,y1,x2,y2]).',
      '$clip c / $track b: колонка motion без $path.',
      '$clip c / $track c: $path без колонки motion — движению нечем управлять.',
    ]);
  });
});

/** Scene on the real PixiBackend + an Animator wired to it, stepped by hand. */
function rig(svg = SCENE): { scene: MountedScene; anim: Animator; clock: { t: number; now(): number }; at: (s: number) => void } {
  const backend = new PixiBackend({ metrics: () => ({ ascent: 8, descent: 2 }) });
  const scene = mount({ base: svg, backend, context: {} });
  const clock = createMockClock();
  const anim = new Animator(backend, clock, (id) => scene.byId.get(id), { path: (id) => scene.path(id) });
  const at = (s: number): void => {
    clock.t = s * 1000;
    anim.tick();
  };
  return { scene, anim, clock, at };
}

const node = (scene: MountedScene, id: string) => scene.byId.get(id) as Container;

describe('player — relative tracks from the scene rest pose', () => {
  it('x/y/rotation add to the rest pose, scale multiplies it; replays start from the same rest', () => {
    const { scene, anim, at } = rig();
    const clips = compileClips(`# $clip c
## $track part
| t | x  | y | rotation | scaleX | scaleY |
|---|----|---|----------|--------|--------|
| 0 | 0  | 0 | 0        | 1      | 1      |
| 1 | 10 | -5| 90       | 0.5    | 2      |
`);
    const p = node(scene, 'part');
    expect(p.x).toBe(50);
    expect(p.rotation).toBeCloseTo(30 * DEG);
    anim.play(clips.c);
    at(1);
    expect(p.x).toBeCloseTo(60);
    expect(p.y).toBeCloseTo(55);
    expect(p.rotation).toBeCloseTo(120 * DEG);
    expect(p.scale.x).toBeCloseTo(1);
    expect(p.scale.y).toBeCloseTo(6);
    // Again: the rest pose was remembered — no drift from where the last play left the node.
    anim.play(clips.c);
    at(2);
    expect(p.x).toBeCloseTo(60);
    expect(p.scale.x).toBeCloseTo(1);
  });

  it('a v0.5 track without the flag is absolute, as before (mock backend, no getProp needed)', () => {
    const backend = createMockBackend();
    delete (backend as { getProp?: unknown }).getProp;
    const target = backend.createNode('g', {});
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const clip: AnimClip = { tracks: [{ target: '$n', property: 'x', keys: [{ t: 0, v: 5 }, { t: 1, v: 15 }] }] };
    anim.play(clip, { targets: { n: target } });
    clock.t = 500;
    anim.tick();
    expect(isMockNode(target).props.x).toBe(10);
  });

  it('a relative track on a backend without getProp is a load error', () => {
    const backend = createMockBackend();
    delete (backend as { getProp?: unknown }).getProp;
    const anim = new Animator(backend, createMockClock());
    const clip: AnimClip = { tracks: [{ target: '$n', property: 'x', relative: true, keys: [{ t: 0, v: 1 }] }] };
    expect(() => anim.play(clip, { targets: { n: backend.createNode('g', {}) } })).toThrow(/не умеет getProp/);
  });
});

describe('player — ease from the table, step, tex, events, loop', () => {
  it('ease written on a key shapes the way to the NEXT key; step holds then jumps', () => {
    const { scene, anim, at } = rig();
    const clips = compileClips(`# $clip c
## $track part
| t | x  | y  | ease |
|---|----|----|------|
| 0 | 0  | 0  | in   |
| 1 | 10 | 10 | step |
| 2 | 20 | 20 |      |
`);
    const p = node(scene, 'part');
    anim.play(clips.c);
    at(0.5);
    expect(p.x - 50).toBeCloseTo(2.5); // quadIn: 0.25 · 10
    at(1.5);
    expect(p.x - 50).toBeCloseTo(10); // step: still the value of key 1
    at(1.99);
    expect(p.x - 50).toBeCloseTo(10);
    at(2);
    expect(p.x - 50).toBeCloseTo(20);
  });

  it('tex holds until the next swap; markers fire; a loop repeats until aborted', async () => {
    const backend = createMockBackend();
    const part = backend.createNode('g', {});
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const clips = compileClips(`# $clip blink
$duration: 2
$loop: true
## $track $part
| t   | tex   |
|-----|-------|
| 0   | idle  |
| 1   | blink |
| 1.1 | idle  |
## $events
| t | event |
|---|-------|
| 1 | blink |
`);
    const writes: unknown[] = [];
    const setProp = backend.setProp;
    backend.setProp = (n, p, v) => {
      if (p === 'href') writes.push(v);
      setProp(n, p, v);
    };
    const markers: string[] = [];
    const h = anim.play(clips.blink, { targets: { part }, onMarker: (m) => markers.push(m) });
    for (const t of [0.5, 1.05, 1.5, 2.2, 3.05, 3.5]) {
      clock.t = t * 1000;
      anim.tick();
    }
    expect(writes).toEqual(['idle', 'blink', 'idle', 'blink', 'idle']);
    expect(markers).toEqual(['blink', 'blink']);
    let done = false;
    void h.done.then(() => (done = true));
    h.abort();
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

describe('player — motion along a path', () => {
  it('motion is a fraction of LENGTH: 0 / 0.5 / 1 on a curve with uneven parameter speed', () => {
    const { scene, anim, at } = rig();
    anim.play({ tracks: [{ target: 'bird', property: 'motion', path: 'fly1', keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }] }] });
    const b = node(scene, 'bird');
    expect([b.x, b.y]).toEqual([0, 0]);
    at(1);
    expect(b.x).toBeCloseTo(150, 0); // the Bézier parameter would give 37.5
    at(2);
    expect(b.x).toBeCloseTo(300, 1);
  });

  it('orient auto turns along the tangent; offset lies in the rotated axes', () => {
    const { scene, anim, at } = rig();
    anim.play(
      compileClips(`# $clip c
## $track bird
$path: ell
$orient: auto
$offset: 0, -6
| t | motion |
|---|--------|
| 0 | 0      |
| 1 | 1      |
`).c,
    );
    const b = node(scene, 'bird');
    at(0.25); // middle of the horizontal leg, heading +x: offset straight up
    expect(b.rotation).toBeCloseTo(0, 3);
    expect(b.x).toBeCloseTo(50, 1);
    expect(b.y).toBeCloseTo(-6, 3);
    at(0.75); // middle of the vertical leg, heading +y: the same offset now points +x
    expect(b.rotation).toBeCloseTo(Math.PI / 2, 3);
    expect(b.x).toBeCloseTo(106, 1);
    expect(b.y).toBeCloseTo(50, 1);
  });

  it('without $orient the rotation is left alone', () => {
    const { scene, anim, at } = rig();
    const b = node(scene, 'part');
    const r0 = b.rotation;
    anim.play({ tracks: [{ target: 'part', property: 'motion', path: 'ell', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }] });
    at(0.75);
    expect(b.rotation).toBe(r0);
    expect(b.x).toBeCloseTo(100, 1);
  });

  it('a closed path loops by modulo (no jump past 1); an open one clamps', () => {
    const { scene, anim, at } = rig();
    anim.play({ tracks: [{ target: 'bird', property: 'motion', path: 'orbit', keys: [{ t: 0, v: 0 }, { t: 1, v: 1.25 }] }] });
    anim.play({ tracks: [{ target: 'part', property: 'motion', path: 'ell', keys: [{ t: 0, v: 0 }, { t: 1, v: 1.25 }] }] });
    at(1);
    const b = node(scene, 'bird');
    expect(b.x).toBeCloseTo(0, 1);
    expect(b.y).toBeCloseTo(10, 1); // 1.25 turns = a quarter: (10,0) → (0,10)
    expect(node(scene, 'part').x).toBeCloseTo(100, 1);
    expect(node(scene, 'part').y).toBeCloseTo(100, 1);
  });

  it("path coordinates are the target's parent space (like animateMotion)", () => {
    const { scene, anim, at } = rig();
    anim.play({ tracks: [{ target: 'bird', property: 'motion', path: 'fly1', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }] });
    at(1);
    const g = node(scene, 'bird').getGlobalPosition();
    expect(g.x).toBeCloseTo(100 + 2 * 300, 0); // #world: translate(100 50) scale(2)
    expect(g.y).toBeCloseTo(50, 1);
  });

  it('an unknown path is a load error, not a playback one', () => {
    const { anim } = rig();
    expect(() => anim.play({ tracks: [{ target: 'bird', property: 'motion', path: 'nope', keys: [{ t: 0, v: 0 }] }] })).toThrow(
      /path\("nope"\) — узла с таким id в сцене нет/,
    );
    const bare = new Animator(createMockBackend(), createMockClock());
    expect(() => bare.play({ tracks: [{ target: '$x', property: 'motion', path: 'p', keys: [{ t: 0, v: 0 }] }] })).toThrow(/Animator создан без path/);
  });
});
