// inspectors.ts — 2.3: inspector panels a consumer brings in its trempel.view.ts (`inspectors`):
// a panel for the nodes of a `tml:type` (the kit's particle editor for `fx`), its palette, and its
// agent API (`tml.inspect[type]`). The editor stays ignorant of what the panel edits: it hands over
// the node, its component, the core commands, the folder's files and the page's widgets.
//
// The node inspected: the one selected node of the base, or (a heir insert has no base path) a node
// picked in the layers tree by its id (Editor.inspected).

import { coded, type SceneNode } from '../../src/core.js';
import type { InspectorFactory, InspectorHost, InspectorPanel, ViewConfig } from '../../src/view.js';
import type { SceneIO } from '../io';
import type { Editor } from './editor';
import { widgets } from './widgets';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Spec = Exclude<InspectorFactory, (host: InspectorHost) => InspectorPanel>;

const specOf = (f: InspectorFactory): Spec => (typeof f === 'function' ? { panel: f } : f);

/** A node of the composed tree by id. */
export function mergedNode(tree: SceneNode | null | undefined, id: string): SceneNode | null {
  if (!tree) return null;
  if (tree.attrs.id === id) return tree;
  for (const c of tree.children) {
    const hit = mergedNode(c, id);
    if (hit) return hit;
  }
  return null;
}

export class Inspectors {
  private readonly specs: Record<string, Spec>;
  private shown: { key: string; panel: InspectorPanel } | null = null;
  private palettes: InspectorPanel[] = [];
  /** tml.inspect: the inspectors' agent APIs by type. */
  readonly api: Record<string, Record<string, unknown>> = {};

  constructor(
    private readonly ed: Editor,
    private readonly io: SceneIO,
    config: ViewConfig,
    private readonly pane: { box: HTMLElement; title: HTMLElement; section: HTMLElement },
    private readonly palette: { box: HTMLElement; section: HTMLElement },
  ) {
    this.specs = Object.fromEntries(Object.entries(config.inspectors ?? {}).map(([k, v]) => [k, specOf(v)]));
    for (const [type, spec] of Object.entries(this.specs)) {
      if (!spec.api) continue;
      try {
        this.api[type] = spec.api(this.host(null));
      } catch (e) {
        ed.log('error', coded('E_VIEW_MODULE', `inspectors.${type}.api(): ${msg(e)}`));
      }
    }
    for (const e of ['render', 'selection'] as const) ed.on(e, () => this.draw());
    this.mountPalettes();
  }

  /** The id and the composed node inspected now (null — none). */
  target(): { id: string; node: SceneNode; inserted: boolean } | null {
    const ed = this.ed;
    const tree = ed.session?.tree ?? ed.display;
    let id: string | undefined;
    let inserted = false;
    if (ed.inspected) {
      id = ed.inspected;
      inserted = true;
    } else if (ed.selection.length === 1) id = ed.node(ed.selection[0])?.attrs.id;
    if (!id) return null;
    const node = mergedNode(tree, id);
    return node ? { id, node, inserted } : null;
  }

  host(t: { id: string; node: SceneNode; inserted: boolean } | null): InspectorHost {
    const ed = this.ed;
    return {
      node: t ? { id: t.id, tag: t.node.tag, attrs: { ...t.node.attrs }, tml: { ...(t.node.tml ?? {}) }, inserted: t.inserted } : null,
      scene: () => ed.session?.scene ?? null,
      component: () => (t ? (ed.session?.scene?.components.get(t.id) ?? null) : null),
      exec: (name, args) => ed.exec(name, args),
      files: {
        list: async (dir = '') => (await this.io.list(dir)).files,
        read: (p) => this.io.read(p),
        write: async (p, text) => {
          await this.io.write(p, text);
          ed.log('info', `saved: ${p}`);
        },
      },
      ui: widgets,
      log: (level, text) => ed.log(level, text),
      refresh: () => this.draw(true),
    };
  }

  draw(force = false): void {
    const t = this.target();
    const type = t?.node.tml?.type;
    const spec = type ? this.specs[type] : undefined;
    const key = t && spec ? `${type}:${t.id}:${JSON.stringify(t.node.attrs)}:${JSON.stringify(t.node.tml)}` : '';
    if (!force && this.shown?.key === key) return;
    this.shown?.panel.dispose();
    this.shown = null;
    this.pane.box.replaceChildren();
    this.pane.section.hidden = !spec;
    if (!t || !spec || !type) return;
    this.pane.title.textContent = `${type} · #${t.id}`;
    try {
      const panel = spec.panel(this.host(t));
      this.pane.box.append(panel.el);
      this.shown = { key, panel };
    } catch (e) {
      this.ed.log('error', coded('E_VIEW_MODULE', `inspectors.${type}: ${msg(e)}`));
    }
  }

  private mountPalettes(): void {
    for (const p of this.palettes) p.dispose();
    this.palettes = [];
    this.palette.box.replaceChildren();
    for (const [type, spec] of Object.entries(this.specs)) {
      if (!spec.palette) continue;
      try {
        const p = spec.palette(this.host(null));
        this.palette.box.append(p.el);
        this.palettes.push(p);
      } catch (e) {
        this.ed.log('error', coded('E_VIEW_MODULE', `inspectors.${type}.palette(): ${msg(e)}`));
      }
    }
    this.palette.section.hidden = !this.palettes.length;
  }
}
