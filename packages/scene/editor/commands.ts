// commands.ts — the editor's command registry: name → JSON Schema of the arguments, a one-line
// description, and the function over the document.
//
// The same registry serves the UI and agents (e.g. over ACP) as its tools: `commands` exports
// schema + describe. A command validates what the schema cannot (node exists, id unique, tag
// allowed) and throws CommandError — the document is then left untouched.
//
// Coordinates are the node's parent space: a move by (dx, dy) shifts the node by that much as its
// parent sees it, whatever the node's own transform.

import { type SceneNode } from '@trempel/scene/core';
import { ALLOWED_TAGS } from '@trempel/scene/internal/parser';
import { IDENTITY, multiply, parseTransform, type Matrix } from '@trempel/scene/internal/transform';
import { parsePathData, type PathCmd } from '@trempel/scene/internal/geom/pathdata';
import type { Element, Node, Text } from '@xmldom/xmldom';
import { CommandError, type Ctx } from './ctx.js';
import { fmt, fmtCoef, num } from './num.js';
import * as P from './path.js';
import type { JSONSchema7 } from './schema.js';
import { cloneWithSource, elementChildren } from './xml.js';
import { prefabCommands } from './prefab.js';

export interface CommandDef {
  schema: JSONSchema7;
  describe: string;
  run(ctx: Ctx, args: never): void;
}

// ---- schema pieces ---------------------------------------------------------------------------

const NODE: JSONSchema7 = { type: 'string', description: 'node id or index path from the svg root ("0/3/1"; "" — the root)' };
const NUMBER: JSONSchema7 = { type: 'number' };
const XY: JSONSchema7 = { type: 'array', items: NUMBER, minItems: 2, maxItems: 2 };
const ID: JSONSchema7 = { type: 'string', pattern: '^[A-Za-z_][\\w.-]*$', description: 'id (a letter or _, then letters, digits, _ . -)' };
const INDEX: JSONSchema7 = { type: 'integer', minimum: 0 };

const obj = (properties: Record<string, JSONSchema7>, required: string[] = []): JSONSchema7 => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

// ---- helpers -------------------------------------------------------------------------------

const CONTAINERS = new Set(['svg', 'g', 'defs', 'clipPath']);

const where = (el: Element): string => (el.getAttribute('id') ? `#${el.getAttribute('id')}` : `<${el.nodeName}>`);

function matrixOf(el: Element): Matrix {
  try {
    return parseTransform(el.getAttribute('transform'));
  } catch (e) {
    throw CommandError.from(e, where(el), 'E_TRANSFORM');
  }
}

/** Product of the transforms from the root down to `el` inclusive. */
function worldOf(el: Element): Matrix {
  const chain: Element[] = [];
  for (let n: Node | null = el; n && n.nodeType === 1; n = n.parentNode) chain.unshift(n as Element);
  return chain.reduce<Matrix>((m, n) => multiply(m, matrixOf(n)), IDENTITY);
}

function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new CommandError('E_EDITOR_VALUE', 'a degenerate transform (scale 0) has no inverse');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** A matrix as a transform attribute: translate / rotate / scale when it is a similarity, else matrix(). */
function writeMatrix(m: Matrix, sep: string): string | null {
  const [a, b, c, d, e, f] = m;
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-9;
  const parts: string[] = [];
  const t = e !== 0 || f !== 0 ? `translate(${fmt(e)}${sep}${fmt(f)})` : '';
  const k = Math.hypot(a, b);
  if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)) return t || null;
  if (k > 0 && near(c, -b) && near(d, a)) {
    // rotation × uniform scale
    const deg = (Math.atan2(b, a) * 180) / Math.PI;
    if (t) parts.push(t);
    if (Math.abs(deg) > 1e-9) parts.push(`rotate(${fmt(deg)})`);
    if (!near(k, 1)) parts.push(`scale(${fmtCoef(k)})`);
    return parts.join(' ') || null;
  }
  return `matrix(${[a, b, c, d].map(fmtCoef).join(sep)}${sep}${fmt(e)}${sep}${fmt(f)})`;
}

/** data-pivot="x y" of an element, or null (absent / unreadable). */
function pivotOf(el: Element): [number, number] | null {
  const raw = el.getAttribute('data-pivot');
  if (raw == null) return null;
  const p = raw.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return p.length === 2 && p.every(Number.isFinite) ? [p[0], p[1]] : null;
}

function requireUniqueId(ctx: Ctx, id: string, arg = 'id'): void {
  if (ctx.byId(id).length) throw new CommandError('E_EDITOR_ID_TAKEN', `${arg}: id "${id}" is already in the document`);
}

function attrValue(v: string | number): string {
  return typeof v === 'number' ? fmt(v) : v;
}

function checkAttrName(name: string): void {
  if (name.startsWith('tml:')) throw new CommandError('E_STERILE', `${name}: the base is sterile — tml:* live in the heir (scene.tml.svg)`);
  if (name === 'xmlns' || name.startsWith('xmlns:')) throw new CommandError('E_EDITOR_ATTR', `${name}: namespaces are not edited`);
}

function clipWarnings(ctx: Ctx, id: string, what: string): void {
  for (const file of ctx.clipRefs.get(id) ?? []) ctx.warn('W_EDITOR_CLIP_REF', `clip ${file} refers to the ${what} id "${id}"`);
}

/** Read a <path>'s d as editable M L C Z (normalizing — with a warning — whatever else it uses). */
function editPath(ctx: Ctx, el: Element, fn: (cmds: P.EditCmd[]) => P.EditCmd[]): void {
  if (el.nodeName !== 'path') throw new CommandError('E_EDITOR_TAG', `${where(el)}: <${el.nodeName}> — path commands work on a <path>`);
  const d = el.getAttribute('d') ?? '';
  let parsed: PathCmd[];
  try {
    parsed = parsePathData(d);
  } catch (e) {
    throw CommandError.from(e, `${where(el)}: d`, 'E_PATH_DATA');
  }
  const cmds = P.toEditCmds(parsed);
  let out: P.EditCmd[];
  try {
    out = fn(cmds);
  } catch (e) {
    if (e instanceof P.PathEditError) throw CommandError.from(e, where(el), 'E_EDITOR_PATH');
    throw e;
  }
  const normalize = P.needsNormalize(d);
  if (!normalize && JSON.stringify(out) === JSON.stringify(cmds)) return;
  if (normalize) {
    const arcs = parsed.some((c) => c[0] === 'A');
    ctx.warn('W_EDITOR_PATH_REWRITTEN', `${where(el)}: d rewritten as absolute M L C Z${arcs ? ' (A arcs approximated by cubics)' : ''}`);
  }
  ctx.setAttr(el, 'd', P.printPath(out));
}

/** Shift by (dx, dy) in the PARENT's space: the node's own linear transform is undone first. */
function localDelta(el: Element, dx: number, dy: number): { x: number; y: number } {
  const [a, b, c, d] = matrixOf(el);
  const inv = invert([a, b, c, d, 0, 0]);
  return { x: inv[0] * dx + inv[2] * dy, y: inv[1] * dx + inv[3] * dy };
}

function shiftAttr(ctx: Ctx, el: Element, name: string, delta: number): void {
  const raw = el.getAttribute(name);
  if (raw != null && /[\s,]/.test(raw.trim())) {
    throw new CommandError('E_EDITOR_VALUE', `${where(el)}: ${name}="${raw}" — a list of values cannot be shifted, only a single number`);
  }
  const v = num(raw);
  if (!Number.isFinite(v)) throw new CommandError('E_EDITOR_VALUE', `${where(el)}: ${name}="${raw}" — not a number`);
  if (delta === 0) return;
  ctx.setAttr(el, name, fmt(v + delta));
}

const TRANSLATE_HEAD = /^(\s*translate\(\s*)([^\s,)]+)(\s*,\s*|\s+)?([^\s,)]+)?(\s*\))/;

// ---- the registry ----------------------------------------------------------------------------

const defs = {
  'node.setAttr': {
    describe: 'Set a node attribute (value: null — remove it). tml:* are not allowed in the base; id — via node.setId.',
    schema: obj(
      { node: NODE, name: { type: 'string', minLength: 1 }, value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] } },
      ['node', 'name', 'value'],
    ),
    run(ctx: Ctx, a: { node: string; name: string; value: string | number | null }) {
      checkAttrName(a.name);
      if (a.name === 'id') throw new CommandError('E_EDITOR_ATTR', 'id is changed by node.setId (it also fixes clip-path references)');
      const el = ctx.node(a.node);
      ctx.setAttr(el, a.name, a.value === null ? null : attrValue(a.value));
    },
  },

  'node.setId': {
    describe: 'Rename a node; clip-path="url(#…)" references in the document are updated, clips get a warning.',
    schema: obj({ node: NODE, id: ID }, ['node', 'id']),
    run(ctx: Ctx, a: { node: string; id: string }) {
      const el = ctx.node(a.node);
      const old = el.getAttribute('id');
      if (old === a.id) return;
      requireUniqueId(ctx, a.id);
      ctx.setAttr(el, 'id', a.id);
      if (!old) return;
      for (const n of ctx.allElements()) {
        const cp = n.getAttribute('clip-path');
        if (cp && new RegExp(`^\\s*url\\(\\s*['"]?#${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*\\)\\s*$`).test(cp)) {
          ctx.setAttr(n, 'clip-path', `url(#${a.id})`);
        }
      }
      clipWarnings(ctx, old, 'old');
    },
  },

  'node.setText': {
    describe: 'Replace the text of a <text> (the base\'s mock-up string; a binding in the heir overrides it).',
    schema: obj({ node: NODE, text: { type: 'string' } }, ['node', 'text']),
    run(ctx: Ctx, a: { node: string; text: string }) {
      const el = ctx.node(a.node);
      if (el.nodeName !== 'text') throw new CommandError('E_EDITOR_TAG', `${where(el)}: <${el.nodeName}> — only a <text> has text`);
      ctx.setText(el, a.text);
    },
  },

  'node.move': {
    describe: 'Move a node by (dx, dy) in its parent\'s coordinates: translate on a <g>, x/y, cx/cy, x1…y2, the points of d.',
    schema: obj({ node: NODE, dx: NUMBER, dy: NUMBER }, ['node', 'dx', 'dy']),
    run(ctx: Ctx, a: { node: string; dx: number; dy: number }) {
      const el = ctx.node(a.node);
      const tag = el.nodeName;
      if (a.dx === 0 && a.dy === 0) return;
      if (tag === 'svg' || tag === 'defs' || tag === 'clipPath') {
        throw new CommandError('E_EDITOR_TAG', `${where(el)}: <${tag}> does not move — move its content`);
      }
      if (tag === 'g') {
        const tr = el.getAttribute('transform') ?? '';
        const head = TRANSLATE_HEAD.exec(tr);
        if (tr.trim() === '') ctx.setAttr(el, 'transform', `translate(${fmt(a.dx)}${ctx.sep}${fmt(a.dy)})`);
        else if (head) {
          const x = Number(head[2]) + a.dx;
          const y = Number(head[4] ?? 0) + a.dy;
          const sep = head[3] ?? ctx.sep;
          ctx.setAttr(el, 'transform', `${head[1]}${fmt(x)}${sep}${fmt(y)}${head[5]}${tr.slice(head[0].length)}`);
        } else {
          matrixOf(el);
          ctx.setAttr(el, 'transform', `translate(${fmt(a.dx)}${ctx.sep}${fmt(a.dy)}) ${tr.trim()}`);
        }
        return;
      }
      const d = localDelta(el, a.dx, a.dy);
      switch (tag) {
        case 'image':
        case 'rect':
        case 'text':
        case 'use':
          shiftAttr(ctx, el, 'x', d.x);
          shiftAttr(ctx, el, 'y', d.y);
          break;
        case 'circle':
        case 'ellipse':
          shiftAttr(ctx, el, 'cx', d.x);
          shiftAttr(ctx, el, 'cy', d.y);
          break;
        case 'line':
          shiftAttr(ctx, el, 'x1', d.x);
          shiftAttr(ctx, el, 'y1', d.y);
          shiftAttr(ctx, el, 'x2', d.x);
          shiftAttr(ctx, el, 'y2', d.y);
          break;
        case 'path': {
          let parsed: PathCmd[];
          try {
            parsed = parsePathData(el.getAttribute('d') ?? '');
          } catch (e) {
            throw CommandError.from(e, `${where(el)}: d`, 'E_PATH_DATA');
          }
          ctx.setAttr(el, 'd', P.printParsed(P.shiftParsed(parsed, d.x, d.y)));
          break;
        }
        default:
          throw new CommandError('E_EDITOR_TAG', `${where(el)}: cannot move a <${tag}>`);
      }
    },
  },

  'node.setTransform': {
    describe:
      'Rebuild transform from parts: translate(t+pivot) rotate scale translate(-pivot). No parts — transform is removed. pivot defaults to the node\'s data-pivot.',
    schema: obj(
      {
        node: NODE,
        translate: XY,
        rotate: { type: 'number', description: 'degrees' },
        scale: { anyOf: [{ type: 'number' }, XY] },
        pivot: XY,
      },
      ['node'],
    ),
    run(ctx: Ctx, a: { node: string; translate?: number[]; rotate?: number; scale?: number | number[]; pivot?: number[] }) {
      const el = ctx.node(a.node);
      if (el === ctx.root) throw new CommandError('E_EDITOR_ROOT', 'the root <svg> takes no transform');
      const s = ctx.sep;
      const [tx, ty] = a.translate ?? [0, 0];
      const [px, py] = a.pivot ?? pivotOf(el) ?? [0, 0];
      const rot = a.rotate ?? 0;
      const [sx, sy] = a.scale == null ? [1, 1] : typeof a.scale === 'number' ? [a.scale, a.scale] : a.scale;
      const linear = rot !== 0 || sx !== 1 || sy !== 1;
      const parts: string[] = [];
      const hx = tx + (linear ? px : 0);
      const hy = ty + (linear ? py : 0);
      if (hx !== 0 || hy !== 0) parts.push(`translate(${fmt(hx)}${s}${fmt(hy)})`);
      if (rot !== 0) parts.push(`rotate(${fmt(rot)})`);
      if (sx !== 1 || sy !== 1) parts.push(sx === sy ? `scale(${fmtCoef(sx)})` : `scale(${fmtCoef(sx)}${s}${fmtCoef(sy)})`);
      if (linear && (px !== 0 || py !== 0)) parts.push(`translate(${fmt(-px)}${s}${fmt(-py)})`);
      ctx.setAttr(el, 'transform', parts.length ? parts.join(' ') : null);
    },
  },

  'node.setPivot': {
    describe:
      'The node\'s pivot (data-pivot="x y", in its own space before transform): rotation and scale go around it — by handles, clips, setTransform. keepWorld (default true) — the node stays in place (same matrix); false — the transform parts (translate, rotate, scale) keep their numbers but now turn around the new pivot (the node shifts).',
    schema: obj({ node: NODE, x: NUMBER, y: NUMBER, keepWorld: { type: 'boolean' } }, ['node', 'x', 'y']),
    run(ctx: Ctx, a: { node: string; x: number; y: number; keepWorld?: boolean }) {
      const el = ctx.node(a.node);
      if (el === ctx.root || el.nodeName === 'defs' || el.nodeName === 'clipPath') {
        throw new CommandError('E_EDITOR_TAG', `${where(el)}: <${el.nodeName}> has no pivot — the node is not drawn`);
      }
      const [ox, oy] = pivotOf(el) ?? [0, 0];
      ctx.setAttr(el, 'data-pivot', `${fmt(a.x)} ${fmt(a.y)}`);
      if (a.keepWorld !== false) return;
      // translate part t = M(p) − p stays; the same linear part now turns around the new pivot.
      const m = matrixOf(el);
      const [la, lb, lc, ld] = m;
      const tx = la * ox + lc * oy + m[4] - ox;
      const ty = lb * ox + ld * oy + m[5] - oy;
      const next: Matrix = [la, lb, lc, ld, tx + a.x - (la * a.x + lc * a.y), ty + a.y - (lb * a.x + ld * a.y)];
      ctx.setAttr(el, 'transform', writeMatrix(next, ctx.sep));
    },
  },

  'node.resize': {
    describe:
      'Node size (v1.0): <image> — width/height (with data-slices it is the panel size, borders 1:1), <rect> — width/height, <g data-size> — data-size, an instance of a resizable prefab (<use>, data-resizable) — width/height along its axes (null — remove: the minimum size). An axis without a value is left as is.',
    schema: obj(
      {
        node: NODE,
        width: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
        height: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
      },
      ['node'],
    ),
    run(ctx: Ctx, a: { node: string; width?: number | null; height?: number | null }) {
      const el = ctx.node(a.node);
      const tag = el.nodeName;
      if (tag === 'use') {
        const id = el.getAttribute('id') ?? '';
        let inst: SceneNode['instance'];
        const find = (n: SceneNode): void => {
          if (inst) return;
          if (n.instance && n.attrs.id === id) inst = n.instance;
          else n.children.forEach(find);
        };
        find(ctx.env.merged());
        if (!inst) throw new CommandError('E_EDITOR_NOT_EXPANDED', `${where(el)}: the instance is not expanded (the prefab is missing or has errors — see doc.errors)`);
        const axes = inst.resizable ?? '';
        for (const [k, axis] of [['width', 'x'], ['height', 'y']] as const) {
          if (a[k] === undefined) continue;
          if (!axes.includes(axis)) {
            throw new CommandError('E_PREFAB_RESIZE', `${where(el)}: ${inst.href} ${axes ? `resizes only along ${axes}` : 'does not resize (no data-resizable) — to scale the instance: node.setTransform'}`);
          }
          ctx.setAttr(el, k, a[k] === null ? null : fmt(a[k] as number));
        }
        return;
      }
      if (tag === 'g') {
        const raw = el.getAttribute('data-size');
        if (raw == null) throw new CommandError('E_EDITOR_TAG', `${where(el)}: the <g> has no size — data-size="w h" makes a group a box for anchors`);
        const [w0, h0] = raw.trim().split(/[\s,]+/).map(Number);
        const w = a.width ?? w0;
        const h = a.height ?? h0;
        ctx.setAttr(el, 'data-size', `${fmt(w)} ${fmt(h)}`);
        return;
      }
      if (tag !== 'image' && tag !== 'rect') {
        throw new CommandError('E_EDITOR_TAG', `${where(el)}: size is set on an <image>, <rect>, <g data-size> or an instance of a resizable prefab, not on a <${tag}>`);
      }
      for (const k of ['width', 'height'] as const) {
        if (a[k] === undefined) continue;
        if (a[k] === null) throw new CommandError('E_EDITOR_VALUE', `${where(el)}: ${k} of a <${tag}> cannot be removed — give a number`);
        ctx.setAttr(el, k, fmt(a[k] as number));
      }
    },
  },

  'node.reorder': {
    describe: 'Put a node at position index among its siblings (z-order: 0 — the bottom).',
    schema: obj({ node: NODE, index: INDEX }, ['node', 'index']),
    run(ctx: Ctx, a: { node: string; index: number }) {
      const el = ctx.node(a.node);
      const parent = el.parentNode as Element | null;
      if (!parent || el === ctx.root) throw new CommandError('E_EDITOR_ROOT', 'the root has no siblings');
      const kids = elementChildren(parent);
      if (a.index >= kids.length) throw new CommandError('E_EDITOR_INDEX', `index ${a.index}: <${parent.nodeName}> has ${kids.length} children — allowed 0…${kids.length - 1}`);
      if (kids.indexOf(el) === a.index) return;
      ctx.move(el, parent, a.index);
    },
  },

  'node.reparent': {
    describe: 'Move a node to another parent (index — its position among the children, default last); the world position is kept.',
    schema: obj({ node: NODE, parent: NODE, index: INDEX }, ['node', 'parent']),
    run(ctx: Ctx, a: { node: string; parent: string; index?: number }) {
      const el = ctx.node(a.node);
      const parent = ctx.node(a.parent, 'parent');
      if (el === ctx.root) throw new CommandError('E_EDITOR_ROOT', 'the root cannot be moved');
      if (!CONTAINERS.has(parent.nodeName)) throw new CommandError('E_EDITOR_TAG', `parent: <${parent.nodeName}> is not a container (containers: ${[...CONTAINERS].join(', ')})`);
      for (let n: Node | null = parent; n; n = n.parentNode) {
        if (n === el) throw new CommandError('E_EDITOR_REPARENT', 'parent: a node cannot be moved into itself');
      }
      const oldParent = el.parentNode as Element;
      const local = multiply(multiply(invert(worldOf(parent)), worldOf(oldParent)), matrixOf(el));
      const count = elementChildren(parent).length - (oldParent === parent ? 1 : 0);
      if (a.index != null && a.index > count) throw new CommandError('E_EDITOR_INDEX', `index ${a.index}: <${parent.nodeName}> will have ${count} children — allowed 0…${count}`);
      ctx.move(el, parent, a.index ?? count);
      const t = writeMatrix(local, ctx.sep);
      const before = el.getAttribute('transform');
      if (before !== t && !(before == null && t == null)) {
        if (before != null && t != null) {
          // equal matrices written differently: keep the original text
          const same = parseTransform(before).every((v, i) => Math.abs(v - local[i]) < 1e-9);
          if (same) return;
        }
        ctx.setAttr(el, 'transform', t);
      }
    },
  },

  'node.insert': {
    describe: 'Insert an XML fragment (exactly one element) into parent at position index (default last).',
    schema: obj({ parent: NODE, index: INDEX, xml: { type: 'string', minLength: 1 } }, ['parent', 'xml']),
    run(ctx: Ctx, a: { parent: string; index?: number; xml: string }) {
      const parent = ctx.node(a.parent, 'parent');
      if (!CONTAINERS.has(parent.nodeName)) throw new CommandError('E_EDITOR_TAG', `parent: <${parent.nodeName}> is not a container (containers: ${[...CONTAINERS].join(', ')})`);
      const el = ctx.fragment(a.xml, parent);
      const ids = new Set<string>();
      for (const n of ctx.allElements(el)) {
        if (!ALLOWED_TAGS.has(n.nodeName)) {
          throw new CommandError('E_TAG', `xml: <${n.nodeName}> is outside the format (supported: ${[...ALLOWED_TAGS].join(', ')})`);
        }
        for (let i = 0; i < n.attributes.length; i++) checkAttrName(n.attributes[i].name);
        const id = n.getAttribute('id');
        if (id) {
          if (ids.has(id)) throw new CommandError('E_DUP_ID', `xml: id "${id}" twice in the fragment`);
          requireUniqueId(ctx, id, 'xml');
          ids.add(id);
        }
      }
      if (el.nodeName === 'svg') throw new CommandError('E_EDITOR_FRAGMENT', 'xml: an <svg> cannot be inserted into the scene');
      ctx.insert(parent, el, a.index);
    },
  },

  'node.remove': {
    describe: 'Remove a node with its subtree.',
    schema: obj({ node: NODE }, ['node']),
    run(ctx: Ctx, a: { node: string }) {
      const el = ctx.node(a.node);
      if (el === ctx.root) throw new CommandError('E_EDITOR_ROOT', 'the root cannot be removed');
      for (const n of ctx.allElements(el)) {
        const id = n.getAttribute('id');
        if (id) clipWarnings(ctx, id, 'removed');
      }
      ctx.remove(el);
    },
  },

  'node.duplicate': {
    describe: 'A copy of a node right after it; ids in the copy get a suffix (default -2, -3… up to a free one).',
    schema: obj({ node: NODE, idSuffix: { type: 'string', minLength: 1 } }, ['node']),
    run(ctx: Ctx, a: { node: string; idSuffix?: string }) {
      const el = ctx.node(a.node);
      const parent = el.parentNode as Element | null;
      if (!parent || el === ctx.root) throw new CommandError('E_EDITOR_ROOT', 'the root cannot be copied');
      const copy = cloneWithSource(el, ctx.doc) as Element;
      const nodes = ctx.allElements(copy);
      const ids = nodes.map((n) => n.getAttribute('id')).filter((x): x is string => !!x);
      const taken = (id: string): boolean => ctx.byId(id).length > 0;
      let suffix = a.idSuffix;
      if (suffix == null) {
        for (let k = 2; ; k++) {
          if (ids.every((id) => !taken(`${id}-${k}`))) {
            suffix = `-${k}`;
            break;
          }
        }
      } else {
        const clash = ids.find((id) => taken(id + suffix));
        if (clash) throw new CommandError('E_EDITOR_ID_TAKEN', `idSuffix: id "${clash + suffix}" is already in the document`);
      }
      const renamed = new Map(ids.map((id) => [id, id + suffix]));
      for (const n of nodes) {
        const id = n.getAttribute('id');
        if (id) n.setAttribute('id', renamed.get(id)!);
        const cp = n.getAttribute('clip-path');
        const m = cp ? /#([^'")\s]+)/.exec(cp) : null;
        if (m && renamed.has(m[1])) n.setAttribute('clip-path', `url(#${renamed.get(m[1])})`);
      }
      ctx.insert(parent, copy, elementChildren(parent).indexOf(el) + 1);
    },
  },

  'path.setData': {
    describe: 'Replace the whole d of a path.',
    schema: obj({ node: NODE, d: { type: 'string', minLength: 1 } }, ['node', 'd']),
    run(ctx: Ctx, a: { node: string; d: string }) {
      const el = ctx.node(a.node);
      if (el.nodeName !== 'path') throw new CommandError('E_EDITOR_TAG', `${where(el)}: <${el.nodeName}> — only a <path> has d`);
      try {
        parsePathData(a.d);
      } catch (e) {
        throw CommandError.from(e, 'd', 'E_PATH_DATA');
      }
      ctx.setAttr(el, 'd', a.d);
    },
  },

  'path.setPoint': {
    describe: 'Move point index of the path (its handles move with it).',
    schema: obj({ node: NODE, index: INDEX, x: NUMBER, y: NUMBER }, ['node', 'index', 'x', 'y']),
    run(ctx: Ctx, a: { node: string; index: number; x: number; y: number }) {
      editPath(ctx, ctx.node(a.node), (c) => P.setPoint(c, a.index, { x: a.x, y: a.y }));
    },
  },

  'path.setHandle': {
    describe: 'Place a Bézier handle of point index (which: in — incoming, out — outgoing); linked — mirror the opposite one.',
    schema: obj(
      { node: NODE, index: INDEX, which: { type: 'string', enum: ['in', 'out'] }, x: NUMBER, y: NUMBER, linked: { type: 'boolean' } },
      ['node', 'index', 'which', 'x', 'y'],
    ),
    run(ctx: Ctx, a: { node: string; index: number; which: 'in' | 'out'; x: number; y: number; linked?: boolean }) {
      editPath(ctx, ctx.node(a.node), (c) => P.setHandle(c, a.index, a.which, { x: a.x, y: a.y }, !!a.linked));
    },
  },

  'path.insertPoint': {
    describe: 'Split segment segment at t (0<t<1) keeping the shape; segments are the L/C in order and the closing line of Z.',
    schema: obj({ node: NODE, segment: INDEX, t: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 } }, ['node', 'segment', 't']),
    run(ctx: Ctx, a: { node: string; segment: number; t: number }) {
      editPath(ctx, ctx.node(a.node), (c) => P.insertPoint(c, a.segment, a.t));
    },
  },

  'path.removePoint': {
    describe: 'Remove point index; the neighbouring segments are joined into one.',
    schema: obj({ node: NODE, index: INDEX }, ['node', 'index']),
    run(ctx: Ctx, a: { node: string; index: number }) {
      editPath(ctx, ctx.node(a.node), (c) => P.removePoint(c, a.index));
    },
  },

  'path.close': {
    describe: 'Close a subpath (Z); subpath — its number, default the last.',
    schema: obj({ node: NODE, subpath: INDEX }, ['node']),
    run(ctx: Ctx, a: { node: string; subpath?: number }) {
      editPath(ctx, ctx.node(a.node), (c) => P.closePath(c, a.subpath));
    },
  },

  'path.open': {
    describe: 'Open a subpath (remove Z); subpath — its number, default the last.',
    schema: obj({ node: NODE, subpath: INDEX }, ['node']),
    run(ctx: Ctx, a: { node: string; subpath?: number }) {
      editPath(ctx, ctx.node(a.node), (c) => P.openPath(c, a.subpath));
    },
  },

  'path.setNodeType': {
    describe: 'Node type of point index: smooth — align the handles on one line (lengths kept), corner — independent handles.',
    schema: obj({ node: NODE, index: INDEX, type: { type: 'string', enum: ['corner', 'smooth'] } }, ['node', 'index', 'type']),
    run(ctx: Ctx, a: { node: string; index: number; type: 'corner' | 'smooth' }) {
      editPath(ctx, ctx.node(a.node), (c) => P.setNodeType(c, a.index, a.type));
    },
  },

  'defs.ensure': {
    describe: 'Create <defs id="defs"> as the first child of the root, if there is none.',
    schema: obj({}),
    run(ctx: Ctx) {
      ensureDefs(ctx);
    },
  },

  'clip.create': {
    describe: 'Create a <clipPath id> in <defs> with one shape (shape: rect | path, attrs — its attributes: x y width height rx | d).',
    schema: obj(
      {
        id: ID,
        shape: { type: 'string', enum: ['rect', 'path'] },
        attrs: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      },
      ['id', 'shape', 'attrs'],
    ),
    run(ctx: Ctx, a: { id: string; shape: 'rect' | 'path'; attrs: Record<string, string | number> }) {
      requireUniqueId(ctx, a.id);
      if (a.shape === 'path' && a.attrs.d == null) throw new CommandError('E_EDITOR_ARGS', 'attrs: a path needs d');
      if (a.shape === 'rect' && (a.attrs.width == null || a.attrs.height == null)) throw new CommandError('E_EDITOR_ARGS', 'attrs: a rect needs width and height');
      const defsEl = ensureDefs(ctx);
      const kids = elementChildren(defsEl);
      const prev = kids.length ? kids[kids.length - 1].previousSibling : defsEl.previousSibling;
      const m = prev && prev.nodeType === 3 ? /\n([ \t]*)$/.exec((prev as Text).data) : null;
      const indent = kids.length ? (m?.[1] ?? '    ') : `${m?.[1] ?? ''}  `;
      const clip = ctx.doc.createElement('clipPath');
      clip.setAttribute('id', a.id);
      const shape = ctx.doc.createElement(a.shape);
      for (const [k, v] of Object.entries(a.attrs)) {
        checkAttrName(k);
        shape.setAttribute(k, attrValue(v));
      }
      clip.appendChild(ctx.doc.createTextNode(`\n${indent}  `));
      clip.appendChild(shape);
      clip.appendChild(ctx.doc.createTextNode(`\n${indent}`));
      ctx.insert(defsEl, clip);
    },
  },

  'clip.assign': {
    describe: 'Mask a node (<g>, <image>): clip-path="url(#clip)"; clip: null — remove the mask.',
    schema: obj({ node: NODE, clip: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, ['node', 'clip']),
    run(ctx: Ctx, a: { node: string; clip: string | null }) {
      const el = ctx.node(a.node);
      if (el.nodeName !== 'g' && el.nodeName !== 'image') {
        throw new CommandError('E_EDITOR_TAG', `${where(el)}: only a <g> or an <image> takes a mask`);
      }
      if (a.clip === null) {
        ctx.setAttr(el, 'clip-path', null);
        return;
      }
      const target = ctx.byId(a.clip)[0];
      if (!target) throw new CommandError('E_EDITOR_NO_NODE', `clip: no node #${a.clip}`);
      if (target.nodeName !== 'clipPath') throw new CommandError('E_EDITOR_TAG', `clip: #${a.clip} is a <${target.nodeName}>, not a <clipPath>`);
      ctx.setAttr(el, 'clip-path', `url(#${a.clip})`);
    },
  },

  'layer.create': {
    describe: 'Create an empty layer <g id> in parent (default the root) at position index (default last).',
    schema: obj({ parent: NODE, id: ID, index: INDEX }, ['id']),
    run(ctx: Ctx, a: { parent?: string; id: string; index?: number }) {
      const parent = a.parent == null ? ctx.root : ctx.node(a.parent, 'parent');
      if (parent.nodeName !== 'svg' && parent.nodeName !== 'g') throw new CommandError('E_EDITOR_TAG', `parent: a layer lives in an <svg> or a <g>, not in a <${parent.nodeName}>`);
      requireUniqueId(ctx, a.id);
      const g = ctx.doc.createElement('g');
      g.setAttribute('id', a.id);
      ctx.insert(parent, g, a.index);
    },
  },
  ...prefabCommands,
} satisfies Record<string, { describe: string; schema: JSONSchema7; run(ctx: Ctx, a: never): void }>;

function ensureDefs(ctx: Ctx): Element {
  const existing = elementChildren(ctx.root).find((c) => c.nodeName === 'defs');
  if (existing) return existing;
  const el = ctx.doc.createElement('defs');
  el.setAttribute('id', 'defs');
  ctx.insert(ctx.root, el, 0);
  return el;
}

export type CommandName = keyof typeof defs;

/** Internal: name → full definition (with run). */
export const registry: Record<string, CommandDef> = defs as unknown as Record<string, CommandDef>;

/** Public registry: name → { schema, describe } — the editor's tools for a UI or an agent. */
export const commands: Record<CommandName, { schema: JSONSchema7; describe: string }> = Object.fromEntries(
  Object.entries(defs).map(([k, v]) => [k, { schema: v.schema, describe: v.describe }]),
) as Record<CommandName, { schema: JSONSchema7; describe: string }>;
