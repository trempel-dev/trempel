// prefab.ts — the editor's v0.9 prefab commands: instantiate, setParam, detach, extract.
//
// An instance in the base is one vanilla element, `<use id href x y data-*/>`; the editor never
// edits what is inside it (that is the prefab's own document). detach copies the instance's
// expanded content into the base (`<g>` with the composite ids, nested instances stay `<use>`;
// what the prefab's bindings show for static parameters is baked into the copy so it looks the
// same); extract does the reverse — a `<g>` becomes a new prefab file plus a `<use>` in its place.
// Files are not written here: a command lists them (CommandResult.files) and the host writes them
// (SceneIO.write); the document also keeps them so validation sees the new prefab at once.

import { type InstanceScope, type SceneNode } from '@trempel/scene/core';
import { compile, run } from '@trempel/scene/internal/expr';
import { paramName, rebase } from '@trempel/scene/internal/prefab';
import { parseAnchor, stretchOf } from '@trempel/scene/internal/layout';
import { parseViews } from '@trempel/scene/internal/props';
import type { Element } from '@xmldom/xmldom';
import { CommandError, type Ctx } from './ctx.js';
import { fmt } from './num.js';
import type { JSONSchema7 } from './schema.js';
import { cloneWithSource, elementChildren, serializeNode } from './xml.js';

const NODE: JSONSchema7 = { type: 'string', description: 'node id or index path from the svg root ("0/3/1"; "" — the root)' };
const ID: JSONSchema7 = { type: 'string', pattern: '^[A-Za-z_][\\w.-]*$', description: 'id (a letter or _, then letters, digits, _ . -)' };
const HREF: JSONSchema7 = { type: 'string', pattern: '\\.svg$', description: 'path of the prefab base relative to the scene (ui/button.svg)' };
const PARAM: JSONSchema7 = { type: 'string', pattern: '^(data-)?[a-z][\\w-]*$', description: 'parameter name: data-label or label' };
const obj = (properties: Record<string, JSONSchema7>, required: string[] = []): JSONSchema7 => ({ type: 'object', properties, required, additionalProperties: false });

/** data-* of a `<use>` that are presentation of the instance, not parameters. */
const PRESENTATION = new Set(['data-z', 'data-pivot', 'data-tint', 'data-anchor', 'data-stretch']);
/** Attributes of a `<g>` a `<use>` can carry. */
const PLACEMENT = new Set(['id', 'transform', 'opacity', 'display', 'visibility', 'clip-path', 'style', 'data-z', 'data-pivot', 'data-tint', 'data-anchor', 'data-stretch']);

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const attrsXml = (attrs: Record<string, string>): string =>
  Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');

function paramKey(name: string): string {
  const k = name.startsWith('data-') ? name : `data-${name}`;
  if (PRESENTATION.has(k)) throw new CommandError('E_EDITOR_PARAM', `${k} is not a parameter but the instance's presentation: node.setAttr`);
  return k;
}

function useElement(ctx: Ctx, ref: string): Element {
  const el = ctx.node(ref);
  if (el.nodeName !== 'use') throw new CommandError('E_EDITOR_NOT_INSTANCE', `${ref}: <${el.nodeName}> is not a prefab instance (<use href>)`);
  return el;
}

/** The expanded `<g>` of instance `id` in the composed scene. */
function expandedOf(ctx: Ctx, id: string): SceneNode {
  let found: SceneNode | null = null;
  const walk = (n: SceneNode): void => {
    if (found) return;
    if (n.attrs.id === id && n.instance) found = n;
    else n.children.forEach(walk);
  };
  walk(ctx.env.merged());
  if (!found) throw new CommandError('E_EDITOR_NOT_EXPANDED', `#${id}: the instance is not expanded (the prefab is missing or has errors — see doc.errors)`);
  return found;
}

/** `self` with what is known statically: plain parameters (not `=expr`), id, an empty state. */
function staticSelf(scope: InstanceScope | undefined): Record<string, unknown> | null {
  if (!scope) return null;
  const self: Record<string, unknown> = { id: scope.node.attrs.id, state: {} };
  for (const [k, v] of Object.entries(scope.params)) if (!v.startsWith('=')) self[paramName(k)] = v;
  return self;
}

/** What a binding shows for static parameters (undefined — depends on more than `self`). */
function bake(src: string | undefined, scope: InstanceScope | undefined): unknown {
  const self = staticSelf(scope);
  if (src == null || !self) return undefined;
  try {
    return run(compile(src), { self });
  } catch {
    return undefined;
  }
}

/** A composed subtree back to sterile base XML: tml dropped, static bindings baked, nested instances as `<use>`. */
function toXml(n: SceneNode, indent: string): string {
  if (n.instance) {
    const inst = n.instance;
    const attrs: Record<string, string> = { id: n.attrs.id };
    for (const [k, v] of Object.entries(inst.use)) if (k !== 'id') attrs[k] = v;
    attrs.href = inst.href;
    Object.assign(attrs, inst.own);
    return `${indent}<use${attrsXml(attrs)}/>`;
  }
  const attrs = { ...n.attrs };
  let text = n.text;
  const keyScope = (k: string): InstanceScope | undefined => (n.keyScope && k in n.keyScope ? (n.keyScope[k] ?? undefined) : n.scope);
  if (n.tag === 'text') {
    const v = bake(n.tml.bind, keyScope('bind'));
    if (v != null) text = String(v);
  } else if (n.tag === 'image') {
    const v = bake(n.tml.bind, keyScope('bind'));
    if (typeof v === 'string' && v) attrs.href = v;
    const view = bake(n.tml['bind-view'], keyScope('bind-view'));
    if (typeof view === 'string' && view && attrs['data-views']) {
      const href = parseViews(attrs['data-views']).get(view);
      if (href) attrs.href = href;
    }
  }
  const open = `${indent}<${n.tag}${attrsXml(attrs)}`;
  if (!n.children.length && text == null) return `${open}/>`;
  if (!n.children.length) return `${open}>${escText(text!)}</${n.tag}>`;
  return `${open}>\n${n.children.map((c) => toXml(c, `${indent}  `)).join('\n')}\n${indent}</${n.tag}>`;
}

const num = (v: string | undefined): number => (v == null ? 0 : Number(v) || 0);

/**
 * v1.0 detach: the instance's size baked into its content — anchored children moved by their share
 * of the extra size, stretched ones grown — and the copy becomes a box of that size (`data-size`),
 * so it looks the same and its anchors stay valid. Returns the (shallow-copied) children.
 */
function bakeLayout(g: SceneNode, attrs: Record<string, string>): SceneNode[] {
  const inst = g.instance!;
  const asks = g.children.some((c) => c.attrs['data-anchor'] != null || stretchOf(c, g, false));
  if (!asks || !inst.size || !inst.min) return g.children;
  attrs['data-size'] = `${fmt(inst.size.w)} ${fmt(inst.size.h)}`;
  const ex = inst.size.w - inst.min.w;
  const ey = inst.size.h - inst.min.h;
  return g.children.map((c) => {
    const stretch = stretchOf(c, g, false);
    let anchor: { x: number; y: number } | null = null;
    try {
      anchor = c.attrs['data-anchor'] != null ? parseAnchor(c.attrs['data-anchor']) : null;
    } catch {
      anchor = null;
    }
    if (!stretch && !anchor) return c;
    const out: SceneNode = { ...c, attrs: { ...c.attrs } };
    const use = c.instance ? (out.instance = { ...c.instance, use: { ...c.instance.use } }).use : null;
    const target = use ?? out.attrs;
    const grow = (k: 'width' | 'height', by: number): void => {
      if (!by) return;
      const base = use ? (k === 'width' ? c.instance!.size?.w : c.instance!.size?.h) : num(c.attrs[k]);
      target[k] = fmt((base ?? 0) + by);
    };
    if (stretch?.includes('x')) grow('width', ex);
    if (stretch?.includes('y')) grow('height', ey);
    const dx = !stretch?.includes('x') && anchor ? ex * anchor.x : 0;
    const dy = !stretch?.includes('y') && anchor ? ey * anchor.y : 0;
    if (dx || dy) {
      const tr = target.transform;
      if (tr == null && (use || c.tag === 'image' || c.tag === 'rect' || c.tag === 'text')) {
        if (dx) target.x = fmt(num(target.x) + dx);
        if (dy) target.y = fmt(num(target.y) + dy);
      } else target.transform = [`translate(${fmt(dx)} ${fmt(dy)})`, tr?.trim()].filter(Boolean).join(' ');
    }
    return out;
  });
}

/** `file` (relative to the scene's folder) as written in a document at `doc` (also relative to it). */
function relFrom(doc: string, file: string): string {
  if (/^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/|#|@[a-z])/.test(file)) return file; // v1.1: a collection href stays as written
  const a = rebase(doc, '_').split('/').slice(0, -1);
  const b = rebase(file, '_').split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

export const prefabCommands = {
  'prefab.instantiate': {
    describe: 'Place a prefab instance: <use id href x y data-*> in parent (default the root) at position index (default last).',
    schema: obj(
      {
        parent: NODE,
        href: HREF,
        id: ID,
        x: { type: 'number' },
        y: { type: 'number' },
        params: { type: 'object', additionalProperties: { type: 'string' }, description: 'parameters: { label: "OK" } or { "data-label": "OK" }' },
        index: { type: 'integer', minimum: 0 },
      },
      ['href', 'id'],
    ),
    run(ctx: Ctx, a: { parent?: string; href: string; id: string; x?: number; y?: number; params?: Record<string, string>; index?: number }) {
      const parent = a.parent == null ? ctx.root : ctx.node(a.parent, 'parent');
      if (parent.nodeName !== 'svg' && parent.nodeName !== 'g') throw new CommandError('E_EDITOR_TAG', `parent: an instance lives in an <svg> or a <g>, not in a <${parent.nodeName}>`);
      if (ctx.byId(a.id).length) throw new CommandError('E_EDITOR_ID_TAKEN', `id: id "${a.id}" is already in the document`);
      if (ctx.env.loadScene && !ctx.env.loadScene(a.href)) throw new CommandError('E_PREFAB_MISSING', `href: no prefab ${a.href}`);
      const el = ctx.doc.createElement('use');
      el.setAttribute('id', a.id);
      el.setAttribute('href', a.href);
      el.setAttribute('x', fmt(a.x ?? 0));
      el.setAttribute('y', fmt(a.y ?? 0));
      for (const [k, v] of Object.entries(a.params ?? {})) el.setAttribute(paramKey(k), v);
      ctx.insert(parent, el, a.index);
    },
  },

  'prefab.setParam': {
    describe: 'An instance parameter: data-<name> on the <use> (value: null — remove it, the prefab default applies).',
    schema: obj({ node: NODE, name: PARAM, value: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, ['node', 'name', 'value']),
    run(ctx: Ctx, a: { node: string; name: string; value: string | null }) {
      ctx.setAttr(useElement(ctx, a.node), paramKey(a.name), a.value);
    },
  },

  'prefab.detach': {
    describe: 'Turn an instance into a copy: a <g> with the prefab content (prefixed ids stay, nested instances stay <use>); the link to the prefab is broken, there is no way back.',
    schema: obj({ node: NODE }, ['node']),
    run(ctx: Ctx, a: { node: string }) {
      const use = useElement(ctx, a.node);
      const id = use.getAttribute('id');
      if (!id) throw new CommandError('E_USE_NO_ID', `${a.node}: the instance has no id`);
      const g = expandedOf(ctx, id);
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(g.attrs)) attrs[k] = v;
      const kids = bakeLayout(g, attrs);
      const xml = `<g${attrsXml(attrs)}>\n${kids.map((c) => toXml(c, '  ')).join('\n')}\n</g>`;
      const parent = use.parentNode as Element;
      const el = ctx.fragment(xml, parent);
      const index = elementChildren(parent).indexOf(use);
      const lead = ctx.remove(use);
      ctx.insert(parent, el, index, lead && /\n/.test(lead.data) ? lead : undefined);
      if (Object.keys(g.tml).length || g.children.some(function has(n: SceneNode): boolean {
        return Object.keys(n.tml).length > 0 || n.children.some(has);
      })) {
        ctx.warn('W_EDITOR_DETACH', `#${id}: the prefab's logic (tml of its heir) is not carried into the copy — the base is sterile; static labels are baked in`);
      }
    },
  },

  'prefab.extract': {
    describe: 'The selected <g> → a new prefab href (a base file, with params also an heir) + a <use> in its place. params: which image hrefs / texts of the children become parameters.',
    schema: obj(
      {
        node: NODE,
        href: HREF,
        params: {
          type: 'array',
          items: obj({ node: { type: 'string', description: 'child id' }, attr: { enum: ['href', 'text'] }, name: PARAM }, ['node', 'attr', 'name']),
        },
      },
      ['node', 'href'],
    ),
    run(ctx: Ctx, a: { node: string; href: string; params?: { node: string; attr: 'href' | 'text'; name: string }[] }) {
      const g = ctx.node(a.node);
      if (g.nodeName !== 'g') throw new CommandError('E_EDITOR_TAG', `${a.node}: a <g> becomes a prefab, this is a <${g.nodeName}>`);
      const id = g.getAttribute('id');
      if (!id) throw new CommandError('E_EDITOR_NO_ID', `${a.node}: the group has no id — an instance cannot be without one`);
      const file = rebase(a.href, '_');
      if (ctx.env.loadScene?.(file)) throw new CommandError('E_EDITOR_FILE_EXISTS', `href: ${a.href} already exists — choose another name`);
      const stem = file.replace(/\.svg$/, '');
      const prefix = `${id}/`;

      // The prefab's base: the group's children; ids lose the instance prefix, hrefs move to the new file.
      const copy = cloneWithSource(g, ctx.doc) as Element;
      const inner = new Set<string>();
      const all = (el: Element): Element[] => [el, ...elementChildren(el).flatMap(all)];
      for (const el of all(copy).slice(1)) {
        const cid = el.getAttribute('id');
        if (cid) {
          const local = cid.startsWith(prefix) ? cid.slice(prefix.length) : cid;
          if (!cid.startsWith(prefix)) ctx.warn('W_EDITOR_EXTRACT', `#${cid} becomes #${id}/${cid} — fix the references to it in the scene's heir and contract`);
          el.setAttribute('id', local);
          inner.add(local);
        }
      }
      for (const el of all(copy).slice(1)) {
        for (const k of ['href']) {
          const h = el.getAttribute(k);
          if (h != null && (el.nodeName === 'image' || el.nodeName === 'use')) el.setAttribute(k, relFrom(file, h));
        }
        const views = el.getAttribute('data-views');
        if (views) {
          el.setAttribute(
            'data-views',
            views
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p) => `${p.slice(0, p.indexOf(':') + 1)}${relFrom(file, p.slice(p.indexOf(':') + 1).trim())}`)
              .join(', '),
          );
        }
        const cp = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(el.getAttribute('clip-path')?.trim() ?? '');
        if (cp) {
          const local = cp[1].startsWith(prefix) ? cp[1].slice(prefix.length) : cp[1];
          if (inner.has(local)) el.setAttribute('clip-path', `url(#${local})`);
          else ctx.warn('W_EDITOR_EXTRACT', `clip-path #${cp[1]} is outside the group — it did not go into the prefab`);
        }
      }

      // Parameters: defaults on the prefab root, bindings in its heir, current values on the instance.
      const rootData: Record<string, string> = {};
      const own: Record<string, string> = {};
      const refs: string[] = [];
      for (const p of a.params ?? []) {
        const key = paramKey(p.name);
        const local = p.node.startsWith(prefix) ? p.node.slice(prefix.length) : p.node;
        const el = all(copy).find((e) => e.getAttribute('id') === local);
        if (!el) throw new CommandError('E_EDITOR_PARAM', `params: #${p.node} is not a child of #${id}`);
        if (p.attr === 'href' && el.nodeName !== 'image') throw new CommandError('E_EDITOR_PARAM', `params: #${p.node} — href is taken from an <image>, this is a <${el.nodeName}>`);
        if (p.attr === 'text' && el.nodeName !== 'text') throw new CommandError('E_EDITOR_PARAM', `params: #${p.node} — text is taken from a <text>, this is a <${el.nodeName}>`);
        const value = p.attr === 'href' ? el.getAttribute('href') ?? '' : el.textContent ?? '';
        rootData[key] = value;
        own[key] = p.attr === 'href' ? rebase(value, file) : value;
        refs.push(`  <tml:ref id="${esc(local)}" tml:bind="self.${paramName(key)}"/>`);
      }

      const NS = 'xmlns="http://www.w3.org/2000/svg"';
      const extra: Record<string, string> = {};
      for (let i = 0; i < g.attributes.length; i++) {
        const at = g.attributes[i];
        if (!PLACEMENT.has(at.name)) extra[at.name] = at.value;
      }
      const body = elementChildren(copy)
        .map((c) => `  ${serializeNode(c)}`)
        .join('\n');
      const wrapped = Object.keys(extra).length ? `  <g${attrsXml(extra)}>\n${body.replace(/^/gm, '  ')}\n  </g>` : body;
      ctx.env.files.push({ path: file, text: `<svg ${NS}${attrsXml(rootData)}>\n${wrapped}\n</svg>\n` });
      if (refs.length) {
        const name = file.slice(file.lastIndexOf('/') + 1);
        ctx.env.files.push({
          path: `${stem}.tml.svg`,
          text: `<svg ${NS} xmlns:tml="https://trempel.dev/ns/scene" tml:extends="${esc(name)}">\n${refs.join('\n')}\n</svg>\n`,
        });
      }

      // The group → an instance with the same placement.
      const use = ctx.doc.createElement('use');
      use.setAttribute('id', id);
      use.setAttribute('href', a.href);
      for (let i = 0; i < g.attributes.length; i++) {
        const at = g.attributes[i];
        if (PLACEMENT.has(at.name) && at.name !== 'id') use.setAttribute(at.name, at.value);
      }
      for (const [k, v] of Object.entries(own)) use.setAttribute(k, v);
      const parent = g.parentNode as Element;
      const index = elementChildren(parent).indexOf(g);
      const lead = ctx.remove(g);
      ctx.insert(parent, use, index, lead && /\n/.test(lead.data) ? lead : undefined);
    },
  },
};
