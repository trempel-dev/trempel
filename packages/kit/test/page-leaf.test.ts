// Kit 2.1 (TRM-10): the page leaf — its model, ported from a game: the
// profile of a phase, the early finish of a portrait turn, front / back by the sign of the
// determinant (screen vs RenderTexture, a mirrored parent), the painter's order of the indices.
import { Matrix } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { LEAF_CAM, LEAF_HARD, LEAF_LOOKS, LEAF_SOFT, PageLeaf, det2, frontFacingAt, goneAt, leafIndices, profile, projection, screenX, showsFront, twisted } from '../src/fx/page-leaf.js';

const W = 1080;
const H = 1920;
const CX = W / 2;
const CAM = W * LEAF_CAM;

describe('page leaf: phase → profile', () => {
  it('lies right at t = 0 and left at t = 1, flat (any bend)', () => {
    for (const bend of [0, 0.7]) {
      for (const s of [0, 0.3, 1]) {
        const r = profile(s, 0, bend);
        expect(r.x).toBeCloseTo(s, 6);
        expect(r.z).toBeCloseTo(0, 6);
        const l = profile(s, 1, bend);
        expect(l.x).toBeCloseTo(-s, 6);
        expect(l.z).toBeCloseTo(0, 6);
      }
    }
  });

  it('hard leaf (a cover): a rigid turn around the spine', () => {
    for (const t of [0.1, 0.25, 0.5, 0.8])
      for (const s of [0.2, 0.6, 1]) {
        const p = profile(s, t, LEAF_HARD.bend);
        expect(Math.hypot(p.x, p.z)).toBeCloseTo(s, 6);
        expect(p.phi).toBeCloseTo(Math.PI * t, 6);
      }
    expect(profile(1, 0.5, 0).x).toBeCloseTo(0, 6);
  });

  it('soft page: does not stretch (arc length = s), the edge leads, the height never decreases from the spine', () => {
    for (const t of [0.2, 0.45, 0.7]) {
      let len = 0;
      let prev = profile(0, t, LEAF_SOFT.bend);
      for (let k = 1; k <= 400; k++) {
        const p = profile(k / 400, t, LEAF_SOFT.bend);
        len += Math.hypot(p.x - prev.x, p.z - prev.z);
        expect(p.z).toBeGreaterThanOrEqual(prev.z - 1e-9);
        expect(p.phi).toBeGreaterThanOrEqual(prev.phi - 1e-9);
        prev = p;
      }
      expect(len).toBeCloseTo(1, 3);
    }
    expect(profile(1, 0.3, LEAF_SOFT.bend).phi).toBeGreaterThan(profile(0, 0.3, LEAF_SOFT.bend).phi);
  });

  it('twist: the bottom row leads, the top one lags', () => {
    expect(twisted(0.4, LEAF_SOFT.twist, 1)).toBeGreaterThan(0.4);
    expect(twisted(0.4, LEAF_SOFT.twist, 0)).toBeLessThan(0.4);
    expect(twisted(0, LEAF_SOFT.twist, 1)).toBe(0);
  });

  it('named looks', () => {
    expect(LEAF_LOOKS.hard).toBe(LEAF_HARD);
    expect(LEAF_LOOKS.soft).toEqual({ bend: 0.7, twist: 0.15 });
  });
});

describe('page leaf: early finish (portrait)', () => {
  it('the cover is gone at ~0.5, a soft page at ~0.7 — wholly left of the spine', () => {
    const hard = goneAt(LEAF_HARD.bend, LEAF_HARD.twist, W, CX, CAM);
    const soft = goneAt(LEAF_SOFT.bend, LEAF_SOFT.twist, W, CX, CAM);
    expect(hard).toBeGreaterThan(0.45);
    expect(hard).toBeLessThan(0.6);
    expect(soft).toBeGreaterThan(0.6);
    expect(soft).toBeLessThan(0.85);
    for (const [look, gone] of [
      [LEAF_HARD, hard],
      [LEAF_SOFT, soft],
    ] as const) {
      for (const v of [0, 0.5, 1])
        for (let k = 1; k <= 24; k++) expect(screenX(profile(k / 24, twisted(gone, look.twist, v), look.bend), W, CX, CAM)).toBeLessThanOrEqual(0.5);
      const before = gone - 0.06;
      const xs = Array.from({ length: 24 }, (_, k) => screenX(profile((k + 1) / 24, twisted(before, look.twist, 0), look.bend), W, CX, CAM));
      expect(Math.max(...xs)).toBeGreaterThan(0);
    }
  });
});

describe('page leaf: front / back by the sign of the determinant', () => {
  const screen = projection(W, H, true);
  const target = projection(W, H, false);

  it("Pixi's projections: the screen flips Y (det < 0), a RenderTexture does not (det > 0)", () => {
    expect(det2(screen)).toBeLessThan(0);
    expect(det2(target)).toBeGreaterThan(0);
    expect(screen.apply({ x: 0, y: 0 })).toMatchObject({ x: -1, y: 1 });
    expect(target.apply({ x: 0, y: 0 })).toMatchObject({ x: -1, y: -1 });
  });

  it('gl_FrontFacing alone swaps faces between the screen and a RenderTexture; with vDet the face is the same', () => {
    for (const bend of [0, 0.7]) {
      const ffScreen = frontFacingAt(screen, 0.05, bend, { w: W, h: H });
      const ffTarget = frontFacingAt(target, 0.05, bend, { w: W, h: H });
      expect(ffScreen).not.toBe(ffTarget);
      expect(showsFront(det2(screen), ffScreen)).toBe(true);
      expect(showsFront(det2(target), ffTarget)).toBe(true);
      expect(showsFront(det2(screen), frontFacingAt(screen, 0.97, bend, { w: W, h: H }))).toBe(false);
      expect(showsFront(det2(target), frontFacingAt(target, 0.97, bend, { w: W, h: H }))).toBe(false);
    }
  });

  it('a mirrored parent (negative scale) keeps the face right too', () => {
    const mirrored = screen.clone().append(new Matrix(-1, 0, 0, 1, W, 0));
    const ff = frontFacingAt(mirrored, 0.05, 0.7, { w: W, h: H });
    expect(showsFront(det2(mirrored), ff)).toBe(true);
  });

  it('indices go in columns from the spine (the draw order, no depth buffer)', () => {
    const rows = 3;
    const idx = leafIndices(4, rows);
    expect(idx.length).toBe(4 * rows * 6);
    const col = (i: number) => Math.floor(i / (rows + 1));
    let last = 0;
    for (let q = 0; q < idx.length; q += 6) {
      const c = Math.min(...Array.from(idx.slice(q, q + 6), col));
      expect(c).toBeGreaterThanOrEqual(last);
      last = c;
    }
  });
});

describe('PageLeaf (headless)', () => {
  it('uniforms follow the phase; the shadow only right of the spine; gone() by its look', () => {
    // Pixi probes a canvas for the shader precision.
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    const leaf = new PageLeaf();
    vi.unstubAllGlobals();
    leaf.setSize(400, 700);
    leaf.look = LEAF_HARD;
    expect(leaf.gone()).toBeCloseTo(goneAt(0, 0, 400, 200, 1600), 6);
    leaf.set(0);
    expect(leaf.shadow.visible).toBe(false);
    leaf.set(0.25);
    expect(leaf.t).toBe(0.25);
    expect(leaf.shadow.visible).toBe(true);
    expect(leaf.shadow.alpha).toBeGreaterThan(0);
    leaf.set(0.9);
    expect(leaf.shadow.visible).toBe(false); // the free edge is left of the spine
    leaf.look = LEAF_SOFT;
    expect(leaf.gone()).toBeGreaterThan(goneAt(0, 0, 400, 200, 1600));
    leaf.destroy({ children: true });
  });
});
