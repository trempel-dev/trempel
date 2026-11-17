// Fit policies (design resolution), the safe area and the playfield — pure math.
import { describe, expect, it } from 'vitest';
import { canvas, canvasRect, column, insetsOf, playfield, policyOf, safeRect, safeShift } from '../src/ui/layout.js';

describe('fit policies', () => {
  // A 720×1280 design on a 1080×1920 column (same aspect) and on a wider 1200×1600 one.
  it('same aspect: every policy scales 1.5 and the canvas is the design', () => {
    for (const p of ['fitWidth', 'fitHeight', 'fitMin', 'fitMax', 'showAll'] as const) {
      const f = canvas(p, 1080, 1920, 720, 1280);
      expect(f.scale).toBeCloseTo(1.5);
      expect([f.w, f.h]).toEqual([720, 1280]);
    }
  });
  it('fitWidth / fitHeight / fitMin / fitMax on a wider column', () => {
    expect(canvas('fitWidth', 1200, 1600, 720, 1280).scale).toBeCloseTo(1200 / 720);
    expect(canvas('fitHeight', 1200, 1600, 720, 1280).scale).toBeCloseTo(1.25);
    const min = canvas('fitMin', 1200, 1600, 720, 1280);
    expect(min.scale).toBeCloseTo(1.25);
    expect(min.w).toBeCloseTo(960); // the canvas grows along the free axis
    const max = canvas('fitMax', 1200, 1600, 720, 1280);
    expect(max.scale).toBeCloseTo(1200 / 720);
    expect(max.h).toBeCloseTo(960); // cropped
  });
  it('showAll: letterbox — the canvas IS the design, centred in the column', () => {
    const f = canvas('showAll', 1200, 1600, 720, 1280);
    expect([f.w, f.h]).toEqual([720, 1280]);
    expect(f.ox).toBeCloseTo((1200 - 900) / 2);
    expect(f.oy).toBe(0);
    expect(canvasRect({ x: 10, y: 0, w: 1200, h: 1600 }, f)).toEqual({ x: 160, y: 0, w: 900, h: 1600 });
  });
  it('v0 names are aliases; unknown fails loud', () => {
    expect(policyOf('expand')).toBe('fitMin');
    expect(policyOf('shrink')).toBe('fitMax');
    expect(policyOf('width')).toBe('fitWidth');
    expect(policyOf('height')).toBe('fitHeight');
    expect(() => policyOf('cover' as never)).toThrow(/unknown fit policy "cover"/);
  });
});

describe('safe area', () => {
  it('insets of the safe rect inside a canvas (never negative)', () => {
    const safe = safeRect(400, 800, { top: 44, right: 0, bottom: 34, left: 0 });
    expect(insetsOf({ x: 0, y: 0, w: 400, h: 800 }, safe)).toEqual({ top: 44, left: 0, bottom: 34, right: 0 });
    // A column narrower than the window: the side insets do not reach it.
    expect(insetsOf({ x: 50, y: 0, w: 300, h: 800 }, safeRect(400, 800, { top: 0, right: 20, bottom: 0, left: 20 }))).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
  });
  it('anchored nodes shift inside it by their anchor', () => {
    const s = { top: 40, right: 10, bottom: 30, left: 20 };
    expect(safeShift(0, 0, s)).toEqual([20, 40]);
    expect(safeShift(1, 1, s)).toEqual([-10, -30]);
    expect(safeShift(0.5, 0.5, s)).toEqual([5, 5]);
  });
});

describe('playfield', () => {
  it('canvas minus safe area minus HUD zones (design units × scale)', () => {
    const col = column(1080, 1920, 0.75);
    const f = canvas('fitWidth', col.w, col.h, 720, 1280);
    const pf = playfield(canvasRect(col, f), safeRect(1080, 1920, { top: 60, right: 0, bottom: 40, left: 0 }), { top: 100, bottom: 200 }, f.scale);
    expect(pf).toEqual({ x: 0, y: 60 + 150, w: 1080, h: 1920 - 60 - 150 - 40 - 300 });
  });
  it('no HUD, no safe area → the canvas', () => {
    const col = column(800, 600);
    const f = canvas('fitMin', col.w, col.h, 720, 1280);
    expect(playfield(canvasRect(col, f), safeRect(800, 600), {}, f.scale)).toEqual(canvasRect(col, f));
  });
});
