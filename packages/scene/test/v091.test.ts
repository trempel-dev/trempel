// v0.9.1 — vector for FindDiff: dashed strokes (outline.ts, PixiBackend), stroke columns of clips,
// geometry hit test (pointInNode, MountedScene.hitTest / hitTestAll), display="none" still hit and
// measured; `$tex` of md clips.

import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { compileClipsResult } from '../src/anim/compile';
import { Animator } from '../src/anim/player';
import { dashes, flatten, insideOutline, outlineLength } from '../src/geom/outline';
import { pointInNode, hitTestTree } from '../src/geom/hit';
import { shapeCommands } from '../src/geom/pathdata';
import { parse } from '../src/parser';
import { parseDashArray, propErrors } from '../src/props';
import { PixiBackend } from '../src/render/pixi';
import { mount } from '../src/scene';
import { Registry } from '../src/registry';
import { IDENTITY, parseTransform } from '../src/transform';
import { checkContract, parseContract } from '../src/contract';
import { createMockBackend, createMockClock } from './helpers/mockBackend';
import { codesOf, thrown } from './helpers/codes';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">${body}</svg>`;
const metrics = (): { ascent: number; descent: number } => ({ ascent: 8, descent: 2 });

describe('outline — flatten, dashes, inside', () => {
  it('flatten keeps corners exact and measures curves (circle r=10 ≈ 2π·10)', () => {
    const [sq] = flatten(shapeCommands('rect', { width: '10', height: '20' }));
    expect(sq.closed).toBe(true);
    expect(sq.pts).toEqual([0, 0, 10, 0, 10, 20, 0, 20, 0, 0]);
    expect(sq.acc.at(-1)).toBe(60);
    const c = flatten(shapeCommands('circle', { r: '10' }));
    expect(outlineLength(c)).toBeCloseTo(2 * Math.PI * 10, 1);
  });

  it('dashes: odd list repeats, offset shifts the pattern back, a full dash over a closed path is closed', () => {
    const line = flatten([['M', 0, 0], ['L', 100, 0]]);
    expect(dashes(line, [10, 10], 0).map((p) => [p.pts[0], p.pts.at(-2)])).toEqual([[0, 10], [20, 30], [40, 50], [60, 70], [80, 90]]);
    // odd list [10] = [10, 10]; offset 5 → the first dash is half gone
    const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
    expect(dashes(line, [10], 5).map((p) => [r6(p.pts[0]), r6(p.pts.at(-2)!)])).toEqual([[0, 5], [15, 25], [35, 45], [55, 65], [75, 85], [95, 100]]);
    // draw-on: dasharray = length, offset length → nothing; 0 → everything; half → the first half
    const ring = flatten(shapeCommands('rect', { width: '10', height: '10' }));
    expect(dashes(ring, [40], 40)).toEqual([]);
    const full = dashes(ring, [40], 0);
    expect(full).toHaveLength(1);
    expect(full[0].closed).toBe(true);
    const half = dashes(ring, [40], 20);
    expect(half).toEqual([{ pts: [0, 0, 10, 0, 10, 10], closed: false }]);
    // pathLength: dash units scaled to the real length (100 author units over 40 real ones)
    expect(dashes(ring, [100], 50, 40 / 100)).toEqual(half);
  });

  it('inside: nonzero vs evenodd (a square with a same-direction inner square)', () => {
    const lines = flatten(shapeCommands('path', { d: 'M0 0 H30 V30 H0 Z M10 10 H20 V20 H10 Z' }));
    expect(insideOutline(lines, 15, 15, 'nonzero')).toBe(true);
    expect(insideOutline(lines, 15, 15, 'evenodd')).toBe(false);
    expect(insideOutline(lines, 5, 5, 'evenodd')).toBe(true);
    expect(insideOutline(lines, 35, 5)).toBe(false);
  });
});

describe('stroke attributes — strict subset (propErrors)', () => {
  it('values are checked; dash on text is an error', () => {
    const tree = parse(
      svg(
        '<path id="p" d="M0 0 L10 0" stroke="#000" stroke-dasharray="4 -2" stroke-linecap="arrow" stroke-linejoin="arcs"/>' +
          '<line id="l" x2="5" stroke-dashoffset="1em" pathLength="0"/>' +
          '<ellipse id="ok" rx="5" ry="3" stroke-dasharray="4, 2 1" stroke-dashoffset="-3" pathLength="100" stroke-linecap="round" stroke-linejoin="bevel"/>' +
          '<text id="t" stroke-dasharray="2">x</text>',
      ),
    );
    const errs = propErrors(tree);
    expect(codesOf(errs)).toEqual(['E_STROKE', 'E_STROKE', 'E_STROKE', 'E_STROKE', 'E_STROKE', 'E_STROKE']);
    const named = ['#p: stroke-dasharray="4 -2"', '#p: stroke-linecap="arrow"', '#p: stroke-linejoin="arcs"', '#l: stroke-dashoffset="1em"', '#l: pathLength="0"', '#t: stroke-dasharray'];
    named.forEach((n, i) => expect(errs[i].startsWith(`E_STROKE: ${n}`)).toBe(true));
    expect(errs[5]).toContain('<text>');
    expect(parseDashArray('none')).toBeNull();
    expect(parseDashArray('0 0')).toBeNull(); // sums to zero — solid, as in SVG
    expect(parseDashArray('3,1')).toEqual([3, 1]);
  });

  it('mount refuses a bad value with the node', () => {
    expect(() => mount({ base: svg('<circle id="c" r="3" stroke-dasharray="10%"/>'), backend: createMockBackend(), context: {} })).toThrow(
      /#c: stroke-dasharray="10%"/,
    );
  });
});

/** Subpaths (moveTo count) of the stroke instruction of a Graphics, and its style. */
function strokeOf(g: Graphics): { moves: number; width: number; alpha: number } | null {
  const ins = g.context.instructions.find((i) => i.action === 'stroke');
  if (!ins) return null;
  const data = ins.data as unknown as { path: { instructions: { action: string }[] }; style: { width: number; alpha: number } };
  return {
    moves: data.path.instructions.filter((i) => i.action === 'moveTo').length,
    width: data.style.width,
    alpha: data.style.alpha,
  };
}

describe('PixiBackend — dashed strokes (v0.9.1)', () => {
  const b = (): PixiBackend => new PixiBackend({ metrics });

  it('with and without dasharray: one outline vs one piece per dash; bounds the same span', () => {
    const solid = b().createNode('line', { x2: '100', stroke: '#fff', 'stroke-width': '2' }) as Graphics;
    const dashed = b().createNode('line', { x2: '100', stroke: '#fff', 'stroke-width': '2', 'stroke-dasharray': '10 10' }) as Graphics;
    expect(strokeOf(solid)!.moves).toBeLessThan(2);
    expect(strokeOf(dashed)!.moves).toBe(5);
    expect(dashed.getBounds().width).toBeCloseTo(solid.getBounds().width - 10, 0); // the last 10 are a gap
  });

  it('rect / ellipse / path / circle dash too; caps and joins on rect are taken', () => {
    for (const [tag, attrs] of [
      ['rect', { x: '5', y: '5', width: '40', height: '20', 'stroke-linejoin': 'round' }],
      ['ellipse', { cx: '0', cy: '0', rx: '30', ry: '10' }],
      ['circle', { r: '20' }],
      ['path', { d: 'M0 0 C 10 20 30 20 40 0' }],
    ] as const) {
      const g = b().createNode(tag, { ...attrs, fill: 'none', stroke: '#f00', 'stroke-dasharray': '5 5' }) as Graphics;
      expect(strokeOf(g)!.moves, tag).toBeGreaterThan(2);
    }
    const r = b().createNode('rect', { width: '10', height: '10', stroke: '#000', 'stroke-linejoin': 'round', 'stroke-linecap': 'square' }) as Graphics;
    const style = (r.context.instructions.find((i) => i.action === 'stroke')!.data as unknown as { style: { join: string; cap: string } }).style;
    expect([style.join, style.cap]).toEqual(['round', 'square']);
  });

  it('setProp stroke-dashoffset / stroke-width / stroke-opacity redraw; getProp reads them', () => {
    const be = b();
    const g = be.createNode('ellipse', {
      rx: '20',
      ry: '10',
      fill: 'none',
      stroke: '#fff',
      'stroke-dasharray': '100',
      'stroke-dashoffset': '100',
      pathLength: '100',
    }) as Graphics;
    expect(strokeOf(g)).toBeNull(); // offset = length: nothing drawn yet
    be.setProp(g, 'stroke-dashoffset', 50);
    expect(strokeOf(g)!.moves).toBe(1);
    be.setProp(g, 'stroke-dashoffset', 0);
    be.setProp(g, 'stroke-width', 6);
    be.setProp(g, 'stroke-opacity', 0.5);
    expect(strokeOf(g)).toMatchObject({ moves: 1, width: 6, alpha: 0.5 });
    expect([be.getProp(g, 'stroke-dashoffset'), be.getProp(g, 'stroke-width'), be.getProp(g, 'stroke-opacity')]).toEqual([0, 6, 0.5]);
    const notGeometry = thrown(() => be.setProp(be.createNode('g', {}), 'stroke-width', 2));
    expect(notGeometry).toMatchObject({ code: 'E_BACKEND' });
    expect(notGeometry.message).toContain('stroke-width');
  });

  it('bad values are errors with the node', () => {
    expect(() => b().createNode('path', { id: 'p', d: 'M0 0 L1 1', 'stroke-dasharray': 'a b' })).toThrow(/#p: stroke-dasharray="a b"/);
    expect(() => b().createNode('line', { 'stroke-linecap': 'arrow' })).toThrow(/<line>: stroke-linecap="arrow"/);
  });

  it('display="none" is not drawn; setProp display shows it', () => {
    const be = b();
    const scene = mount({ base: svg('<ellipse id="d1" cx="50" cy="50" rx="10" ry="5" display="none"/>'), backend: be, context: {} });
    const g = scene.byId.get('d1') as Graphics;
    expect(g.visible).toBe(false);
    be.setProp(g, 'display', 'inline');
    expect(g.visible).toBe(true);
    expect(be.getProp(g, 'display')).toBe('inline');
    be.setProp(g, 'display', 'none');
    expect(g.visible).toBe(false);
  });
});

describe('hit test by geometry (v0.9.1)', () => {
  const SCENE = svg(
    '<rect id="bg" width="800" height="600" fill="#123"/>' +
      '<g id="world" transform="translate(100 50) rotate(90)">' +
      '  <ellipse id="e" cx="40" cy="0" rx="20" ry="10" fill="none" display="none" data-pivot="40 0"/>' +
      '  <rect id="r" x="0" y="10" width="10" height="5" transform="scale(2)"/>' +
      '</g>' +
      '<path id="tri" d="M300 300 L400 300 L350 400 Z" transform="translate(10 0)"/>' +
      '<image id="img" href="a.png" x="500" y="100" width="100" height="50"/>' +
      '<line id="ln" x1="0" y1="580" x2="800" y2="580" stroke-width="6"/>' +
      '<g id="diffs"><circle id="a" cx="700" cy="400" r="20" data-z="2"/><circle id="b" cx="700" cy="400" r="20"/></g>' +
      '<defs><circle id="hidden" cx="10" cy="10" r="50"/></defs>',
  );

  it('ellipse under a rotated, translated parent; display="none" is hit; data-pivot changes nothing', () => {
    const scene = mount({ base: SCENE, backend: createMockBackend(), context: {} });
    // e: centre (40, 0) → rotate 90 → (0, 40) → translate → (100, 90); rx along y now.
    expect(scene.hitTest('e', 100, 90)).toBe(true);
    expect(scene.hitTest('e', 100, 108)).toBe(true);
    expect(scene.hitTest('e', 100, 112)).toBe(false);
    expect(scene.hitTest('e', 108, 90)).toBe(true);
    expect(scene.hitTest('e', 112, 90)).toBe(false);
    // a hidden zone is still measured
    expect(scene.path('e').length).toBeGreaterThan(90);
  });

  it('rect with its own scale under the rotated group; path with transform; image box; line by stroke', () => {
    const scene = mount({ base: SCENE, backend: createMockBackend(), context: {} });
    // r: [0..20]×[20..30] after scale(2) → rotate 90: x ∈ [-30, -20], y ∈ [0, 20] → +(100, 50)
    expect(scene.hitTest('r', 75, 60)).toBe(true);
    expect(scene.hitTest('r', 65, 60)).toBe(false);
    expect(scene.hitTest('r', 75, 75)).toBe(false);
    expect(scene.hitTest('tri', 360, 310)).toBe(true);
    expect(scene.hitTest('tri', 305, 390)).toBe(false);
    expect(scene.hitTest('img', 599, 149)).toBe(true);
    expect(scene.hitTest('img', 601, 149)).toBe(false);
    expect(scene.hitTest('ln', 400, 582)).toBe(true);
    expect(scene.hitTest('ln', 400, 584)).toBe(false);
    expect(scene.hitTest('world', 100, 90)).toBe(true); // a group by its children
    const missing = thrown(() => scene.hitTest('nope', 0, 0));
    expect(missing).toMatchObject({ code: 'E_NODE' });
    expect(missing.message).toContain('hitTest("nope")');
  });

  it('hitTestAll: topmost first (data-z among siblings), hidden included, defs never', () => {
    const scene = mount({ base: SCENE, backend: createMockBackend(), context: {} });
    expect(scene.hitTestAll(700, 400)).toEqual(['a', 'b', 'bg']);
    expect(scene.hitTestAll(100, 90)).toEqual(['e', 'bg']);
    expect(scene.hitTestAll(10, 10)).toEqual(['bg']);
    expect(hitTestTree(parse(SCENE), 2000, 2000)).toEqual([]);
  });

  it('pointInNode — the core function; the matrix includes the node’s own transform', () => {
    const n = parse(svg('<rect id="r" x="10" y="10" width="10" height="10" transform="rotate(45 15 15)"/>')).children[0];
    const m = parseTransform(n.attrs.transform);
    expect(pointInNode(n, m, 15, 8.5)).toBe(true); // the rotated corner reaches up to 15 − 7.07
    expect(pointInNode(n, IDENTITY, 15, 8.5)).toBe(false);
  });

  it('prefab instance ids and ComponentContext.hitTest', () => {
    const files: Record<string, string> = {
      'zone.svg': svg('<circle id="c" cx="0" cy="0" r="10"/>'),
    };
    let ctxHit: ((id: string, x: number, y: number) => boolean) | null = null;
    const registry = new Registry().register('probe', (ctx) => {
      ctxHit = ctx.hitTest;
      return { root: ctx.backend.createNode('g', {}) };
    });
    const scene = mount({
      base: svg('<use id="z" href="zone.svg" x="100" y="100"/><g id="p"/>'),
      heir: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg"><tml:ref id="p" tml:type="probe"/></svg>`,
      loadScene: (url) => (files[url] ? { base: files[url] } : null),
      registry,
      backend: createMockBackend(),
      context: {},
    });
    expect(scene.hitTestAll(105, 100)).toEqual(['z/c']);
    expect(ctxHit!('z/c', 95, 100)).toBe(true);
    expect(ctxHit!('z/c', 115, 100)).toBe(false);
  });
});

describe('clips — stroke columns (v0.9.1)', () => {
  const SCENE = parse(
    svg(
      '<ellipse id="d1" rx="10" ry="5" fill="none" stroke="#f00" stroke-dasharray="100" pathLength="100"/>' +
        '<ellipse id="plain" rx="10" ry="5" stroke="#f00"/><g id="grp"/>',
    ),
  );

  it('dash → stroke-dashoffset, strokeWidth → stroke-width, strokeAlpha → stroke-opacity; absolute', () => {
    const { clips, errors } = compileClipsResult(
      '# $clip found\n## $track d1\n| t | dash | strokeWidth | strokeAlpha | ease |\n|---|---|---|---|---|\n| 0 | 100 | 2 | 0 | out |\n| 0.5 | 0 | 4 | 1 | |\n',
      SCENE,
    );
    expect(errors).toEqual([]);
    expect(clips.found.tracks).toEqual([
      { target: 'd1', property: 'stroke-dashoffset', keys: [{ t: 0, v: 100 }, { t: 0.5, v: 0, ease: 'out' }] },
      { target: 'd1', property: 'stroke-width', keys: [{ t: 0, v: 2 }, { t: 0.5, v: 4, ease: 'out' }] },
      { target: 'd1', property: 'stroke-opacity', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 1, ease: 'out' }] },
    ]);
  });

  it('errors as a list: values, a target without dasharray, a non-geometry target', () => {
    const { errors } = compileClipsResult(
      '# $clip bad\n## $track d1\n| t | dash | strokeWidth | strokeAlpha |\n|---|---|---|---|\n| 0 | x | -1 | 2 |\n' +
        '## $track plain\n| t | dash |\n|---|---|\n| 0 | 1 |\n' +
        '## $track grp\n| t | strokeWidth |\n|---|---|\n| 0 | 1 |\n',
      SCENE,
    );
    expect(codesOf(errors)).toEqual(['E_ANIM_VALUE', 'E_ANIM_VALUE', 'E_ANIM_VALUE', 'E_ANIM_TARGET', 'E_ANIM_TARGET']);
    const named = ['$track d1, row 3: dash="x"', '$track d1, row 3: strokeWidth="-1"', '$track d1, row 3: strokeAlpha="2"', '$track plain: dash', '$track grp: strokeWidth'];
    named.forEach((n, i) => expect(errors[i]).toContain(`$clip bad / ${n}`));
    expect(errors[3]).toContain('#plain');
    expect(errors[4]).toMatch(/#grp.*<g>/);
  });

  it('the player writes them as absolute numbers ($target late binding)', () => {
    const be = createMockBackend();
    const scene = mount({ base: svg('<ellipse id="d1" rx="10" ry="5" stroke="#f00" stroke-dasharray="100" pathLength="100"/>'), backend: be, context: {} });
    const { clips } = compileClipsResult('# $clip found\n## $track $target\n| t | dash |\n|---|---|\n| 0 | 100 |\n| 1 | 0 |\n');
    const clock = createMockClock();
    const anim = new Animator(be, clock);
    anim.play(clips.found, { targets: { target: scene.byId.get('d1')! } });
    clock.t = 250;
    anim.tick();
    expect(be.getProp!(scene.byId.get('d1')!, 'stroke-dashoffset')).toBeCloseTo(75);
  });
});

describe('$tex in md clips (v0.9.1)', () => {
  const TRACK = (id: string, tex = ''): string => `## $track ${id}\n${tex}| t | tex |\n|---|---|\n| 0 | a |\n| 1 | b |\n`;
  const hrefs = (md: string, opts = {}): unknown[][] => {
    const { clips, errors } = compileClipsResult(md, undefined, opts);
    expect(errors).toEqual([]);
    return Object.values(clips).flatMap((c) => c.tracks.map((t) => t.keys.map((k) => k.v)));
  };

  it('without $tex the cell is the href (v0.7 behaviour)', () => {
    expect(hrefs(`# $clip c\n${TRACK('x')}`)).toEqual([['a', 'b']]);
  });

  it('template on the clip, the track (nearest wins) and the file', () => {
    expect(hrefs(`# $clip c\n$tex: art/{}.png\n\n${TRACK('x')}`)).toEqual([['art/a.png', 'art/b.png']]);
    expect(hrefs(`# $clip c\n$tex: art/{}.png\n\n${TRACK('x', '$tex: fx/{}-{}.webp\n')}`)).toEqual([['fx/a-a.webp', 'fx/b-b.webp']]);
    expect(hrefs(`Clips.\n$tex: sheet/{}.png\n\n# $clip c\n${TRACK('x')}\n# $clip d\n$tex: own/{}.png\n\n${TRACK('y')}`)).toEqual([
      ['sheet/a.png', 'sheet/b.png'],
      ['own/a.png', 'own/b.png'],
    ]);
  });

  it('table ## $tex maps names one by one, before the clip template; --tex (opts.tex) overrides all', () => {
    const md = `# $clip c\n$tex: art/{}.png\n\n## $tex\n| name | href |\n|---|---|\n| a | special/A.png |\n\n${TRACK('x')}`;
    expect(hrefs(md)).toEqual([['special/A.png', 'art/b.png']]);
    expect(hrefs(md, { tex: (n: string) => `cli/${n}.png` })).toEqual([['cli/a.png', 'cli/b.png']]);
  });

  it('errors: a template without {}, a bad table, $tex on a track without tex', () => {
    const { errors } = compileClipsResult(
      `# $clip c\n$tex: art/a.png\n\n## $tex\n| name | url |\n|---|---|\n| a | b |\n\n## $track x\n$tex: t/{}.png\n| t | x |\n|---|---|\n| 0 | 1 |\n`,
    );
    expect(codesOf(errors)).toEqual(['E_ANIM_TEX', 'E_ANIM_TEX', 'E_ANIM_TEX']);
    expect(errors[0]).toMatch(/^E_ANIM_TEX: \$clip c: \$tex: "art\/a\.png"/);
    expect(errors[1]).toMatch(/^E_ANIM_TEX: \$clip c \/ \$tex: .*name.*href/);
    expect(errors[2]).toMatch(/^E_ANIM_TEX: \$clip c \/ \$track x: /);
  });
});

describe('contract — nesting (v0.9.1)', () => {
  const C = parseContract('<contract><g id="diffs"><ellipse match="d\\d+" count="1.."/><rect id="frame"/></g></contract>');

  it('a pattern / node inside a contract node lies inside it in the base', () => {
    expect(C.patterns[0]).toMatchObject({ match: 'd\\d+', in: 'diffs' });
    expect(C.nodes.map((n) => [n.id, n.in])).toEqual([['diffs', undefined], ['frame', 'diffs']]);
    expect(checkContract(parse(svg('<g id="diffs"><ellipse id="d1" rx="1" ry="1"/><rect id="frame"/></g>')), C)).toEqual([]);
    const errs = checkContract(parse(svg('<g id="diffs"/><ellipse id="d1" rx="1" ry="1"/><rect id="frame"/>')), C);
    expect(codesOf(errs)).toEqual(['E_CONTRACT_PLACE', 'E_CONTRACT_PLACE', 'E_CONTRACT_COUNT']);
    expect(errs[0]).toMatch(/^E_CONTRACT_PLACE: #frame: .*#diffs/);
    expect(errs[1]).toMatch(/^E_CONTRACT_PLACE: #d1: .*d\\d\+.*#diffs/);
    expect(errs[2]).toMatch(/d\\d\+.*#diffs.*\b0\b/);
    const empty = thrown(() => parseContract('<contract><g id="a" empty="true"><rect id="b"/></g></contract>'));
    expect(empty).toMatchObject({ code: 'E_CONTRACT_SYNTAX' });
    expect(empty.message).toContain('<g id="a" empty="true">');
  });
});

describe('examples/finddiff', () => {
  const dir = fileURLToPath(new URL('../examples/finddiff/', import.meta.url));
  const read = (f: string): string | undefined => (existsSync(dir + f) ? readFileSync(dir + f, 'utf8') : undefined);
  const loadScene = (url: string) => {
    const stem = url.replace(/\.svg$/, '');
    const src = { base: read(`${stem}.svg`), heir: read(`${stem}.tml.svg`), contract: read(`${stem}.contract.xml`) };
    return src.base != null || src.heir != null ? src : null;
  };

  it('mounts with its contract; hidden zones are hit, the art under them too; the clip compiles against it', () => {
    const be = createMockBackend();
    const scene = mount({ ...loadScene('scene.svg')!, loadScene, backend: be, context: { state: { found: 0, total: 5 } } });
    expect(scene.hitTestAll(720, 165)).toEqual(['d1', 'right/sun', 'right/art', 'bg']);
    expect(scene.hitTestAll(320, 165)).toEqual(['left', 'bg']); // the left picture has no zones
    for (const [id, x, y] of [['d2', 533, 295], ['d3', 581, 340], ['d4', 700, 249], ['d5', 630, 376]] as const) {
      expect(scene.hitTestAll(x, y)[0], id).toBe(id);
    }
    expect(be.getProp!(scene.byId.get('d1')!, 'display')).toBeUndefined(); // display is an attribute, not set at build
    const { errors } = compileClipsResult(read('anim/found.md')!, parse(read('scene.svg')!));
    expect(errors).toEqual([]);
  });
});
