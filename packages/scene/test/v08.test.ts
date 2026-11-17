// v0.8 format: mix-blend-mode in style (inherited from g), data-tint (+ track, per-channel), data-z
// (+ track), skewX/skewY tracks, data-views + the `view` column, data-pivot — parser/checks, the
// compiler, the player, and the real PixiBackend headless.

import { describe, it, expect, beforeAll } from 'vitest';
import { Assets, Container, Point, Sprite, Texture, TextureSource } from 'pixi.js';
import { PixiBackend } from '../src/render/pixi';
import { mount } from '../src/scene';
import { parse } from '../src/parser';
import { propErrors, parseBlend, parseViews, parsePivot } from '../src/props';
import { compileClips, compileClipsResult } from '../src/anim/compile';
import { Animator } from '../src/anim/player';
import { TrempelError } from '../src/errors';
import { codesOf, thrown } from './helpers/codes';

const metrics = (): { ascent: number; descent: number } => ({ ascent: 8, descent: 2 });
const tex = (w: number, h: number): Texture => new Texture({ source: new TextureSource({ width: w, height: h }) });
const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">${body}</svg>`;

beforeAll(() => {
  Assets.cache.set('v08/a.png', tex(10, 10));
  Assets.cache.set('v08/b.png', tex(10, 10));
  Assets.cache.set('v08/c.png', tex(20, 10));
});

const scene = (body: string) => {
  const backend = new PixiBackend({ metrics });
  const s = mount({ base: svg(body), backend, context: {} });
  return { backend, s, node: <T = Container>(id: string) => s.byId.get(id) as T };
};

const mountErrors = (body: string): string[] => {
  try {
    mount({ base: svg(body), backend: new PixiBackend({ metrics }), context: {} });
    return [];
  } catch (e) {
    if (e instanceof TrempelError) return e.errors;
    throw e;
  }
};

class Clock {
  t = 0;
  now(): number {
    return this.t;
  }
}

describe('v0.8 — mix-blend-mode', () => {
  it('parseBlend: the four modes; other properties in style and unknown modes are errors', () => {
    expect(parseBlend('mix-blend-mode: plus-lighter')).toBe('plus-lighter');
    expect(parseBlend('mix-blend-mode:screen;')).toBe('screen');
    expect(parseBlend(undefined)).toBeUndefined();
    expect(thrown(() => parseBlend('fill: red'))).toMatchObject({ code: 'E_STYLE' });
    const mode = thrown(() => parseBlend('mix-blend-mode: overlay'));
    expect(mode).toMatchObject({ code: 'E_BLEND' });
    expect(mode.message).toContain('normal, plus-lighter, multiply, screen');
  });

  it('checks: style with something else, unknown mode, text host, tml:bind-style', () => {
    const errs = propErrors(
      parse(
        svg(
          '<g id="a" style="opacity: 0.5"/><image id="b" style="mix-blend-mode: darken"/><text id="c" style="mix-blend-mode: screen">x</text>',
        ),
      ),
    );
    expect(codesOf(errs)).toEqual(['E_STYLE', 'E_BLEND', 'E_BLEND']);
    expect(errs[0]).toMatch(/^E_STYLE: #a: style: "opacity"/);
    expect(errs[1]).toMatch(/^E_BLEND: #b: mix-blend-mode: darken/);
    expect(errs[2]).toMatch(/^E_BLEND: #c: .*<text>/);
    expect(mountErrors('<g id="a" style="color: red"/>')).toHaveLength(1);
  });

  it('Pixi: plus-lighter → add; a group passes its mode to every built node, a child’s own mode wins', () => {
    const { node } = scene(
      `<g id="glow" style="mix-blend-mode: plus-lighter">
         <image id="a" href="v08/a.png" width="10" height="10"/>
         <g id="inner"><image id="b" href="v08/b.png" width="10" height="10"/></g>
         <image id="n" href="v08/a.png" width="10" height="10" style="mix-blend-mode: normal"/>
       </g>
       <rect id="m" width="5" height="5" style="mix-blend-mode: multiply"/>
       <image id="plain" href="v08/a.png"/>`,
    );
    expect(node('glow').blendMode).toBe('add');
    expect(node('a').blendMode).toBe('add');
    expect(node('inner').blendMode).toBe('add');
    expect(node('b').blendMode).toBe('add');
    expect(node('n').blendMode).toBe('normal');
    expect(node('m').blendMode).toBe('multiply');
    expect(node('plain').blendMode).toBe('inherit'); // untouched
  });
});

describe('v0.8 — data-tint', () => {
  it('image tint; a group tints the images of its subtree; a child image’s own tint wins', () => {
    const { node } = scene(
      `<image id="a" href="v08/a.png" data-tint="#ff0000"/>
       <g id="g" data-tint="#00ff00">
         <image id="b" href="v08/b.png"/>
         <g><image id="c" href="v08/a.png" data-tint="#0000ff"/></g>
         <rect id="r" width="4" height="4"/>
       </g>`,
    );
    expect(node<Sprite>('a').tint).toBe(0xff0000);
    expect(node<Sprite>('b').tint).toBe(0x00ff00);
    expect(node<Sprite>('c').tint).toBe(0x0000ff);
    expect(node<Sprite>('r').tint).toBe(0xffffff); // shapes are not tinted
  });

  it('checks: bad colour, wrong host', () => {
    const errs = propErrors(parse(svg('<image id="a" data-tint="red"/><rect id="r" data-tint="#fff"/>')));
    expect(codesOf(errs)).toEqual(['E_TINT', 'E_TINT']);
    expect(errs[0]).toMatch(/^E_TINT: #a: data-tint="red"/);
    expect(errs[1]).toMatch(/^E_TINT: #r: .*<rect>/);
  });

  it('setProp tint on a group reaches every image (a clipped image too)', () => {
    const { backend, node } = scene(
      `<defs><clipPath id="m"><rect width="5" height="5"/></clipPath></defs>
       <g id="rig"><image id="a" href="v08/a.png"/><image id="k" href="v08/b.png" clip-path="url(#m)"/></g>`,
    );
    backend.setProp(node('rig'), 'tint', 0x123456);
    expect(node<Sprite>('a').tint).toBe(0x123456);
    const inner = node('k').children.find((c) => c instanceof Sprite) as Sprite;
    expect(inner.tint).toBe(0x123456);
    expect(backend.getProp(node('rig'), 'tint')).toBe(0x123456);
  });

  it('tint track: absolute, interpolated per RGB channel', () => {
    const clips = compileClips(`# $clip pulse
## $track a
| t | tint    |
|---|---------|
| 0 | #ff0000 |
| 1 | #0000ff |
| 2 | #ffffff |
`);
    expect(clips.pulse.tracks[0]).toEqual({
      target: 'a',
      property: 'tint',
      keys: [
        { t: 0, v: 0xff0000 },
        { t: 1, v: 0x0000ff },
        { t: 2, v: 0xffffff },
      ],
    });
    const { backend, s, node } = scene('<image id="a" href="v08/a.png"/>');
    const clock = new Clock();
    const anim = new Animator(backend, clock, (id) => s.byId.get(id));
    anim.play(clips.pulse);
    clock.t = 500;
    anim.tick();
    // halfway red → blue: each channel on its own (0x80 / 0x00 / 0x80), not the number halfway.
    expect(node<Sprite>('a').tint).toBe(0x800080);
    clock.t = 1500;
    anim.tick();
    expect(node<Sprite>('a').tint).toBe(0x8080ff);
  });
});

describe('v0.8 — data-z', () => {
  const ORDER = `<g id="p">
      <rect id="a" width="1" height="1"/>
      <rect id="b" width="1" height="1" data-z="5"/>
      <rect id="c" width="1" height="1"/>
    </g>
    <g id="q"><rect id="d" width="1" height="1"/><rect id="e" width="1" height="1"/></g>`;

  it('order among siblings: zIndex, the parent sorts; siblings without it keep their index', () => {
    const { node } = scene(ORDER);
    expect(node('p').sortableChildren).toBe(true);
    expect(['a', 'b', 'c'].map((id) => node(id).zIndex)).toEqual([0, 5, 2]);
    node('p').sortChildren();
    expect(node('p').children.map((c) => c.zIndex)).toEqual([0, 2, 5]);
    expect(node('p').children[2]).toBe(node('b'));
    expect(node('q').sortableChildren).toBe(false); // nobody there asked
  });

  it('checks: not an integer, an undrawn node', () => {
    const errs = propErrors(parse(svg('<rect id="a" data-z="1.5"/><defs id="d" data-z="1"/>')));
    expect(codesOf(errs)).toEqual(['E_Z', 'E_Z']);
    expect(errs[0]).toMatch(/^E_Z: #a: data-z="1\.5"/);
    expect(errs[1]).toMatch(/^E_Z: #d: .*<defs>/);
  });

  it('z track: step by default, reorders (a parent without data-z starts sorting)', () => {
    const clips = compileClips(`# $clip swap
## $track d
| t | z  |
|---|----|
| 0 | 0  |
| 1 | 10 |
`);
    expect(clips.swap.tracks[0]).toEqual({ target: 'd', property: 'z', keys: [{ t: 0, v: 0 }, { t: 1, v: 10, ease: 'step' }] });
    const { backend, s, node } = scene(ORDER);
    const clock = new Clock();
    const anim = new Animator(backend, clock, (id) => s.byId.get(id));
    anim.play(clips.swap);
    clock.t = 900;
    anim.tick();
    expect(node('d').zIndex).toBe(0); // step: held until the next key
    clock.t = 1000;
    anim.tick();
    expect(node('d').zIndex).toBe(10);
    expect(node('e').zIndex).toBe(1);
    node('q').sortChildren();
    expect(node('q').children.map((c) => c.zIndex)).toEqual([1, 10]); // d now drawn over e
  });

  it('z: a non-integer cell is a compile error', () => {
    const { errors } = compileClipsResult(`# $clip bad
## $track d
| t | z   |
|---|-----|
| 0 | 0.5 |
`);
    expect(codesOf(errors)).toEqual(['E_ANIM_VALUE']);
    expect(errors[0]).toMatch(/^E_ANIM_VALUE: \$clip bad \/ \$track d, row 3: z="0\.5"/);
  });
});

describe('v0.8 — skew tracks', () => {
  it('skewX / skewY: degrees → radians, relative to the rest pose', () => {
    const clips = compileClips(`# $clip lean
## $track g
| t | skewX | skewY |
|---|-------|-------|
| 0 | 0     | 0     |
| 1 | 30    | -10   |
`);
    const [sx, sy] = clips.lean.tracks;
    expect(sx).toMatchObject({ target: 'g', property: 'skew.x', relative: true });
    expect(sx.keys[1].v).toBeCloseTo((30 * Math.PI) / 180);
    expect(sy).toMatchObject({ property: 'skew.y', relative: true });
    const { backend, s, node } = scene('<g id="g" transform="skewX(10)"><rect width="4" height="4"/></g>');
    const rest = node('g').skew.x;
    const clock = new Clock();
    const anim = new Animator(backend, clock, (id) => s.byId.get(id));
    anim.play(clips.lean);
    clock.t = 1000;
    anim.tick();
    expect(node('g').skew.x).toBeCloseTo(rest + (30 * Math.PI) / 180);
    expect(node('g').skew.y).toBeCloseTo((-10 * Math.PI) / 180);
  });
});

describe('v0.8 — data-views and the view column', () => {
  const RIG = `<g id="head"><image id="headImg" href="v08/a.png" width="10" height="10"
      data-views="open:v08/a.png, closed:v08/b.png, wide:v08/c.png"/></g>
    <image id="bare" href="v08/a.png"/>`;

  it('parseViews: ordered names; malformed / duplicate entries are errors', () => {
    expect([...parseViews('front:art/f.png, side: art/s.png')]).toEqual([
      ['front', 'art/f.png'],
      ['side', 'art/s.png'],
    ]);
    const malformed = thrown(() => parseViews('front'));
    expect(malformed).toMatchObject({ code: 'E_VIEWS' });
    expect(malformed.message).toContain('"front"');
    const twice = thrown(() => parseViews('a:x.png, a:y.png'));
    expect(twice).toMatchObject({ code: 'E_VIEWS' });
    expect(twice.message).toContain('"a"');
    const host = propErrors(parse(svg('<g id="g" data-views="a:x.png"/>')));
    expect(codesOf(host)).toEqual(['E_VIEWS']);
    expect(host[0]).toMatch(/^E_VIEWS: #g: .*<g>/);
  });

  it('view → href track resolved by data-views (target: image or a group with one image)', () => {
    const clips = compileClips(
      `# $clip blink
## $track head
| t   | view   |
|-----|--------|
| 0   | open   |
| 1   | closed |
| 1.1 | open   |
`,
      parse(svg(RIG)),
    );
    expect(clips.blink.tracks[0]).toEqual({
      target: 'head',
      property: 'href',
      keys: [
        { t: 0, v: 'v08/a.png' },
        { t: 1, v: 'v08/b.png' },
        { t: 1.1, v: 'v08/a.png' },
      ],
    });
  });

  it('view errors: unknown name, no data-views, no scene, view + tex on one target', () => {
    const md = (track: string, col: string, v: string) => `# $clip x
## $track ${track}
| t | ${col} |
|---|---|
| 0 | ${v} |
`;
    const tree = parse(svg(RIG));
    const unknown = compileClipsResult(md('head', 'view', 'shut'), tree).errors;
    expect(codesOf(unknown)).toEqual(['E_ANIM_TARGET']);
    expect(unknown[0]).toMatch(/^E_ANIM_TARGET: \$clip x \/ \$track head, row 3: view "shut" .*#head.*open, closed, wide/);
    const noViews = compileClipsResult(md('bare', 'view', 'open'), tree).errors;
    expect(codesOf(noViews)).toEqual(['E_ANIM_TARGET']);
    expect(noViews[0]).toMatch(/^E_ANIM_TARGET: \$clip x \/ \$track bare: view — .*#bare/);
    const noScene = compileClipsResult(md('head', 'view', 'open')).errors;
    expect(codesOf(noScene)).toEqual(['E_ANIM_TARGET']);
    expect(noScene[0]).toMatch(/^E_ANIM_TARGET: \$clip x \/ \$track head: /);
    const both = `# $clip x
## $track head
| t | view | tex |
|---|---|---|
| 0 | open | b |
`;
    const twice = compileClipsResult(both, tree).errors;
    expect(codesOf(twice)).toEqual(['E_ANIM_TWICE']);
    expect(twice[0]).toMatch(/^E_ANIM_TWICE: \$clip x \/ \$track head: .*href.*#head/);
  });

  it('view track plays (href swaps); MountedScene.setView for logic', () => {
    const tree = parse(svg(RIG));
    const clips = compileClips(`# $clip blink
## $track head
| t | view   |
|---|--------|
| 0 | open   |
| 1 | wide |
`, tree);
    const { backend, s, node } = scene(RIG);
    const clock = new Clock();
    const anim = new Animator(backend, clock, (id) => s.byId.get(id));
    anim.play(clips.blink);
    clock.t = 1000;
    anim.tick();
    expect(node<Sprite>('headImg').texture).toBe(Assets.cache.get('v08/c.png'));
    s.setView('head', 'closed');
    expect(node<Sprite>('headImg').texture).toBe(Assets.cache.get('v08/b.png'));
    s.setView('headImg', 'open');
    expect(node<Sprite>('headImg').texture).toBe(Assets.cache.get('v08/a.png'));
    const variant = thrown(() => s.setView('head', 'nope'));
    expect(variant).toMatchObject({ code: 'E_VIEW' });
    expect(variant.message).toMatch(/#head .*"nope".*open, closed, wide/);
    const bare = thrown(() => s.setView('bare', 'open'));
    expect(bare).toMatchObject({ code: 'E_VIEW' });
    expect(bare.message).toContain('#bare');
  });
});

describe('v0.8 — data-pivot', () => {
  const world = (c: Container, x: number, y: number) => {
    const p = c.parent!.toGlobal(new Point(0, 0));
    const q = c.toGlobal(new Point(x, y));
    return [q.x - p.x, q.y - p.y].map((v) => Math.round(v * 1000) / 1000);
  };

  it('parsePivot; checks', () => {
    expect(parsePivot('10 -4')).toEqual({ x: 10, y: -4 });
    const errs = propErrors(parse(svg('<g id="a" data-pivot="1"/>')));
    expect(codesOf(errs)).toEqual(['E_PIVOT']);
    expect(errs[0]).toMatch(/^E_PIVOT: #a: data-pivot="1"/);
  });

  it('the node matrix is the same with and without data-pivot (g, rect, image)', () => {
    const body = (pivot: string) =>
      `<g id="g" transform="translate(100 50) rotate(30) scale(2)" ${pivot}><rect width="1" height="1"/></g>
       <rect id="r" x="10" y="20" width="40" height="10" transform="rotate(15)" ${pivot}/>
       <image id="i" href="v08/c.png" x="5" y="6" width="40" height="20" transform="translate(3 4) rotate(-20)" ${pivot}/>`;
    const a = scene(body(''));
    const b = scene(body('data-pivot="12 7"'));
    for (const id of ['g', 'r', 'i']) {
      for (const [x, y] of [
        [0, 0],
        [3, 9],
      ]) {
        expect(world(b.node(id), x, y)).toEqual(world(a.node(id), x, y));
      }
    }
    // The pivot is where Pixi's position sits: the rect's (12, 7) of its user space.
    const r = b.node('r');
    const rot = (15 * Math.PI) / 180;
    expect(r.x).toBeCloseTo(12 * Math.cos(rot) - 7 * Math.sin(rot));
    expect(r.y).toBeCloseTo(12 * Math.sin(rot) + 7 * Math.cos(rot));
  });

  it('a rotation clip turns around data-pivot (the pivot point stays put)', () => {
    const clips = compileClips(`# $clip turn
## $track arm
| t | rotation |
|---|----------|
| 0 | 0        |
| 1 | 90       |
`);
    const { backend, s, node } = scene(
      `<g id="arm" transform="translate(200 100)" data-pivot="30 0"><rect width="60" height="10"/></g>`,
    );
    const pin = (c: Container) => {
      // (30, 0) of the arm's user space in the parent — through the Pixi frame (pivot-relative).
      const m = c.localTransform;
      c.updateLocalTransform();
      return [m.a * 30 + m.c * 0 + m.tx, m.b * 30 + m.d * 0 + m.ty].map((v) => Math.round(v * 1000) / 1000);
    };
    expect(pin(node('arm'))).toEqual([230, 100]);
    const clock = new Clock();
    const anim = new Animator(backend, clock, (id) => s.byId.get(id));
    anim.play(clips.turn);
    clock.t = 1000;
    anim.tick();
    expect(pin(node('arm'))).toEqual([230, 100]);
    expect(node('arm').rotation).toBeCloseTo(Math.PI / 2);
  });

  it('image pivot survives the texture fit (stays at the same SVG point)', () => {
    const { node, backend } = scene(`<image id="i" href="v08/c.png" x="10" y="10" width="40" height="20" data-pivot="30 20"/>`);
    const i = node<Sprite>('i');
    backend.setProp(i, 'rotation', Math.PI);
    // (30, 20) of user space is the pivot → it stays at (30, 20) under any rotation.
    const p = i.toGlobal(i.pivot.clone());
    const o = i.parent!.toGlobal(new Point(0, 0));
    expect([p.x - o.x, p.y - o.y].map((v) => Math.round(v))).toEqual([30, 20]);
    expect(i.pivot.x).toBeCloseTo((30 - 10) / 2); // texture 20 px wide shown 40 wide → fit 2
  });
});
