// v0.7 geometry in the core (no Pixi): path data, shapes, ScenePath, the defs/clipPath rules,
// merge rules for <defs>.

import { describe, it, expect } from 'vitest';
import { parsePathData, shapeCommands, PathDataError } from '../src/geom/pathdata';
import { pathFromNode } from '../src/geom/path';
import { geometryErrors, parseClipRef } from '../src/geom/check';
import { parse, parseHeir } from '../src/parser';
import { mergeScene } from '../src/merge';
import { codesOf, thrown, withCode } from './helpers/codes';

const svg = (body: string, extra = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"${extra}>${body}</svg>`;
const heir = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">${body}</svg>`;

const ABS = [
  ['M', 10, 20],
  ['L', 30, 40],
  ['L', 50, 40],
  ['L', 50, 60],
  ['C', 1, 2, 3, 4, 5, 6],
  ['C', 7, 8, 7, 8, 9, 10],
  ['Q', 11, 12, 13, 14],
  ['Q', 15, 16, 15, 16],
  ['A', 5, 5, 0, 1, 0, 20, 20],
  ['Z'],
];

describe('path data — every command, both cases', () => {
  it('absolute M L H V C S Q T A Z → normalized M L C Q A Z (S/T reflect the control point)', () => {
    expect(parsePathData('M10 20 L30 40 H50 V60 C1 2 3 4 5 6 S7 8 9 10 Q11 12 13 14 T15 16 A5 5 0 1 0 20 20 Z')).toEqual(ABS);
  });

  it('relative m l h v c s q t a z give the same outline', () => {
    expect(parsePathData('m10 20 l20 20 h20 v20 c-49 -58 -47 -56 -45 -54 s2 2 4 4 q2 2 4 4 t2 2 a5 5 0 1 0 5 4 z')).toEqual(ABS);
  });

  it('compact numbers, implicit lineto after M, packed arc flags', () => {
    expect(parsePathData('M0,0 10-5.5.5 1')).toEqual([['M', 0, 0], ['L', 10, -5.5], ['L', 0.5, 1]]);
    expect(parsePathData('m1 1 2 2')).toEqual([['M', 1, 1], ['L', 3, 3]]);
    expect(parsePathData('M0 0a5 5 0 1110 0')).toEqual([['M', 0, 0], ['A', 5, 5, 0, 1, 1, 10, 0]]);
    expect(parsePathData('M0 0 A0 5 0 0 1 10 0')).toEqual([['M', 0, 0], ['L', 10, 0]]); // zero radius → line
  });

  it('after Z a relative move starts from the subpath start', () => {
    expect(parsePathData('M10 10 L20 10 Z m5 0 l1 0')).toEqual([['M', 10, 10], ['L', 20, 10], ['Z'], ['M', 15, 10], ['L', 16, 10]]);
  });

  it.each([
    ['M0 0 X 10', 5], // unsupported command
    ['L 0 0', 2], // must start with M
    ['M 0', 3], // a number expected
    ['   ', 0], // empty d
    ['M0 0 A 5 5 0 2 0 1 1', 13], // an arc flag
    ['M0 0 Z 5 5', 7], // numbers after Z
  ])('%s → hard error with a position', (d, pos) => {
    expect(thrown(() => parsePathData(d))).toMatchObject({ code: 'E_PATH_DATA', pos });
    expect(() => parsePathData(d)).toThrow(PathDataError);
  });
});

describe('shapes as outlines', () => {
  it('circle starts at (cx+r, cy) and goes clockwise; r=0 draws nothing', () => {
    const c = shapeCommands('circle', { cx: '5', cy: '5', r: '2' });
    expect(c[0]).toEqual(['M', 7, 5]);
    expect(c[1]).toEqual(['A', 2, 2, 0, 0, 1, 5, 7]);
    expect(shapeCommands('circle', { r: '0' })).toEqual([]);
  });

  it('line, ellipse, rect (with rx)', () => {
    expect(shapeCommands('line', { x1: '1', y1: '2', x2: '3', y2: '4' })).toEqual([['M', 1, 2], ['L', 3, 4]]);
    expect(shapeCommands('ellipse', { cx: '0', cy: '0', rx: '4', ry: '2' })[0]).toEqual(['M', 4, 0]);
    expect(shapeCommands('rect', { x: '1', y: '1', width: '10', height: '4' })).toHaveLength(5);
    expect(shapeCommands('rect', { width: '10', height: '4', rx: '1' })[0]).toEqual(['M', 1, 0]);
  });
});

describe('ScenePath — by length, not by curve parameter', () => {
  const node = (tag: string, attrs: Record<string, string>) => ({ tag, attrs, tml: {}, children: [] });

  it('a cubic with bunched control points: the middle of the LENGTH, not t = 0.5', () => {
    // B(0.5).x would be 300·0.125 = 37.5; half of the length is x = 150.
    const p = pathFromNode(node('path', { d: 'M0 0 C0 0 0 0 300 0' }));
    expect(p.length).toBeCloseTo(300, 3);
    expect(p.closed).toBe(false);
    expect(p.pointAt(0).x).toBeCloseTo(0);
    expect(p.pointAt(150).x).toBeCloseTo(150, 1);
    expect(p.pointAt(300).x).toBeCloseTo(300, 3);
    expect(p.pointAt(999).x).toBeCloseTo(300, 3); // open path clamps
    expect(p.pointAt(-5).x).toBeCloseTo(0);
  });

  it('closed shapes wrap; the tangent is the direction of travel', () => {
    const c = pathFromNode(node('circle', { cx: '0', cy: '0', r: '10' }));
    expect(c.closed).toBe(true);
    expect(c.length).toBeCloseTo(20 * Math.PI, 2);
    const q = c.length / 4;
    expect(c.pointAt(q).x).toBeCloseTo(0, 2);
    expect(c.pointAt(q).y).toBeCloseTo(10, 2); // clockwise on screen: (10,0) → (0,10)
    expect(c.pointAt(q + c.length).y).toBeCloseTo(10, 2);
    expect(c.pointAt(-3 * q).y).toBeCloseTo(10, 2);
    expect(c.tangentAt(0).y).toBeCloseTo(1, 3);
    // Mid-arc, clockwise: heading down-left (svg-path-properties' own tangent is reversed on arcs).
    expect(c.tangentAt(q / 2).x).toBeCloseTo(-Math.SQRT1_2, 2);
    expect(c.tangentAt(q / 2).y).toBeCloseTo(Math.SQRT1_2, 2);
    // Just before the seam the closed path still heads on (to the start), not backwards.
    expect(c.tangentAt(c.length - 0.0001).y).toBeCloseTo(1, 2);
  });

  it('degenerate control points: the tangent is still the direction of travel', () => {
    expect(pathFromNode(node('path', { d: 'M0 0 C0 0 0 0 300 0' })).tangentAt(0).x).toBeCloseTo(1, 3);
  });

  it("the node's own similarity transform applies (scale multiplies the length)", () => {
    const p = pathFromNode(node('line', { x1: '0', y1: '0', x2: '10', y2: '0', transform: 'translate(5 5) rotate(90) scale(2)' }));
    expect(p.length).toBeCloseTo(20);
    expect(p.pointAt(20).x).toBeCloseTo(5);
    expect(p.pointAt(20).y).toBeCloseTo(25);
    expect(p.tangentAt(0).y).toBeCloseTo(1);
  });

  it('a stretching / skewing transform and a non-geometry node are errors', () => {
    const stretched = thrown(() => pathFromNode(node('line', { x2: '10', transform: 'scale(2 1)', id: 'l' })));
    expect(stretched).toMatchObject({ code: 'E_PATH_SIMILARITY' });
    expect(stretched.message).toContain('#l: transform="scale(2 1)"');
    const group = thrown(() => pathFromNode(node('g', { id: 'g1' })));
    expect(group).toMatchObject({ code: 'E_GEOMETRY' });
    expect(group.message).toContain('#g1');
  });
});

describe('parser — v0.7 tags', () => {
  it('path, circle, ellipse, line, defs, clipPath parse', () => {
    const t = parse(svg('<defs><path id="p" d="M0 0 L1 1"/><clipPath id="m"><rect width="1" height="1"/></clipPath></defs><circle r="1"/><ellipse rx="1" ry="1"/><line x2="1"/>'));
    expect(t.children.map((c) => c.tag)).toEqual(['defs', 'circle', 'ellipse', 'line']);
    expect(t.children[0].children.map((c) => c.tag)).toEqual(['path', 'clipPath']);
  });

  it('<mask> is an error that says to use clipPath', () => {
    const e = thrown(() => parse(svg('<defs><mask id="m"/></defs>')));
    expect(e).toMatchObject({ code: 'E_TAG' });
    expect(e.message).toContain('<mask>');
    expect(e.message).toContain('<clipPath>');
  });
});

describe('geometryErrors — defs, clipPath, clip-path', () => {
  const errs = (body: string): string[] => geometryErrors(parse(svg(body)));

  it('a valid scene has none', () => {
    expect(
      errs(
        '<defs id="d"><path id="fly" d="M0 0 C 1 1 2 2 3 3"/><g><circle r="2"/></g>' +
          '<clipPath id="m" clipPathUnits="userSpaceOnUse"><rect width="5" height="5"/><g transform="scale(2)"><circle r="1"/></g></clipPath></defs>' +
          '<g clip-path="url(#m)"/><image clip-path="none"/>',
      ),
    ).toEqual([]);
  });

  it('defs not at the root, wrong children', () => {
    expect(codesOf(errs('<g><defs/></g>'))).toEqual(['E_DEFS_PLACE']);
    expect(withCode(errs('<defs><text>x</text></defs>'), 'E_DEFS_PLACE')[0]).toContain('<text>');
    expect(withCode(errs('<defs><g><image/></g></defs>'), 'E_DEFS_PLACE')[0]).toContain('<image>');
  });

  it('clipPath: outside defs, without id, objectBoundingBox, wrong children', () => {
    expect(withCode(errs('<clipPath id="m"/>'), 'E_DEFS_PLACE')[0]).toContain('#m');
    expect(codesOf(errs('<defs><clipPath/></defs>'))).toEqual(['E_CLIP_NO_ID']);
    expect(withCode(errs('<defs><clipPath id="m" clipPathUnits="objectBoundingBox"/></defs>'), 'E_CLIP_UNITS')[0]).toContain('objectBoundingBox');
    expect(withCode(errs('<defs><clipPath id="m"><line x2="5"/></clipPath></defs>'), 'E_DEFS_PLACE')[0]).toContain('<line>');
  });

  it('clip-path: host tag, missing target, target not a clipPath, unreadable value', () => {
    const defs = '<defs><clipPath id="m"><rect width="1" height="1"/></clipPath><path id="p" d="M0 0 L1 0"/></defs>';
    const one = (body: string): string => {
      const list = errs(defs + body);
      expect(codesOf(list)).toEqual(['E_CLIP_PATH']);
      return list[0];
    };
    expect(one('<rect id="r" clip-path="url(#m)"/>')).toContain('#r: clip-path on <rect>');
    expect(one('<g id="a" clip-path="url(#nope)"/>')).toContain('#a: clip-path="url(#nope)"');
    expect(one('<g id="a" clip-path="url(#p)"/>')).toContain('#p is <path>');
    expect(one('<g id="a" clip-path="inset(5px)"/>')).toContain('#a: clip-path="inset(5px)"');
  });

  it('unreadable geometry names the node', () => {
    const wing = errs('<path id="wing" d="M0 0 X 3"/>');
    expect(codesOf(wing)).toEqual(['E_PATH_DATA']);
    expect(wing[0]).toContain('#wing: d:');
    expect(wing[0]).toContain('(col 6)');
    const circle = errs('<circle id="c" r="big"/>');
    expect(codesOf(circle)).toEqual(['E_PATH_DATA']);
    expect(circle[0]).toContain('#c: <circle> r="big"');
    expect(circle[0]).toContain('(col 1)');
  });

  it('parseClipRef', () => {
    expect(parseClipRef("url('#m')")).toBe('m');
    expect(parseClipRef('none')).toBeNull();
    expect(parseClipRef(undefined)).toBeNull();
  });
});

describe('merge — <defs> rules', () => {
  const base = svg('<defs id="defs"><path id="fly1" d="M0 0 L10 0"/></defs><g id="bird"/>');

  it('tml:ref onto a node in defs is an error (service geometry is not bound)', () => {
    const out = mergeScene(parse(base), parseHeir(heir('<tml:ref id="fly1" tml:visible="state.x"/>')));
    expect(codesOf(out.errors)).toEqual(['E_REF_DEFS']);
    expect(out.errors[0]).toContain('<tml:ref id="fly1">');
    expect(out.tree.children[0].children[0].tml).toEqual({});
  });

  it('the heir may insert geometry into defs by its id', () => {
    const out = mergeScene(parse(base), parseHeir(heir('<path id="fly2" d="M0 0 L5 5" tml:insert="into defs"/>')));
    expect(out.errors).toEqual([]);
    expect(out.tree.children[0].children.map((c) => c.attrs.id)).toEqual(['fly1', 'fly2']);
    expect(geometryErrors(out.tree)).toEqual([]);
  });

  it('`into defs` when the base defs has no id says so', () => {
    const out = mergeScene(parse(svg('<defs><path id="fly1" d="M0 0 L1 0"/></defs>')), parseHeir(heir('<path id="f2" d="M0 0 L1 1" tml:insert="into defs"/>')));
    expect(codesOf(out.errors)).toEqual(['E_INSERT_TARGET']);
    expect(out.errors[0]).toContain('tml:insert="into defs"');
  });

  it('a bound node inserted into defs is reported by the geometry check', () => {
    const out = mergeScene(parse(base), parseHeir(heir('<path id="f2" d="M0 0 L1 1" tml:insert="into defs" tml:visible="state.on"/>')));
    const list = geometryErrors(out.tree);
    expect(codesOf(list)).toEqual(['E_REF_DEFS']);
    expect(list[0]).toContain('#f2');
    expect(list[0]).toContain('tml:visible');
  });
});
