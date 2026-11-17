// tileGrid.ts — a tiny custom component for tests (tml:type="tile-grid"): cols×rows cells, each a
// container (pivot at its centre) with a text label. Parameters through ctx.param — tml:<name> of
// the heir, else data-<name> of the base: cols, rows, cellw, cellh, gapx, gapy.

import type { ComponentContext, ComponentInstance } from '../../src/registry';
import type { NodeHandle } from '../../src/render/backend';

export interface TileGridInstance extends ComponentInstance {
  /** field[col][row] → the label text of that cell. */
  setField(field: (string | number)[][]): void;
  cell(col: number, row: number): NodeHandle;
  cells(col: number): NodeHandle[] | undefined;
}

export function createTileGrid(ctx: ComponentContext): TileGridInstance {
  const { backend } = ctx;
  const num = (name: string, fallback: number): number => {
    const v = Number(ctx.param(name));
    return Number.isFinite(v) && ctx.param(name) !== undefined ? v : fallback;
  };
  const cols = num('cols', 3);
  const rows = num('rows', 3);
  const cellW = num('cellw', 100);
  const cellH = num('cellh', 100);
  const pitchX = cellW + num('gapx', 0);
  const pitchY = cellH + num('gapy', 0);
  const root = backend.createNode('g', { id: ctx.attrs.id ?? 'tile-grid' });
  const cells: NodeHandle[][] = [];
  const labels: NodeHandle[][] = [];
  for (let c = 0; c < cols; c++) {
    cells[c] = [];
    labels[c] = [];
    for (let r = 0; r < rows; r++) {
      const cell = backend.createNode('g', { id: `cell_${c}_${r}` });
      backend.setProp(cell, 'pivot.x', cellW / 2);
      backend.setProp(cell, 'pivot.y', cellH / 2);
      backend.setProp(cell, 'x', c * pitchX + cellW / 2);
      backend.setProp(cell, 'y', r * pitchY + cellH / 2);
      backend.addChild(cell, backend.createNode('rect', { width: String(cellW), height: String(cellH), fill: '#333' }));
      const label = backend.createNode('text', { x: String(cellW / 2), y: String(cellH / 2) });
      backend.addChild(cell, label);
      backend.addChild(root, cell);
      cells[c][r] = cell;
      labels[c][r] = label;
    }
  }
  return {
    root,
    setField(field) {
      field.forEach((col, c) => col.forEach((v, r) => labels[c]?.[r] && backend.setProp(labels[c][r], 'text', String(v))));
    },
    cell: (c, r) => cells[c][r],
    cells: (c) => cells[c],
  };
}
