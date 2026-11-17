// num.ts — how the editor writes numbers: at most 2 decimals (as hand-made scenes do), no "-0",
// no trailing zeros. Matrix coefficients (a b c d of matrix()) keep more — see fmtCoef.

export function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/** A linear matrix coefficient: 6 decimals (2 would visibly bend rotations). */
export function fmtCoef(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

/** A plain number from an attribute ("12", "12px", "" → 0). NaN when unreadable. */
export function num(v: string | null | undefined): number {
  if (v == null || v.trim() === '') return 0;
  return Number(v.trim().replace(/px$/, ''));
}
