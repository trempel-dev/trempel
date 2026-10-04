// pathdata.ts — SVG path data (`d`) and basic shapes → one normalized command list (renderer-agnostic).
//
// One parser for everything that reads geometry: the Pixi backend draws from it, ScenePath measures
// it (svg-path-properties), the checker validates with it. Strict on purpose — whatever it does not
// understand is a hard error with a position, never a silently dropped command (Pixi's own parser
// warns and skips).
//
// Normalized form: absolute M, L, C, Q, A, Z only. H/V → L, S → C and T → Q (reflected control
// point), relative → absolute, implicit repeats expanded (pairs after M are L), A with a zero radius
// → L (SVG F.6.2).

/** A normalized path command: absolute coordinates, M L C Q A Z only. */
export type PathCmd =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Q', number, number, number, number]
  | ['A', number, number, number, number, number, number, number]
  | ['Z'];

/** A `d` the parser could not read — `reason` for a human, `pos` (0-based) into `src`. */
export class PathDataError extends Error {
  constructor(
    readonly reason: string,
    readonly pos: number,
    readonly src: string,
  ) {
    super(`${reason} (позиция ${pos + 1})`);
    this.name = 'PathDataError';
  }
}

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SEP = /[\s,]*/y;

/** Parse path data into normalized commands. @throws PathDataError. */
export function parsePathData(d: string): PathCmd[] {
  const out: PathCmd[] = [];
  let i = 0;
  const skip = (): void => {
    SEP.lastIndex = i;
    SEP.exec(d);
    i = SEP.lastIndex;
  };
  const number = (): number => {
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) throw new PathDataError(`ожидается число, а тут «${d.slice(i, i + 8) || 'конец строки'}»`, i, d);
    i = NUM.lastIndex;
    skip();
    return Number(m[0]);
  };
  const flag = (): number => {
    const c = d[i];
    if (c !== '0' && c !== '1') throw new PathDataError(`флаг дуги — 0 или 1, а тут «${c ?? 'конец строки'}»`, i, d);
    i++;
    skip();
    return c === '1' ? 1 : 0;
  };

  // Current point, subpath start, last control point (for S/T reflection) and what set it.
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let qx = 0;
  let qy = 0;
  let prev = '';

  skip();
  if (i >= d.length) throw new PathDataError('пустой d — нечего рисовать', 0, d);
  let cmd = '';
  while (i < d.length) {
    const c = d[i];
    if (/[A-Za-z]/.test(c)) {
      if (ARGS[c.toUpperCase()] === undefined) {
        throw new PathDataError(`команда «${c}» не поддерживается (есть: M L H V C S Q T A Z)`, i, d);
      }
      cmd = c;
      i++;
      skip();
    } else if (!cmd) {
      throw new PathDataError('d должен начинаться с команды M', i, d);
    } else if (cmd === 'Z' || cmd === 'z') {
      throw new PathDataError('после Z — числа без команды', i, d);
    }
    if (!out.length && cmd !== 'M' && cmd !== 'm') {
      throw new PathDataError('d должен начинаться с команды M', i, d);
    }

    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (up) {
      case 'Z':
        out.push(['Z']);
        cx = sx;
        cy = sy;
        break;
      case 'M': {
        cx = ox + number();
        cy = oy + number();
        sx = cx;
        sy = cy;
        out.push(['M', cx, cy]);
        cmd = rel ? 'l' : 'L'; // following pairs are implicit lineto
        break;
      }
      case 'L':
        cx = ox + number();
        cy = oy + number();
        out.push(['L', cx, cy]);
        break;
      case 'H':
        cx = ox + number();
        out.push(['L', cx, cy]);
        break;
      case 'V':
        cy = (rel ? cy : 0) + number();
        out.push(['L', cx, cy]);
        break;
      case 'C': {
        const x1 = ox + number();
        const y1 = oy + number();
        const x2 = ox + number();
        const y2 = oy + number();
        cx = ox + number();
        cy = oy + number();
        out.push(['C', x1, y1, x2, y2, cx, cy]);
        qx = x2;
        qy = y2;
        break;
      }
      case 'S': {
        const smooth = prev === 'C' || prev === 'S';
        const x1 = smooth ? 2 * cx - qx : cx;
        const y1 = smooth ? 2 * cy - qy : cy;
        const x2 = ox + number();
        const y2 = oy + number();
        cx = ox + number();
        cy = oy + number();
        out.push(['C', x1, y1, x2, y2, cx, cy]);
        qx = x2;
        qy = y2;
        break;
      }
      case 'Q': {
        const x1 = ox + number();
        const y1 = oy + number();
        cx = ox + number();
        cy = oy + number();
        out.push(['Q', x1, y1, cx, cy]);
        qx = x1;
        qy = y1;
        break;
      }
      case 'T': {
        const smooth = prev === 'Q' || prev === 'T';
        const x1 = smooth ? 2 * cx - qx : cx;
        const y1 = smooth ? 2 * cy - qy : cy;
        cx = ox + number();
        cy = oy + number();
        out.push(['Q', x1, y1, cx, cy]);
        qx = x1;
        qy = y1;
        break;
      }
      case 'A': {
        const rx = Math.abs(number());
        const ry = Math.abs(number());
        const rot = number();
        const large = flag();
        const sweep = flag();
        cx = ox + number();
        cy = oy + number();
        out.push(rx === 0 || ry === 0 ? ['L', cx, cy] : ['A', rx, ry, rot, large, sweep, cx, cy]);
        break;
      }
    }
    prev = up;
  }
  return out;
}

/** Normalized commands back to a `d` string (what svg-path-properties and exporters read). */
export function toPathData(cmds: PathCmd[]): string {
  return cmds.map((c) => c.join(' ')).join(' ');
}

/** Elements that carry geometry (drawable shapes and motion paths). */
export const GEOMETRY_TAGS = new Set(['path', 'line', 'circle', 'ellipse', 'rect']);

const n = (v: string | undefined, name: string, tag: string): number => {
  if (v == null || v.trim() === '') return 0;
  const x = Number(v.trim().replace(/px$/, ''));
  if (!Number.isFinite(x)) throw new PathDataError(`<${tag}> ${name}="${v}" — не число`, 0, v);
  return x;
};

/**
 * The outline of a geometry element as normalized commands, in its own user space (its `transform`
 * NOT applied). Shapes start where SVG says they do (circle/ellipse at (cx+r, cy), clockwise; rect at
 * (x+rx, y)) — that matters for motion along them. An empty list means "nothing to draw" (r = 0…).
 * @throws PathDataError on unreadable data or a non-geometry tag.
 */
export function shapeCommands(tag: string, attrs: Record<string, string>): PathCmd[] {
  switch (tag) {
    case 'path': {
      if (attrs.d == null) throw new PathDataError('<path> без d', 0, '');
      return parsePathData(attrs.d);
    }
    case 'line':
      return [
        ['M', n(attrs.x1, 'x1', tag), n(attrs.y1, 'y1', tag)],
        ['L', n(attrs.x2, 'x2', tag), n(attrs.y2, 'y2', tag)],
      ];
    case 'circle':
    case 'ellipse': {
      const cx = n(attrs.cx, 'cx', tag);
      const cy = n(attrs.cy, 'cy', tag);
      const rx = tag === 'circle' ? n(attrs.r, 'r', tag) : n(attrs.rx, 'rx', tag);
      const ry = tag === 'circle' ? rx : n(attrs.ry, 'ry', tag);
      if (rx <= 0 || ry <= 0) return [];
      return [
        ['M', cx + rx, cy],
        ['A', rx, ry, 0, 0, 1, cx, cy + ry],
        ['A', rx, ry, 0, 0, 1, cx - rx, cy],
        ['A', rx, ry, 0, 0, 1, cx, cy - ry],
        ['A', rx, ry, 0, 0, 1, cx + rx, cy],
        ['Z'],
      ];
    }
    case 'rect': {
      const x = n(attrs.x, 'x', tag);
      const y = n(attrs.y, 'y', tag);
      const w = n(attrs.width, 'width', tag);
      const h = n(attrs.height, 'height', tag);
      if (w <= 0 || h <= 0) return [];
      // SVG: a missing rx takes ry and vice versa; each is clamped to half the side.
      const rxRaw = attrs.rx ?? attrs.ry;
      const ryRaw = attrs.ry ?? attrs.rx;
      const rx = Math.min(n(rxRaw, 'rx', tag), w / 2);
      const ry = Math.min(n(ryRaw, 'ry', tag), h / 2);
      if (rx <= 0 || ry <= 0) {
        return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
      }
      return [
        ['M', x + rx, y],
        ['L', x + w - rx, y],
        ['A', rx, ry, 0, 0, 1, x + w, y + ry],
        ['L', x + w, y + h - ry],
        ['A', rx, ry, 0, 0, 1, x + w - rx, y + h],
        ['L', x + rx, y + h],
        ['A', rx, ry, 0, 0, 1, x, y + h - ry],
        ['L', x, y + ry],
        ['A', rx, ry, 0, 0, 1, x + rx, y],
        ['Z'],
      ];
    }
    default:
      throw new PathDataError(`<${tag}> — не геометрия (есть: ${[...GEOMETRY_TAGS].join(', ')})`, 0, '');
  }
}
