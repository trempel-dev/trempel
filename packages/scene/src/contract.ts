// contract.ts — parse scene.contract.xml and validate a base against it.
//
// The contract is one file with three roles: a brief (what the mock must contain), a
// deterministic validator (does the base still satisfy the logic's expectations?), and
// documentation (an enumerable list of what the logic needs from the view). It describes
// STRUCTURE only — topology, node types, invariants — never appearance.
//
// Checks (spec §Контракт, v0.5):
//   1. each contract node exists in the base exactly once, tag matches,
//   2. empty="true" ⇒ the node has no children,
//   3. the base viewBox matches the contract viewBox,
//   4. all base ids are unique,
//   5. the base is sterile (zero tml:*).
// v0.6 parameterisation:
//   - viewBox rule: fixed "0 0 W H" | "any" | a list "0 0 W H | 0 0 W2 H2" | aspect="9:16"
//     (+ tolerance="3%") — only the proportion;
//   - pattern nodes: <image match="o(\d+)" count="1..60" in="scene" requires="_o$1"/> — every
//     base node whose id fully matches the regex, how many there may be, where they must live,
//     which partner id each one needs ($1… = the match's groups).
// v0.7: attrs="data-cols data-rows" on a node or a pattern — those attributes must be present in the
// base (component parameters live there); their values are not checked.
// v0.9: <use id="btn" href="ui/button.svg"/> — the node must be an instance of that prefab (checked
// against the expanded tree: the <g> remembers its href); ids inside instances are composite
// (`btn/label`); `params="data-a data-b"` on the root — a prefab's required parameters: its base
// root carries defaults for them, every instance must set them (prefab.ts). Prefab content is not
// the scene's own — sterility is asked of the scene's nodes only.
// v0.9.1: nesting — a node or a pattern written inside a contract node must lie inside it in the base
// (`<g id="diffs"><ellipse match="d\d+" count="1.."/></g>` = the pattern with in="diffs").
// v1.0: `anchor="ax ay"` on a node — the base node's data-anchor is present and equal; `slices="true"`
// on an <image> — it carries data-slices; `resizable="x|y|xy"` on the root — the base root's
// data-resizable; `slot="true"` on a <g> — the group is a slot (tml:slot, checked after the heir —
// slotContractErrors). A resizable prefab without a stretching background is the format's error
// (layout.ts), contract or not.
// Wording is for a human ("#board должен быть пустым — в нём 3 узла"), not a parser.

import { DOMParser } from '@xmldom/xmldom';
import type { SceneNode } from './parser.js';
import { resolveHref } from './href.js';
import { baseDuplicateIdErrors, baseTmlErrors, collectIds, findById } from './tree.js';

/** One expectation line from the contract. */
export interface ContractNode {
  tag: string;
  id: string;
  /** true ⇒ the node must have no children (a component owns its subtree). */
  empty: boolean;
  /** v0.7: attribute names the base node must carry (values unchecked). */
  attrs?: string[];
  /** v0.9: `<use href>` — the node must be an instance of this prefab. */
  href?: string;
  /** v0.9.1: written inside the contract node with this id — must be its descendant in the base. */
  in?: string;
  /** v1.0: `anchor="ax ay"` — the base node carries data-anchor with these values. */
  anchor?: [number, number];
  /** v1.0: `slices="true"` — the base <image> is a 9-slice (data-slices). */
  slices?: boolean;
  /** v1.0: `slot="true"` — the group is a slot of the prefab (tml:slot in its heir). */
  slot?: boolean;
}

/** "Nodes whose id matches a pattern" — a family of nodes (o1..oN) rather than one id. */
export interface ContractPattern {
  tag: string;
  /** The regex source as written (matched against the whole id). */
  match: string;
  /** Allowed number of matching nodes, inclusive; max = Infinity when open-ended. */
  min: number;
  max: number;
  /** Matching nodes must be descendants of the node with this id. */
  in?: string;
  /** Partner-id template ($1, $2… = capture groups) that must exist in the base for each match. */
  requires?: string;
  empty: boolean;
  /** v0.7: attribute names every matching node must carry. */
  attrs?: string[];
}

/** How the base viewBox is constrained. */
export type ViewBoxRule =
  | { kind: 'none' }
  | { kind: 'any' }
  | { kind: 'oneOf'; values: string[] }
  | { kind: 'aspect'; ratio: number; label: string; tolerance: number };

export interface Contract {
  /** The contract's viewBox attribute as written, or null if the contract omits it. */
  viewBox: string | null;
  /** The parsed viewBox constraint (v0.6). */
  viewBoxRule: ViewBoxRule;
  nodes: ContractNode[];
  /** Pattern families (v0.6). */
  patterns: ContractPattern[];
  /** v0.9: required parameters of a prefab (`params` on the root), with `data-`. */
  params?: string[];
  /** v1.0: `resizable="x|y|xy"` on the root — the base root carries data-resizable with these axes. */
  resizable?: 'x' | 'y' | 'xy';
}

const ELEMENT_NODE = 1;

type XmlEl = {
  nodeName: string;
  attributes: ArrayLike<{ name?: string; nodeName?: string; value: string }>;
  childNodes: ArrayLike<{ nodeType: number; nodeName: string }>;
};

const attr = (el: XmlEl, name: string): string | null => {
  const a = el.attributes;
  for (let i = 0; i < a.length; i++) {
    const n = a[i].name ?? a[i].nodeName ?? '';
    if (n === name) return a[i].value;
  }
  return null;
};

const fail = (msg: string): never => {
  throw new Error(`Trempel contract error: ${msg}`);
};

/** "N", "N..M", "N..", "..M" → [min, max]. */
function parseCount(raw: string | null, where: string): [number, number] {
  if (raw == null) return [1, Infinity];
  const m = /^\s*(\d*)\s*(\.\.)?\s*(\d*)\s*$/.exec(raw);
  if (!m || (!m[1] && !m[3])) return fail(`${where}: count="${raw}" — ожидается "N", "N..M", "N.." или "..M".`);
  if (!m[2]) return [Number(m[1]), Number(m[1])];
  const min = m[1] ? Number(m[1]) : 0;
  const max = m[3] ? Number(m[3]) : Infinity;
  if (min > max) fail(`${where}: count="${raw}" — минимум больше максимума.`);
  return [min, max];
}

function parseViewBoxRule(root: XmlEl): ViewBoxRule {
  const vb = attr(root, 'viewBox');
  const aspect = attr(root, 'aspect');
  if (aspect != null) {
    if (vb != null) fail('у <contract> либо viewBox, либо aspect — не оба.');
    const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(aspect);
    if (!m || !Number(m[2])) return fail(`aspect="${aspect}" — ожидается "W:H", например "9:16".`);
    const tolRaw = attr(root, 'tolerance') ?? '0';
    const t = /^\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(tolRaw);
    if (!t) return fail(`tolerance="${tolRaw}" — ожидается число или процент, например "3%".`);
    const tolerance = t[2] ? Number(t[1]) / 100 : Number(t[1]);
    return { kind: 'aspect', ratio: Number(m[1]) / Number(m[2]), label: aspect.trim(), tolerance };
  }
  if (vb == null) return { kind: 'none' };
  if (vb.trim() === 'any' || vb.trim() === '*') return { kind: 'any' };
  const values = vb.split('|').map(normVB);
  for (const v of values) {
    if (parseVB(v) == null) fail(`viewBox="${vb}": "${v}" — ожидается "minX minY ширина высота".`);
  }
  return { kind: 'oneOf', values };
}

/** Parse scene.contract.xml into a {@link Contract}. @throws on malformed structure. */
export function parseContract(xml: string): Contract {
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') errors.push(message);
    },
  });
  const doc = parser.parseFromString(xml, 'text/xml');
  if (errors.length) {
    throw new Error(`Trempel contract error: malformed XML — ${errors.join('; ')}`);
  }

  const root = doc.documentElement as unknown as XmlEl | null;
  if (!root || root.nodeName !== 'contract') {
    throw new Error(`Trempel contract error: root element must be <contract>`);
  }

  const viewBoxRule = parseViewBoxRule(root);
  const nodes: ContractNode[] = [];
  const patterns: ContractPattern[] = [];
  const visit = (parent: XmlEl, parentId: string | undefined): void => {
    const children = parent.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType !== ELEMENT_NODE) continue;
      const el = child as unknown as XmlEl;
      const tag = child.nodeName;
      const id = attr(el, 'id');
      const match = attr(el, 'match');
      const empty = attr(el, 'empty') === 'true';
      const attrsRaw = attr(el, 'attrs');
      const attrs = attrsRaw != null ? attrsRaw.split(/[\s,]+/).filter(Boolean) : undefined;
      const hasChildren = Array.from(el.childNodes).some((c) => c.nodeType === ELEMENT_NODE);
      if (id && match) fail(`<${tag} id="${id}">: id и match вместе не бывают — либо узел, либо шаблон.`);
      if (match) {
        try {
          new RegExp(`^(?:${match})$`);
        } catch {
          fail(`<${tag} match="${match}">: это не регулярное выражение.`);
        }
        if (hasChildren) fail(`<${tag} match="${match}">: внутри шаблона узлов не бывает.`);
        const [min, max] = parseCount(attr(el, 'count'), `<${tag} match="${match}">`);
        const p: ContractPattern = { tag, match, min, max, empty };
        const inId = attr(el, 'in') ?? parentId;
        const requires = attr(el, 'requires');
        if (inId) p.in = inId;
        if (requires) p.requires = requires;
        if (attrs?.length) p.attrs = attrs;
        patterns.push(p);
        continue;
      }
      if (!id) {
        throw new Error(`Trempel contract error: <${tag}> is missing an id (или match для шаблона)`);
      }
      const node: ContractNode = attrs?.length ? { tag, id, empty, attrs } : { tag, id, empty };
      if (tag === 'use') {
        const href = attr(el, 'href');
        if (!href) fail(`<use id="${id}">: нет href — какой префаб ждём.`);
        node.href = href!;
      }
      if (parentId) node.in = parentId;
      const anchor = attr(el, 'anchor');
      if (anchor != null) {
        const p = anchor.trim().split(/[\s,]+/).map(Number);
        if (p.length !== 2 || !p.every(Number.isFinite)) fail(`<${tag} id="${id}" anchor="${anchor}">: ожидается «ax ay».`);
        node.anchor = [p[0], p[1]];
      }
      if (attr(el, 'slices') === 'true') {
        if (tag !== 'image') fail(`<${tag} id="${id}" slices="true">: 9-slice бывает только у <image>.`);
        node.slices = true;
      }
      if (attr(el, 'slot') === 'true') {
        if (tag !== 'g') fail(`<${tag} id="${id}" slot="true">: слот это группа <g>.`);
        node.slot = true;
      }
      nodes.push(node);
      if (hasChildren) {
        if (empty) fail(`<${tag} id="${id}" empty="true">: пустой узел, а внутри него в контракте узлы.`);
        visit(el, id);
      }
    }
  };
  visit(root, undefined);

  const out: Contract = { viewBox: attr(root, 'viewBox'), viewBoxRule, nodes, patterns };
  const params = attr(root, 'params');
  if (params != null) {
    out.params = params.split(/[\s,]+/).filter(Boolean);
    for (const p of out.params) if (!/^data-[\w-]+$/.test(p)) fail(`params="${params}": «${p}» — параметр это data-*.`);
  }
  const resizable = attr(root, 'resizable');
  if (resizable != null) {
    const v = resizable.trim() === 'yx' ? 'xy' : resizable.trim();
    if (v !== 'x' && v !== 'y' && v !== 'xy') fail(`resizable="${resizable}" — бывает x, y или xy.`);
    out.resizable = v as 'x' | 'y' | 'xy';
  }
  return out;
}

const normVB = (s: string | null | undefined): string => (s ?? '').trim().replace(/[\s,]+/g, ' ');

function parseVB(s: string): [number, number, number, number] | null {
  const parts = normVB(s).split(' ').map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? (parts as [number, number, number, number]) : null;
}

/** Violations of the viewBox rule, phrased for a human. */
function viewBoxErrors(base: SceneNode, rule: ViewBoxRule): string[] {
  const actual = base.attrs.viewBox;
  if (rule.kind === 'none') return [];
  if (actual == null || parseVB(actual) == null) {
    return [`У базы нет корректного viewBox ("${actual ?? '(нет)'}"), а контракт его требует.`];
  }
  if (rule.kind === 'any') return [];
  if (rule.kind === 'oneOf') {
    if (rule.values.includes(normVB(actual))) return [];
    return rule.values.length === 1
      ? [`viewBox базы "${actual}" не совпадает с контрактным "${rule.values[0]}".`]
      : [`viewBox базы "${actual}" не из разрешённых: ${rule.values.map((v) => `"${v}"`).join(', ')}.`];
  }
  const [, , w, h] = parseVB(actual)!;
  const ratio = w / h;
  if (h > 0 && Math.abs(ratio / rule.ratio - 1) <= rule.tolerance + 1e-9) return [];
  const pct = rule.tolerance ? ` (допуск ${+(rule.tolerance * 100).toFixed(2)}%)` : '';
  return [
    `viewBox базы "${actual}" — пропорция ${w}:${h} ≈ ${ratio.toFixed(4)}, а контракт ждёт ${rule.label} ≈ ${rule.ratio.toFixed(4)}${pct}.`,
  ];
}

/** Attributes a contract line expects that the base node lacks. */
const missingAttrs = (node: SceneNode, want: string[] | undefined): string[] =>
  (want ?? []).filter((a) => node.attrs[a] === undefined);

const attrError = (id: string, a: string): string => `#${id}: нет ${a} — его ждёт контракт.`;

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

const countText = (min: number, max: number): string =>
  min === max ? `ровно ${min}` : max === Infinity ? `не меньше ${min}` : min === 0 ? `не больше ${max}` : `от ${min} до ${max}`;

/** Violations of one pattern family. */
function patternErrors(base: SceneNode, p: ContractPattern): string[] {
  const errors: string[] = [];
  const re = new RegExp(`^(?:${p.match})$`);
  const all = collectIds(base);
  const ids = new Set(all.map((e) => e.id));

  let scope: SceneNode | null = base;
  if (p.in) {
    const hosts = findById(base, p.in);
    if (hosts.length === 0) {
      return [`Шаблон ${p.match}: контейнер #${p.in}, в котором должны лежать узлы, в базе не найден.`];
    }
    scope = hosts[0];
  }
  const inside = new Set(collectIds(scope).map((e) => e.node));

  const matched: { id: string; node: SceneNode; groups: string[] }[] = [];
  for (const { id, node } of all) {
    const m = re.exec(id);
    if (!m) continue;
    if (!inside.has(node)) {
      errors.push(`#${id}: узлы по шаблону ${p.match} должны лежать внутри #${p.in}, а этот — снаружи.`);
      continue;
    }
    matched.push({ id, node, groups: m.slice(1) });
  }

  const n = matched.length;
  if (n < p.min || n > p.max) {
    errors.push(
      `Узлов по шаблону ${p.match}${p.in ? ` в #${p.in}` : ''} — ${n}, а контракт ждёт ${countText(p.min, p.max)}.`,
    );
  }

  for (const { id, node, groups } of matched) {
    if (node.tag !== p.tag) {
      errors.push(`#${id}: по шаблону ${p.match} ожидается <${p.tag}>, а в базе <${node.tag}>.`);
    }
    if (p.empty && node.children.length) {
      const k = node.children.length;
      errors.push(`#${id} должен быть пустым — в нём ${k} ${plural(k, 'дочерний узел', 'дочерних узла', 'дочерних узлов')}.`);
    }
    for (const a of missingAttrs(node, p.attrs)) errors.push(attrError(id, a));
    if (p.requires) {
      const partner = p.requires.replace(/\$(\d)/g, (_, d: string) => groups[Number(d) - 1] ?? '');
      if (!ids.has(partner)) {
        errors.push(`#${id}: к нему нужен парный узел #${partner} (requires="${p.requires}") — в базе его нет.`);
      }
    }
  }
  return errors;
}

/** Same prefab file? Hrefs compared as normalized paths (v1.1: resolved — `@skin/x.svg` and its plain path match). */
function sameHref(a: string, b: string, resolve?: (href: string) => string): boolean {
  const norm = (h: string): string => {
    const n = resolveHref(h, '_');
    if (!resolve) return n;
    try {
      return resolve(n);
    } catch {
      return n; // an unknown collection is reported where the prefab loads
    }
  };
  return norm(a) === norm(b);
}

export interface CheckContractOptions {
  /** Ask the base to be sterile (default true; false for an inherited base — tml:extends chain). */
  sterile?: boolean;
  /**
   * v1.1: the scene's href → the file it means (collections expanded): instance hrefs are compared
   * by it, so `@skin/panel.svg` and the same file by its relative path are one prefab.
   */
  resolveHref?: (href: string) => string;
}

/** Validate a base tree against a contract, collecting every violation. */
export function checkContract(base: SceneNode, contract: Contract, opts: CheckContractOptions = {}): string[] {
  const errors: string[] = [];

  // 3. viewBox rule — heir inserts use absolute coordinates, so the frame must be known.
  // (Contracts built by hand without viewBoxRule — v0.5 object shape — fall back to the raw string.)
  const rule: ViewBoxRule =
    contract.viewBoxRule ??
    (contract.viewBox != null ? { kind: 'oneOf', values: [normVB(contract.viewBox)] } : { kind: 'none' });
  errors.push(...viewBoxErrors(base, rule));

  // 1 + 2. Per-node existence, tag, emptiness.
  for (const cn of contract.nodes) {
    const matches = findById(base, cn.id);
    if (matches.length === 0) {
      errors.push(`#${cn.id}: контракт требует <${cn.tag} id="${cn.id}">, но такого узла в базе нет.`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`#${cn.id}: узел встречается ${matches.length} раз — id должен быть уникален.`);
      continue;
    }
    const node = matches[0];
    if (cn.tag === 'use') {
      const href = node.instance?.href ?? (node.tag === 'use' ? node.attrs.href : undefined);
      if (href == null) errors.push(`#${cn.id}: контракт ждёт инстанс <use href="${cn.href}">, а в базе <${node.tag}>.`);
      else if (!sameHref(href, cn.href!, opts.resolveHref)) errors.push(`#${cn.id}: ждали ${cn.href}, а это ${href}.`);
    } else if (node.tag !== cn.tag) {
      errors.push(`#${cn.id}: контракт ждёт <${cn.tag}>, а в базе <${node.tag}>.`);
    }
    if (cn.empty && node.children.length) {
      errors.push(
        `#${cn.id} должен быть пустым — в нём ${node.children.length} ` +
          `дочерн${node.children.length === 1 ? 'ий узел' : 'их узла(ов)'}; компонент их перезапишет.`,
      );
    }
    for (const a of missingAttrs(node, cn.attrs)) errors.push(attrError(cn.id, a));
    if (cn.anchor) {
      const raw = node.attrs['data-anchor'];
      const got = raw?.trim().split(/[\s,]+/).map(Number);
      if (raw == null) errors.push(`#${cn.id}: нет data-anchor — контракт ждёт якорь «${cn.anchor.join(' ')}».`);
      else if (!got || got.length !== 2 || Math.abs(got[0] - cn.anchor[0]) > 1e-9 || Math.abs(got[1] - cn.anchor[1]) > 1e-9) {
        errors.push(`#${cn.id}: data-anchor="${raw}", а контракт ждёт «${cn.anchor.join(' ')}».`);
      }
    }
    if (cn.slices && node.attrs['data-slices'] == null) {
      errors.push(`#${cn.id}: нет data-slices — контракт ждёт растягиваемую картинку (9-slice).`);
    }
    if (cn.in) {
      const host = findById(base, cn.in);
      if (host.length === 1 && host[0] !== node && !collectIds(host[0]).some((e) => e.node === node)) {
        errors.push(`#${cn.id}: по контракту лежит внутри #${cn.in}, а в базе — снаружи.`);
      }
    }
  }

  // Pattern families (v0.6).
  for (const p of contract.patterns ?? []) errors.push(...patternErrors(base, p));

  // v0.9: a prefab's required parameters have defaults on its root.
  for (const p of contract.params ?? []) {
    if (base.attrs[p] === undefined) errors.push(`корень <svg>: нет ${p} — параметр префаба (params), дайте значение по умолчанию.`);
  }

  // v1.0: a resizable prefab.
  if (contract.resizable) {
    const raw = base.attrs['data-resizable'];
    const got = raw?.trim() === 'yx' ? 'xy' : raw?.trim();
    if (raw == null) errors.push(`корень <svg>: нет data-resizable — контракт ждёт растягиваемый префаб (${contract.resizable}).`);
    else if (got !== contract.resizable) errors.push(`корень <svg>: data-resizable="${raw}", а контракт ждёт «${contract.resizable}».`);
  }

  // 4. All base ids unique. 5. Base sterile. (Shared wording with merge → dedup at mount.)
  errors.push(...baseDuplicateIdErrors(base));
  if (opts.sterile !== false) errors.push(...baseTmlErrors(base));

  return errors;
}

/**
 * v1.0: `slot="true"` lines — checked on the tree after the heir (a slot is behaviour: the heir marks
 * the base's empty group with tml:slot).
 */
export function slotContractErrors(tree: SceneNode, contract: Contract): string[] {
  const errors: string[] = [];
  for (const cn of contract.nodes) {
    if (!cn.slot) continue;
    const found = findById(tree, cn.id);
    if (found.length !== 1) continue; // existence is the base check's
    if (found[0].tml.slot === undefined) errors.push(`#${cn.id}: контракт ждёт слот — пометьте группу в наследнике: <tml:ref id="${cn.id}" tml:slot="${cn.id}"/>.`);
  }
  return errors;
}
