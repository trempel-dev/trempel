// ReelGrid.ts — the one custom component in v1 (tml:type="reel-grid").
//
// Builds a cols×rows grid of cells over the backend. Two rendering modes:
//   • placeholder (default): each cell is a rect (symbol background) + a text label (symbol id).
//     Used by the headless tests so they never depend on PNG assets.
//   • image-cells: set tml:assets="<dir>" and each cell becomes a Sprite of `<dir>/<id>.png`.
//     Used by a game front with its own symbol art.
//
// Cells may be non-square: tml:cellw/cellh (draw size) and tml:gapx/gapy (spacing) default to
// the square tml:cell/tml:gap, letting the grid line up with a rectangular-window reel frame.
// v0.7: every parameter may instead come from the base as data-<name> (data-cols, data-cellw…);
// tml:<name> in the heir wins (ctx.param).
//
// The spin-cycle faces (and, in placeholder mode, what each cell reads) default to the reel
// symbol ids 1..7 but can be overridden with tml:faces="1,2,3,10,20,…" — a slot front can reuse
// the component as a single-column *multiplier reel* (text cells, tml:textprefix="×") behind a
// multiplier frame, without forking ReelGrid. Text look is tunable (tml:textsize/textfill,
// tml:cellbg="none" to drop the placeholder rect so an ornate frame shows through).
//
// A host controller drives it via setField / startSpin / stopReel and feeds cells() to the
// Animator as `$symbol` targets. Cell containers pivot on their centre, so the stop-bounce and
// win-pulse scale animations squash symmetrically.

import type { ComponentContext, ComponentInstance } from '../registry.js';
import type { NodeHandle } from '../render/backend.js';

export interface ReelGridInstance extends ComponentInstance {
  /** Set the whole visible field. field[col][row] = symbol id. */
  setField(field: number[][]): void;
  /** Begin the spin loop: every column starts cycling symbols. */
  startSpin(): void;
  /**
   * Advance the spin loop by `dt` seconds. Drive this once per frame from the host's
   * ticker while any column is spinning; it cycles the symbol faces and bobs them
   * vertically so the strip reads as moving.
   */
  spinFrame(dt: number): void;
  /** Stop a reel column, revealing `symbols` (indexed by row). Halts that column's scroll. */
  stopReel(col: number, symbols: number[]): void;
  /** Cell containers of a column — pass as `$symbol` targets to the Animator. */
  cells(col: number): NodeHandle[];
  /** A single cell container. */
  cell(col: number, row: number): NodeHandle;
}

type Param = (name: string) => string | undefined;

function num(param: Param, key: string, fallback: number): number {
  const v = param(key);
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse faces="1,2,3,…" into an id list; falls back to the default reel faces. */
function faceList(param: Param, fallback: number[]): number[] {
  const v = param('faces');
  if (v == null || v.trim() === '') return fallback;
  const ids = v
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length ? ids : fallback;
}

// Native size of the sliced symbol PNGs (see content/slice.mjs). Symbols scale by cell size.
const SYMBOL_TEX = 256;

export function createReelGrid(ctx: ComponentContext): ReelGridInstance {
  const { backend, attrs } = ctx;
  // v0.7: every parameter is tml:<name> from the heir, else data-<name> from the base (ctx.param).
  const param: Param = ctx.param ?? ((name) => ctx.tml[name] ?? attrs[`data-${name}`]);
  const cols = num(param, 'cols', 3);
  const rows = num(param, 'rows', 3);
  const square = num(param, 'cell', 200);
  const gap = num(param, 'gap', 8);
  const cellW = num(param, 'cellw', square);
  const cellH = num(param, 'cellh', square);
  const gapX = num(param, 'gapx', gap);
  const gapY = num(param, 'gapy', gap);
  const pitchX = cellW + gapX;
  const pitchY = cellH + gapY;

  // image-cells mode iff tml:assets is set; otherwise placeholder / multiplier text cells.
  const assets = param('assets');
  const imageMode = assets != null && assets !== '';
  const textPrefix = param('textprefix') ?? '';
  const textSize = num(param, 'textsize', 48);
  const textFill = param('textfill') ?? '#fff';
  const cellBg = param('cellbg') ?? '#333'; // 'none' → no background rect (frame shows through)
  const symFit = num(param, 'symfit', 0.94);
  const symSize = Math.min(cellW, cellH) * symFit;
  const centerX = cellW / 2;
  const centerY = cellH / 2;

  const href = (id: number): string => `${assets}/${id}.png`;

  const root = backend.createNode('g', { id: attrs.id ?? 'reel-grid' });

  // cellNodes[col][row] = the cell container (Animator target).
  // contentNodes[col][row] = the node whose face changes (Sprite in image mode, Text otherwise).
  const cellNodes: NodeHandle[][] = [];
  const contentNodes: NodeHandle[][] = [];

  for (let col = 0; col < cols; col++) {
    cellNodes[col] = [];
    contentNodes[col] = [];
    for (let row = 0; row < rows; row++) {
      const container = backend.createNode('g', { id: `cell_${col}_${row}` });
      // Pivot on the cell centre so scale animations squash symmetrically; the cell's visual
      // top-left still lands at (col*pitchX, row*pitchY).
      backend.setProp(container, 'pivot.x', centerX);
      backend.setProp(container, 'pivot.y', centerY);
      backend.setProp(container, 'x', col * pitchX + centerX);
      backend.setProp(container, 'y', row * pitchY + centerY);

      let content: NodeHandle;
      if (imageMode) {
        const sprite = backend.createNode('image', { href: href(1) });
        backend.setProp(sprite, 'anchor.x', 0.5);
        backend.setProp(sprite, 'anchor.y', 0.5);
        backend.setProp(sprite, 'scale.x', symSize / SYMBOL_TEX);
        backend.setProp(sprite, 'scale.y', symSize / SYMBOL_TEX);
        backend.setProp(sprite, 'x', centerX);
        backend.setProp(sprite, 'y', centerY);
        backend.addChild(container, sprite);
        content = sprite;
      } else {
        if (cellBg !== 'none') {
          const bg = backend.createNode('rect', {
            width: String(cellW),
            height: String(cellH),
            fill: cellBg,
          });
          backend.addChild(container, bg);
        }
        const label = backend.createNode('text', {
          x: String(centerX),
          y: String(centerY),
          'font-size': String(textSize),
          fill: textFill,
          'text-anchor': 'middle',
        });
        backend.addChild(container, label);
        content = label;
      }

      backend.addChild(root, container);
      cellNodes[col][row] = container;
      contentNodes[col][row] = content;
    }
  }

  // Track the id currently shown per cell so the spin loop only swaps a texture on change.
  const shown: number[][] = Array.from({ length: cols }, () => Array.from({ length: rows }, () => -1));

  const setFace = (col: number, row: number, id: number): void => {
    if (shown[col][row] === id) return;
    shown[col][row] = id;
    if (imageMode) backend.setProp(contentNodes[col][row], 'href', href(id));
    else backend.setProp(contentNodes[col][row], 'text', `${textPrefix}${id}`);
  };

  const setColumn = (col: number, symbols: number[]): void => {
    for (let row = 0; row < rows; row++) {
      const sym = symbols[row];
      if (sym != null) setFace(col, row, sym);
    }
  };

  // Spin-loop state, one entry per column. `offset` accumulates in "symbols scrolled".
  const spinning: boolean[] = Array.from({ length: cols }, () => false);
  const offset: number[] = Array.from({ length: cols }, () => 0);
  // Faces to cycle while spinning: fruits + high-pays (wild id 0 is reveal-only), or a custom
  // set via tml:faces (the multiplier reel cycles its X-table values).
  const SPIN_FACES = faceList(param, [1, 2, 3, 4, 5, 6, 7]);
  const SPIN_SPEED = 20; // symbols per second

  const paintSpin = (col: number): void => {
    const o = offset[col];
    const frac = o - Math.floor(o);
    const step = Math.floor(o);
    const bob = (frac - 0.5) * cellH * 0.5;
    for (let row = 0; row < rows; row++) {
      setFace(col, row, SPIN_FACES[(step + row) % SPIN_FACES.length]);
      // Bob the face within the cell so the strip reads as moving vertically.
      backend.setProp(contentNodes[col][row], 'y', centerY + bob);
    }
  };

  const restColumn = (col: number): void => {
    for (let row = 0; row < rows; row++) {
      backend.setProp(contentNodes[col][row], 'y', centerY);
    }
  };

  return {
    root,
    setField(field) {
      for (let col = 0; col < cols && col < field.length; col++) {
        setColumn(col, field[col]);
      }
    },
    startSpin() {
      for (let col = 0; col < cols; col++) spinning[col] = true;
    },
    spinFrame(dt) {
      for (let col = 0; col < cols; col++) {
        if (!spinning[col]) continue;
        offset[col] += dt * SPIN_SPEED;
        paintSpin(col);
      }
    },
    stopReel(col, symbols) {
      spinning[col] = false;
      offset[col] = 0;
      restColumn(col);
      setColumn(col, symbols);
    },
    cells(col) {
      return cellNodes[col] ?? [];
    },
    cell(col, row) {
      return cellNodes[col][row];
    },
  };
}
