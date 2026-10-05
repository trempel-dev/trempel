// inspector.ts — fields of the selected node by tag. Enter / blur → a core command, Esc — back to
// the document's value. Transform in parts (translate / rotate / scale around a pivot →
// node.setTransform), text (node.setText), d (path.setData), clip-path from the <clipPath>s of
// <defs> (clip.assign), data-* parameters of components as a key/value table.
// v0.8 (batch 2): mix-blend-mode (select → style), data-tint (colour), data-z (number), data-views
// (name → href table with «…»), data-pivot — the transform's pivot pair writes it (node.setPivot,
// keepWorld); shown as the bounds' centre until set, «центр» sets it there.

import { coded, type SceneNode } from '../../src/core.js';
import { BLEND_MODES, parseBlend, parseViews } from '../../src/props.js';
import { parseTransform } from '../../src/transform.js';
import { boxCenter, decompose, invert, apply, nodeWorld, transformArgs, type Call, type TransformParts } from '../geometry';
import { relativeTo } from '../io';
import type { Editor } from './editor';

const h = (tag: string, cls = '', text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const FIELDS: Record<string, string[]> = {
  image: ['href', 'x', 'y', 'width', 'height'],
  text: ['x', 'y', 'font-size', 'fill'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'stroke-width'],
  circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width'],
  ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width'],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width'],
  path: ['fill', 'stroke', 'stroke-width'],
  g: [],
  use: ['x', 'y'],
};
const NUMERIC = new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'font-size', 'stroke-width', 'opacity']);
const CLIPPABLE = new Set(['g', 'image']);
/** v0.8: who takes what (props.ts). */
const BLENDABLE = new Set(['g', 'image', 'rect', 'path', 'circle', 'ellipse', 'line']);
const TINTABLE = new Set(['g', 'image']);
const UNDRAWN = new Set(['svg', 'defs', 'clipPath']);
/** data-* with their own fields (not in the parameters table). */
const OWN_DATA = new Set(['data-tint', 'data-z', 'data-views', 'data-pivot', 'data-slices', 'data-tile', 'data-anchor', 'data-stretch', 'data-size', 'data-resizable']);
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

export class Inspector {
  constructor(
    private readonly ed: Editor,
    private readonly box: HTMLElement,
    private readonly what: HTMLElement,
    /** A file of the scene folder (relative to it) for an image's href; null — cancelled. */
    private readonly pickImage?: () => Promise<string | null>,
    /** v0.9: a scene of the folder (its base path) for an instance's href; null — cancelled. */
    private readonly pickScene?: () => Promise<string | null>,
    /** «в курсор»: the next click on the stage sets the selection's pivot (the `.` operator). */
    private readonly pickPivot?: () => void,
  ) {
    for (const e of ['render', 'selection'] as const) ed.on(e, () => this.draw());
  }

  draw(): void {
    const ed = this.ed;
    const box = this.box;
    const focused = document.activeElement instanceof HTMLElement && box.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    box.replaceChildren();
    this.what.textContent = '';
    if (!ed.doc) return;
    if (ed.selection.length !== 1) {
      box.append(h('div', 'note', ed.selection.length ? `nodes selected: ${ed.selection.length}` : 'select a node on the stage or in the tree'));
      return;
    }
    const path = ed.selection[0];
    const n = ed.node(path);
    if (!n) return;
    const ref = ed.ref(path);
    this.what.textContent = `<${n.tag}>${n.attrs.id ? ' #' + n.attrs.id : ''} · ${path}`;

    // id
    box.append(this.field('id', n.attrs.id ?? '', (v) => (v ? ed.exec('node.setId', { node: ref, id: v }) : null)));

    // v0.9: an instance — the prefab and its parameters
    if (n.tag === 'use') this.instance(n, ref, path);

    // transform
    if (n.tag !== 'svg' && n.tag !== 'defs') this.transform(n, path, ref);

    // tag attributes
    const names = FIELDS[n.tag] ?? [];
    if (names.length || n.tag === 'text' || n.tag === 'path') box.append(h('h4', '', 'attributes'));
    if (n.tag === 'text') box.append(this.field('text', n.text ?? '', (v) => ed.exec('node.setText', { node: ref, text: v }), 'text'));
    for (const k of names) {
      const row = this.attrField(ref, n, k);
      if (k === 'href' && n.tag === 'image' && this.pickImage) row.append(this.hrefButton(ref));
      box.append(row);
    }
    if (n.tag === 'path') {
      const ta = document.createElement('textarea');
      ta.value = n.attrs.d ?? '';
      ta.dataset.key = 'd';
      ta.spellcheck = false;
      const commit = (): void => {
        if (ta.value.trim() && ta.value !== (n.attrs.d ?? '')) ed.exec('path.setData', { node: ref, d: ta.value.trim() });
      };
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          ta.value = n.attrs.d ?? '';
          ta.classList.remove('dirty');
        }
      };
      ta.oninput = () => ta.classList.toggle('dirty', ta.value !== (n.attrs.d ?? ''));
      ta.onblur = commit;
      box.append(h('div', 'note', 'd — ⌘Enter or leaving the field applies it'), ta);
      const tool = h('button', '', 'contour (P)') as HTMLButtonElement;
      tool.onclick = () => ed.setTool('path');
      box.append(tool);
    }
    if (n.tag === 'line') {
      const tool = h('button', '', 'ends (P)') as HTMLButtonElement;
      tool.onclick = () => ed.setTool('path');
      box.append(tool);
    }
    if (n.tag !== 'svg' && n.tag !== 'defs' && n.tag !== 'clipPath') box.append(this.attrField(ref, n, 'opacity'));

    // clip-path
    if (CLIPPABLE.has(n.tag)) box.append(this.clip(n, ref));

    // v0.8: blend, tint, z, views
    if (!UNDRAWN.has(n.tag)) this.v08(n, ref);

    // v1.0: 9-slice, anchors, stretch, the box
    if (n.tag !== 'defs' && n.tag !== 'clipPath') this.v10(n, ref);

    // data-*
    if (n.tag !== 'defs' && n.tag !== 'clipPath' && n.tag !== 'use') box.append(this.dataTable(n, ref));

    // v0.9: a group → a new prefab
    if (n.tag === 'g' && n.attrs.id) box.append(this.toPrefab(n, path));

    if (focused) (box.querySelector(`[data-key="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
  }

  /** v0.9: href (a scene of the folder), «open», parameters by the prefab's contract, detach. */
  private instance(n: SceneNode, ref: string, path: string): void {
    const ed = this.ed;
    const box = this.box;
    const info = ed.doc?.instance(ref) ?? null;
    box.append(h('h4', '', 'prefab'));
    const hrefRow = this.field('href', n.attrs.href ?? '', (v) => (v.trim() ? ed.exec('node.setAttr', { node: ref, name: 'href', value: v.trim() }) : null), 'attr:href');
    if (this.pickScene) {
      const b = h('button', 'pick', '…') as HTMLButtonElement;
      b.title = 'Pick a scene of the folder';
      b.onclick = () => {
        void this.pickScene!().then((file) => {
          const base = ed.entry?.base;
          if (file && base) ed.exec('node.setAttr', { node: ref, name: 'href', value: relativeTo(base, file) });
        });
      };
      hrefRow.append(b);
    }
    box.append(hrefRow);
    const open = h('button', 'link', 'open prefab') as HTMLButtonElement;
    open.dataset.key = 'open-prefab';
    open.onclick = () => void ed.openPrefab(path);
    box.append(open);
    if (info && !info.expanded) box.append(h('div', 'err', 'prefab not expanded — see the errors'));

    box.append(h('h4', '', 'parameters'));
    for (const p of info?.params ?? []) {
      const row = this.field(p.name, p.own ? p.value : '', (v) => ed.exec('prefab.setParam', { node: ref, name: p.name, value: v === '' ? null : v }), `param:${p.name}`);
      row.classList.add('param-row');
      const label = row.querySelector('label')!;
      if (p.required) {
        label.classList.add('req');
        label.title = 'required (params of the prefab contract)';
      }
      const input = row.querySelector('input')!;
      if (p.default != null) input.placeholder = p.default === '' ? '(empty)' : p.default;
      if (p.own) {
        const off = h('button', 'link', '×') as HTMLButtonElement;
        off.title = 'unset — the default value stays';
        off.onclick = () => ed.exec('prefab.setParam', { node: ref, name: p.name, value: null });
        row.append(off);
      }
      box.append(row);
    }
    for (const m of info?.missing ?? []) box.append(h('div', 'err', coded('E_PARAM_MISSING', `${m} is not set — ${info!.href} requires it`)));
    // a parameter the prefab does not declare (it may still read it through self)
    const add = h('div', 'row');
    const name = document.createElement('input');
    name.placeholder = 'data-…';
    name.dataset.key = 'param:new';
    const value = document.createElement('input');
    value.placeholder = 'value';
    const go = (): void => {
      if (name.value.trim()) ed.exec('prefab.setParam', { node: ref, name: name.value.trim(), value: value.value });
    };
    for (const i of [name, value]) {
      i.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
      };
    }
    add.append(name, value);
    box.append(add);

    const detach = h('button', '', 'detach') as HTMLButtonElement;
    detach.dataset.key = 'detach';
    detach.title = 'expand into a <g> copy: the children become editable, the link to the prefab is cut';
    detach.onclick = () => ed.exec('prefab.detach', { node: ref });
    box.append(detach);
  }

  /** v0.9: «в префаб» — the group becomes a new file + an instance in its place. */
  private toPrefab(n: SceneNode, path: string): HTMLElement {
    const wrap = h('div');
    wrap.append(h('h4', '', 'to prefab'));
    const row = h('div', 'row');
    const input = document.createElement('input');
    input.dataset.key = 'extract';
    input.value = `ui/${n.attrs.id}.svg`;
    const b = h('button', '', 'create') as HTMLButtonElement;
    b.title = 'group → a new prefab file (path relative to the scene) + a <use> in its place';
    const go = (): void => {
      if (input.value.trim()) void this.ed.extract(path, input.value.trim());
    };
    b.onclick = go;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
    };
    row.append(input, b);
    wrap.append(row);
    return wrap;
  }

  /** One input row; commit on Enter / blur, Esc restores. */
  private field(label: string, value: string, commit: (v: string) => unknown, key = label): HTMLElement {
    const row = h('div', 'row');
    row.append(h('label', '', label));
    const input = document.createElement('input');
    input.value = value;
    input.dataset.key = key;
    let done = false;
    const go = (): void => {
      if (done || input.value === value) return;
      done = true;
      commit(input.value);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') {
        input.value = value;
        input.classList.remove('dirty');
        input.blur();
      }
    };
    input.oninput = () => input.classList.toggle('dirty', input.value !== value);
    input.onblur = go;
    row.append(input);
    return row;
  }

  /** «…» next to href: pick a file, href = its path from the scene's folder. */
  private hrefButton(ref: string): HTMLElement {
    const b = h('button', 'pick', '…') as HTMLButtonElement;
    b.title = 'Pick a file';
    b.onclick = () => {
      void this.pickImage!()
        .then((file) => {
          const base = this.ed.entry?.base;
          if (file && base) this.ed.exec('node.setAttr', { node: ref, name: 'href', value: relativeTo(base, file) });
        })
        .catch((e: unknown) => this.ed.log('error', `href: ${e instanceof Error ? e.message : String(e)}`));
    };
    return b;
  }

  private attrField(ref: string, n: SceneNode, k: string): HTMLElement {
    return this.field(k, n.attrs[k] ?? '', (v) => {
      const t = v.trim();
      const value = t === '' ? null : NUMERIC.has(k) && Number.isFinite(Number(t)) ? Number(t) : t;
      return this.ed.exec('node.setAttr', { node: ref, name: k, value });
    }, `attr:${k}`);
  }

  private transform(n: SceneNode, path: string, ref: string): void {
    const ed = this.ed;
    const box = this.box;
    box.append(h('h4', '', 'transform'));
    let M;
    try {
      M = parseTransform(n.attrs.transform);
    } catch (e) {
      box.append(h('div', 'note', `transform not parsed: ${(e as Error).message}`));
      return;
    }
    const own = pivotAttr(n);
    const pivot = own ?? this.defaultPivot(path);
    const parts = decompose(M, { x: pivot[0], y: pivot[1] });
    if (!parts) {
      box.append(h('div', 'note', `${n.attrs.transform} — has skew: the parts cannot express it (the field below edits the text)`));
      box.append(this.attrField(ref, n, 'transform'));
      return;
    }
    const send = (next: TransformParts): void => {
      ed.exec('node.setTransform', transformArgs(ref, next));
    };
    const pair = (label: string, key: string, v: [number, number], set: (x: number, y: number) => void): HTMLElement => {
      const row = h('div', 'row');
      row.append(h('label', '', label));
      const p = h('span', 'pair');
      const inputs = v.map((x, i) => {
        const input = document.createElement('input');
        input.value = String(r4(x));
        input.dataset.key = `${key}:${i}`;
        input.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') go();
          if (e.key === 'Escape') {
            input.value = String(r4(x));
            input.blur();
          }
        };
        input.onblur = () => go();
        return input;
      });
      const go = (): void => {
        const a = Number(inputs[0].value);
        const b = Number(inputs[1].value);
        if (!Number.isFinite(a) || !Number.isFinite(b) || (r4(a) === r4(v[0]) && r4(b) === r4(v[1]))) return;
        set(a, b);
      };
      p.append(...inputs);
      row.append(p);
      return row;
    };
    box.append(pair('translate', 'tr', parts.translate, (x, y) => send({ ...parts, translate: [x, y] })));
    box.append(this.field('rotate°', String(r4(parts.rotate)), (v) => Number.isFinite(Number(v)) && send({ ...parts, rotate: Number(v) }), 'rot'));
    box.append(pair('scale', 'sc', parts.scale, (x, y) => send({ ...parts, scale: [x, y] })));
    // data-pivot (v0.8): written by node.setPivot keepWorld — the matrix stays, translate means another point
    const pv = pair(own ? 'pivot' : 'pivot ∘', 'pv', parts.pivot, (x, y) => ed.exec('node.setPivot', { node: ref, x: r4(x), y: r4(y) }));
    if (!own) pv.title = 'the bounds centre — not written to the file until changed (data-pivot)';
    const centre = h('button', 'link', 'centre') as HTMLButtonElement;
    centre.title = 'data-pivot = the centre of the node bounds';
    centre.onclick = () => {
      const [x, y] = this.defaultPivot(path);
      ed.exec('node.setPivot', { node: ref, x, y });
    };
    pv.append(centre);
    if (this.pickPivot) {
      const cursor = h('button', 'link', 'to cursor') as HTMLButtonElement;
      cursor.title = 'pivot to the point of the next click on the stage (like ".")';
      cursor.dataset.key = 'pv:cursor';
      cursor.onclick = () => this.pickPivot?.();
      pv.append(cursor);
    }
    if (own) {
      const off = h('button', 'link', '×') as HTMLButtonElement;
      off.title = 'remove data-pivot';
      off.onclick = () => ed.exec('node.setAttr', { node: ref, name: 'data-pivot', value: null });
      pv.append(off);
    }
    box.append(pv);
    if (n.attrs.transform) {
      const clear = h('button', 'link', 'remove transform') as HTMLButtonElement;
      clear.onclick = () => ed.exec('node.setTransform', { node: ref });
      box.append(clear);
    }
  }

  /** Default pivot: the centre of the node's bounds in its user space. */
  private defaultPivot(path: string): [number, number] {
    const ed = this.ed;
    const b = ed.bounds.get(path);
    if (!b || !ed.doc) return [0, 0];
    try {
      const c = apply(invert(nodeWorld(ed.doc.scene, path)), boxCenter(b));
      return [r4(c.x), r4(c.y)];
    } catch {
      return [0, 0];
    }
  }

  /** mix-blend-mode, data-tint, data-z, data-views — each through node.setAttr. */
  private v08(n: SceneNode, ref: string): void {
    const ed = this.ed;
    const box = this.box;
    box.append(h('h4', '', 'blending and order'));
    if (BLENDABLE.has(n.tag)) {
      const row = h('div', 'row');
      row.append(h('label', '', 'mix-blend-mode'));
      const sel = document.createElement('select');
      sel.dataset.key = 'blend';
      sel.append(new Option('— (from the parent)', ''));
      for (const m of BLEND_MODES) sel.append(new Option(m === 'plus-lighter' ? 'plus-lighter (add)' : m, m));
      let cur = '';
      try {
        cur = parseBlend(n.attrs.style) ?? '';
      } catch {
        sel.append(new Option(`style="${n.attrs.style}" (error)`, '?'));
        cur = '?';
      }
      sel.value = cur;
      sel.onchange = () => {
        if (sel.value !== '?') ed.exec('node.setAttr', { node: ref, name: 'style', value: sel.value ? `mix-blend-mode: ${sel.value}` : null });
      };
      row.append(sel);
      box.append(row);
    }
    if (TINTABLE.has(n.tag)) {
      const row = h('div', 'row');
      row.append(h('label', '', 'data-tint'));
      const color = document.createElement('input');
      color.type = 'color';
      color.dataset.key = 'tint';
      const v = n.attrs['data-tint'];
      color.value = v && /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff';
      color.onchange = () => ed.exec('node.setAttr', { node: ref, name: 'data-tint', value: color.value });
      row.append(color);
      row.append(h('span', 'muted', v ?? 'none'));
      if (v != null) {
        const off = h('button', 'link', '×') as HTMLButtonElement;
        off.title = 'remove tint';
        off.onclick = () => ed.exec('node.setAttr', { node: ref, name: 'data-tint', value: null });
        row.append(off);
      }
      box.append(row);
    }
    const z = this.field('data-z', n.attrs['data-z'] ?? '', (raw) => {
      const t = raw.trim();
      return ed.exec('node.setAttr', { node: ref, name: 'data-z', value: t === '' ? null : Number.isInteger(Number(t)) ? Number(t) : t });
    }, 'attr:data-z');
    (z.querySelector('input') as HTMLInputElement).type = 'number';
    z.title = 'order among siblings (zIndex); empty — document order';
    box.append(z);
    if (n.tag === 'image') box.append(this.views(n, ref));
  }

  /**
   * v1.0: растяжка — data-slices / data-tile (image; линии среза — на сцене), data-anchor /
   * data-stretch (узел в боксе родителя), data-size (группа-бокс), data-resizable (корень префаба).
   */
  private v10(n: SceneNode, ref: string): void {
    const box = this.box;
    box.append(h('h4', '', 'stretching and anchors'));
    const add = (k: string, title: string): void => {
      const row = this.attrField(ref, n, k);
      row.title = title;
      box.append(row);
    };
    if (n.tag === 'svg') {
      add('data-resizable', 'x | y | xy — the prefab stretches: <use width height> along these axes; the viewBox is the minimum');
      return;
    }
    if (n.tag === 'image') {
      add('data-slices', 'l t r b — 9-slice borders in PNG pixels (one number — all four; two — horizontal vertical)');
      add('data-tile', 'x | y | xy — tile instead of stretch');
    }
    add('data-anchor', 'ax ay (0..1) — where the node moves when the parent box grows past its design size');
    if (n.tag === 'image' || n.tag === 'rect' || n.tag === 'g' || n.tag === 'use') add('data-stretch', 'x | y | xy — grows with the parent box');
    if (n.tag === 'g') add('data-size', 'w h — the group becomes a box for its children anchors');
    if (n.tag === 'use') this.instanceSize(ref);
  }

  /** v1.0: размер инстанса — поля по осям data-resizable префаба (node.resize), иначе надпись. */
  private instanceSize(ref: string): void {
    const ed = this.ed;
    const info = ed.doc?.instance(ref);
    if (!info?.size) return;
    const row = h('div', 'row size');
    row.dataset.key = 'instance-size';
    row.append(h('label', '', 'size'));
    const axes = info.resizable ?? '';
    for (const [k, axis, v] of [['width', 'x', info.size.w], ['height', 'y', info.size.h]] as const) {
      const i = document.createElement('input');
      i.type = 'number';
      i.value = String(r4(v));
      i.dataset.key = `size:${k}`;
      i.disabled = !axes.includes(axis);
      i.title = i.disabled ? `the prefab does not stretch along ${axis}` : `${k} (min ${axis === 'x' ? info.min?.w : info.min?.h})`;
      i.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') i.blur();
      };
      i.onchange = () => {
        const n = Number(i.value);
        if (n > 0) ed.exec('node.resize', { node: ref, [k]: n });
      };
      row.append(i);
    }
    row.append(h('span', 'muted', axes ? `min ${info.min?.w}×${info.min?.h} · ${axes}` : 'does not stretch'));
    this.box.append(row);
  }

  /** data-views: variants name → href (a «…» picks the file), written whole by node.setAttr. */
  private views(n: SceneNode, ref: string): HTMLElement {
    const ed = this.ed;
    const wrap = h('div');
    wrap.append(h('h4', '', 'data-views (sprite variants)'));
    let list: [string, string][] = [];
    try {
      list = n.attrs['data-views'] != null ? [...parseViews(n.attrs['data-views'])] : [];
    } catch (e) {
      wrap.append(h('div', 'note', (e as Error).message));
      wrap.append(this.attrField(ref, n, 'data-views'));
      return wrap;
    }
    const write = (next: [string, string][]): void => {
      ed.exec('node.setAttr', { node: ref, name: 'data-views', value: next.length ? next.map(([k, v]) => `${k}:${v}`).join(', ') : null });
    };
    const table = document.createElement('table');
    const cell = (x: HTMLElement): HTMLElement => {
      const td = document.createElement('td');
      td.append(x);
      return td;
    };
    const input = (value: string, key: string, commit: (v: string) => void): HTMLInputElement => {
      const i = document.createElement('input');
      i.value = value;
      i.dataset.key = key;
      const go = (): void => {
        if (i.value.trim() !== value) commit(i.value.trim());
      };
      i.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
        if (e.key === 'Escape') i.value = value;
      };
      i.onblur = go;
      return i;
    };
    const pick = (onFile: (href: string) => void): HTMLElement => {
      const b = h('button', 'pick', '…') as HTMLButtonElement;
      b.title = 'Pick a file';
      b.disabled = !this.pickImage;
      b.onclick = () => {
        void this.pickImage?.().then((file) => {
          const base = ed.entry?.base;
          if (file && base) onFile(relativeTo(base, file));
        });
      };
      return b;
    };
    list.forEach(([name, href], i) => {
      const tr = document.createElement('tr');
      const set = (k: string, v: string): void => write(list.map((x, j) => (j === i ? [k, v] : x)));
      const del = h('button', 'link', '×') as HTMLButtonElement;
      del.title = 'delete the variant';
      del.onclick = () => write(list.filter((_, j) => j !== i));
      tr.append(
        cell(input(name, `vn:${i}`, (v) => v && set(v, href))),
        cell(input(href, `vh:${i}`, (v) => v && set(name, v))),
        cell(pick((f) => set(name, f))),
        cell(del),
      );
      table.append(tr);
    });
    // a new variant: name + «…» (or a typed href)
    const tr = document.createElement('tr');
    const kNew = input('', 'vn:new', () => {});
    kNew.placeholder = 'name';
    const vNew = input('', 'vh:new', () => {});
    vNew.placeholder = 'href';
    const add = (href: string): void => {
      const k = kNew.value.trim();
      if (k && href) write([...list, [k, href]]);
    };
    vNew.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') add(vNew.value.trim());
    };
    const plus = h('button', 'link', '+') as HTMLButtonElement;
    plus.onclick = () => add(vNew.value.trim());
    tr.append(cell(kNew), cell(vNew), cell(pick((f) => add(f))), cell(plus));
    table.append(tr);
    wrap.append(table);
    return wrap;
  }

  private clip(n: SceneNode, ref: string): HTMLElement {
    const ed = this.ed;
    const row = h('div', 'row');
    row.append(h('label', '', 'clip-path'));
    const sel = document.createElement('select');
    sel.dataset.key = 'clip';
    const ids: string[] = [];
    const defs = ed.doc!.scene.children.find((c) => c.tag === 'defs');
    for (const c of defs?.children ?? []) if (c.tag === 'clipPath' && c.attrs.id) ids.push(c.attrs.id);
    const cur = /#([^'")\s]+)/.exec(n.attrs['clip-path'] ?? '')?.[1] ?? '';
    sel.append(new Option('none', ''));
    for (const id of ids) sel.append(new Option(id, id));
    if (cur && !ids.includes(cur)) sel.append(new Option(`${cur} (not in defs)`, cur));
    sel.value = cur;
    sel.onchange = () => ed.exec('clip.assign', { node: ref, clip: sel.value || null });
    row.append(sel);
    return row;
  }

  private dataTable(n: SceneNode, ref: string): HTMLElement {
    const ed = this.ed;
    const wrap = h('div');
    wrap.append(h('h4', '', 'data-* (component parameters)'));
    const table = document.createElement('table');
    const keys = Object.keys(n.attrs).filter((k) => k.startsWith('data-') && !OWN_DATA.has(k));
    const input = (value: string, key: string, commit: (v: string) => void): HTMLInputElement => {
      const i = document.createElement('input');
      i.value = value;
      i.dataset.key = key;
      let done = false;
      const go = (): void => {
        if (done || i.value === value) return;
        done = true;
        commit(i.value);
      };
      i.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
        if (e.key === 'Escape') {
          i.value = value;
          i.blur();
        }
      };
      i.onblur = go;
      return i;
    };
    for (const k of keys) {
      const tr = document.createElement('tr');
      const name = k.slice(5);
      const kIn = input(name, `dk:${k}`, (v) => {
        const nk = v.trim();
        if (!nk) return;
        const calls: Call[] = [
          { name: 'node.setAttr', args: { node: ref, name: `data-${nk}`, value: n.attrs[k] } },
          { name: 'node.setAttr', args: { node: ref, name: k, value: null } },
        ];
        ed.batch(`data-${name} → data-${nk}`, calls);
      });
      const vIn = input(n.attrs[k], `dv:${k}`, (v) => ed.exec('node.setAttr', { node: ref, name: k, value: v }));
      const del = h('button', 'link', '×') as HTMLButtonElement;
      del.title = 'delete';
      del.onclick = () => ed.exec('node.setAttr', { node: ref, name: k, value: null });
      const tds = [kIn, vIn, del].map((x) => {
        const td = document.createElement('td');
        td.append(x);
        return td;
      });
      tr.append(...tds);
      table.append(tr);
    }
    // new parameter
    const tr = document.createElement('tr');
    const kNew = input('', 'dk:new', () => {});
    kNew.placeholder = 'key';
    const vNew = input('', 'dv:new', () => {});
    vNew.placeholder = 'value';
    const add = h('button', 'link', '+') as HTMLButtonElement;
    const go = (): void => {
      const k = kNew.value.trim();
      if (k) ed.exec('node.setAttr', { node: ref, name: `data-${k.replace(/^data-/, '')}`, value: vNew.value });
    };
    add.onclick = go;
    vNew.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
    };
    for (const x of [kNew, vNew, add]) {
      const td = document.createElement('td');
      td.append(x);
      tr.append(td);
    }
    table.append(tr);
    wrap.append(table);
    return wrap;
  }
}

/** data-pivot="x y" of a node, or null (absent / unreadable). */
function pivotAttr(n: SceneNode): [number, number] | null {
  const raw = n.attrs['data-pivot'];
  if (raw == null) return null;
  const p = raw.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return p.length === 2 && p.every(Number.isFinite) ? [p[0], p[1]] : null;
}
