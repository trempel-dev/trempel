// transform.ts — the SVG `transform` attribute → one 2D affine matrix (renderer-agnostic).
//
// Supported: matrix(a b c d e f), translate(x [y]), scale(sx [sy]), rotate(deg [cx cy]),
// skewX(deg), skewY(deg), in any chain ("translate(10 20) rotate(45) scale(2)" — applied
// right-to-left to points, i.e. composed left-to-right as in SVG). Commas and/or whitespace
// separate arguments; editors (Figma/Illustrator/Inkscape) mostly write matrix(...).
// Anything else is a hard error — the format never silently drops what it cannot render.

/** SVG matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2 (apply m2 first, then m1). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export const translate = (x: number, y = 0): Matrix => [1, 0, 0, 1, x, y];

const rad = (deg: number): number => (deg * Math.PI) / 180;

const ARITY: Record<string, number[]> = {
  matrix: [6],
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewX: [1],
  skewY: [1],
};

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse an SVG transform list into one matrix. Empty/undefined → identity. @throws on bad input. */
export function parseTransform(src: string | undefined | null): Matrix {
  if (src == null || src.trim() === '') return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /\s*([A-Za-z]+)\s*\(([^)]*)\)\s*,?/y;
  let i = 0;
  while (i < src.length) {
    if (src.slice(i).trim() === '') break;
    re.lastIndex = i;
    const hit = re.exec(src);
    if (!hit) throw new Error(`transform="${src}": не разобрать с позиции ${i + 1}.`);
    const [, fn, rawArgs] = hit;
    const arity = ARITY[fn];
    if (!arity) {
      throw new Error(
        `transform="${src}": функция «${fn}» не поддерживается (есть: ${Object.keys(ARITY).join(', ')}).`,
      );
    }
    const parts = rawArgs.split(/[\s,]+/).filter(Boolean);
    if (!arity.includes(parts.length) || !parts.every((p) => NUMBER.test(p))) {
      throw new Error(`transform="${src}": ${fn}(${rawArgs.trim()}) — ожидается ${arity.join(' или ')} чис.`);
    }
    const a = parts.map(Number);
    m = multiply(m, step(fn, a));
    i = re.lastIndex;
  }
  return m;
}

function step(fn: string, a: number[]): Matrix {
  switch (fn) {
    case 'matrix':
      return a as Matrix;
    case 'translate':
      return translate(a[0], a[1] ?? 0);
    case 'scale':
      return [a[0], 0, 0, a[1] ?? a[0], 0, 0];
    case 'rotate': {
      const r = rad(a[0]);
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
      if (a.length === 3) return multiply(multiply(translate(a[1], a[2]), rot), translate(-a[1], -a[2]));
      return rot;
    }
    case 'skewX':
      return [1, 0, Math.tan(rad(a[0])), 1, 0, 0];
    default: // skewY
      return [1, Math.tan(rad(a[0])), 0, 1, 0, 0];
  }
}

/** Apply a matrix to a point. */
export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * The local matrix of an SVG element: its `transform`, then its own x/y offset (SVG places x/y
 * inside the element's transformed user space, so the offset is applied first).
 */
export function localMatrix(attrs: Record<string, string>, withXY: boolean): Matrix {
  const m = parseTransform(attrs.transform);
  if (!withXY) return m;
  const x = attrs.x ? parseFloat(attrs.x) : 0;
  const y = attrs.y ? parseFloat(attrs.y) : 0;
  return x || y ? multiply(m, translate(x, y)) : m;
}
