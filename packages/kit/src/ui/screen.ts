// screen.ts — a Trempel scene (sterile base + heir + contract) mounted as one screen, laid out like
// a Unity canvas (reference size = the base's viewBox).
//
// Layout attributes on BASE nodes (plain SVG data-*, the base stays sterile — no tml:*):
//   data-anchor="ax ay"   — anchor 0..1 (x: left→right, y: top→bottom). When the canvas is larger
//                           than the reference the node moves by (extraW·ax, extraH·ay).
//   data-stretch="xy|x|y" — the node fills the canvas along that axis (backgrounds, dimmers).
//   data-fx="press"       — press feedback (ButtonFX).
//   data-sound="<name>"   — the sound plays on tap.
//   data-safe="ignore"    — an anchored node that does NOT keep out of the safe area (by
//                           default anchored nodes stay inside it: notches, the gesture bar).
// Nodes with these attributes need an id. They are read from the composed scene (2.0): a screen
// whose heir extends another scene (a collection's, `tml:extends="@ui/level.svg"`) has them from
// that base; prefab internals are the prefab's own layout (not the canvas').
//
// 2.0: prefabs. With the scene table of the kit's Vite plugin (./scene-table.ts) a screen whose
// source is in the table mounts with its path, the table's loader and the project heirs — `<use>`
// instances, collections and tml:extends chains work like in the Node tools. A stretched image
// is resized through the backend: its preserveAspectRatio (meet / slice) holds.

import { Container, Graphics, NineSliceSprite, Sprite } from 'pixi.js';
import { mount, type MountedScene, type Registry, type RendererBackend, type SceneNode } from '@trempel/scene';
import { NO_INSETS, canvas, canvasRect, insetsOf, policyOf, safeShift, type CanvasMode, type FitPolicy, type Insets, type Rect } from './layout.js';
import { scenePathOf, tableCollections, tableHeirs, tableLoader, type SceneTable } from './scene-table.js';

export interface SceneSource {
  /** Sterile base SVG source (import '...svg?raw'); omitted when the heir extends another scene (a collection's). */
  base?: string;
  /** Heir source (.tml.svg). */
  heir?: string;
  /** Contract source (.contract.xml); validated on mount. */
  contract?: string;
}

interface Anchored {
  node: Container;
  x: number;
  y: number;
  ax: number;
  ay: number;
  stretch: string | null;
  safe: boolean;
  w: number;
  h: number;
}

export interface ScreenHooks {
  press(node: Container): void;
  sound(node: Container, name: string): void;
}

export interface ScreenDeps {
  backend: RendererBackend;
  context: Record<string, unknown>;
  registry?: Registry;
  resolveHref?: (href: string) => string;
  /** Trempel collections (v1.1): name → folder URL; `@name/…` hrefs of the scene resolve into them. */
  collections?: Record<string, string>;
  hooks?: ScreenHooks;
  /** 2.0: the scene table of the kit's Vite plugin — prefabs, collections, project heirs. */
  table?: SceneTable | null;
}

export class Screen {
  /** Positioned on the column and scaled to the canvas. */
  readonly root = new Container();
  readonly scene: MountedScene;
  readonly mode: CanvasMode;
  readonly policy: FitPolicy;
  /** Reference size (viewBox of the base). */
  readonly refW: number;
  readonly refH: number;
  /** Canvas size in reference units after the last layout(). */
  w: number;
  h: number;
  /** Screen px per reference unit. */
  scale = 1;
  /** Canvas on the window after the last layout(), px. */
  rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Safe-area insets of the canvas after the last layout(), reference units. */
  safe: Insets = { ...NO_INSETS };
  private readonly anchored: Anchored[] = [];
  private readonly backend: RendererBackend;

  constructor(
    readonly name: string,
    src: SceneSource,
    mode: CanvasMode,
    deps: ScreenDeps,
  ) {
    this.mode = mode;
    this.policy = policyOf(mode);
    this.root.label = `screen:${name}`;
    const path = deps.table ? scenePathOf(deps.table, src) : null;
    const table = path ? deps.table! : null;
    this.scene = mount({
      base: src.base,
      heir: src.heir,
      contract: src.contract,
      backend: deps.backend,
      registry: deps.registry,
      context: deps.context,
      resolveHref: deps.resolveHref,
      // From the table: collections as names (the loader sees `@name/…`, the kit's resolver expands
      // images), the scene's own path, the project heirs.
      collections: table ? { ...tableCollections(table), ...namesOf(deps.collections) } : deps.collections,
      container: this.root,
      ...(table ? { loadScene: tableLoader(table), sceneUrl: path!, path: path!, heirs: tableHeirs(table, path!) } : {}),
    });
    const [, , w, h] = viewBox(this.scene.tree, name);
    this.refW = this.w = w;
    this.refH = this.h = h;
    const walk = (n: SceneNode): void => {
      const a = n.attrs;
      const id = a.id;
      if (id && (a['data-anchor'] || a['data-stretch'])) {
        const node = this.scene.byId.get(id) as Container | undefined;
        if (node) {
          const [ax, ay] = (a['data-anchor'] ?? '0 0').split(/[\s,]+/).map(Number);
          this.anchored.push({ node, x: node.x, y: node.y, ax, ay, stretch: a['data-stretch'] ?? null, safe: a['data-safe'] !== 'ignore', w: parseFloat(a.width ?? '0'), h: parseFloat(a.height ?? '0') });
        }
      }
      if (deps.hooks && id && (a['data-fx'] || a['data-sound'])) {
        const node = this.scene.byId.get(id) as Container | undefined;
        if (node && a['data-fx'] === 'press') deps.hooks.press(node);
        if (node && a['data-sound']) deps.hooks.sound(node, a['data-sound']);
      }
      // An instance's insides are laid out by its prefab (its box), not by the canvas — only the
      // scene's own nodes in its slots are the screen's.
      if (n.instance) (n.instance.slotted ?? []).forEach(walk);
      else n.children.forEach(walk);
    };
    walk(this.scene.tree);
    this.backend = deps.backend;
  }

  /** Node by id (fail loud when missing). */
  byId<T extends Container = Container>(id: string): T {
    const n = this.scene.byId.get(id);
    if (!n) throw new Error(`screen "${this.name}": node #${id} not found`);
    return n as T;
  }

  /** Component instance (tml:type) by node id. */
  component<T>(id: string): T {
    const c = this.scene.components.get(id);
    if (!c) throw new Error(`screen "${this.name}": component #${id} not found`);
    return c as T;
  }

  /**
   * Lay the canvas out on a column of the window (px). `safe` — the window's safe rect (px):
   * anchored nodes keep inside it (stretched ones fill the whole canvas regardless).
   */
  layout(col: Rect, safe?: Rect): void {
    const fit = canvas(this.mode, col.w, col.h, this.refW, this.refH);
    this.scale = fit.scale;
    this.w = fit.w;
    this.h = fit.h;
    this.root.scale.set(fit.scale);
    this.rect = canvasRect(col, fit);
    this.root.position.set(this.rect.x, this.rect.y);
    const px = safe ? insetsOf(this.rect, safe) : NO_INSETS;
    const s = (this.safe = { top: px.top / fit.scale, right: px.right / fit.scale, bottom: px.bottom / fit.scale, left: px.left / fit.scale });
    // The reference frame sits at the canvas origin; anchors move nodes by the extra canvas size.
    const ex = fit.w - this.refW;
    const ey = fit.h - this.refH;
    for (const a of this.anchored) {
      const sx = a.stretch?.includes('x');
      const sy = a.stretch?.includes('y');
      const [dx, dy] = a.safe ? safeShift(a.ax, a.ay, s) : [0, 0];
      a.node.position.set(sx ? 0 : a.x + ex * a.ax + dx, sy ? 0 : a.y + ey * a.ay + dy);
      if (sx || sy) resize(this.backend, a.node, sx ? fit.w : a.w, sy ? fit.h : a.h);
    }
  }

  /** A window rect (px) in this screen's reference units (its canvas). */
  toRef(r: Rect): Rect {
    return { x: (r.x - this.rect.x) / this.scale, y: (r.y - this.rect.y) / this.scale, w: r.w / this.scale, h: r.h / this.scale };
  }

  /** Screen px of a reference point (tests, probes). */
  toGlobal(x: number, y: number): { x: number; y: number } {
    const p = this.root.toGlobal({ x, y });
    return { x: p.x, y: p.y };
  }
}

/** The viewBox of the composed scene (a screen needs its reference size). */
function viewBox(tree: SceneNode, name: string): [number, number, number, number] {
  const v = (tree.attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n)) || !(v[2] > 0 && v[3] > 0)) throw new Error(`screen "${name}": the scene has no viewBox="0 0 W H" (the reference size of the canvas)`);
  return v as [number, number, number, number];
}

/** Collection names as names (`{ ui: '@ui' }`): with the table the kit's resolver expands the URLs. */
function namesOf(collections: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.keys(collections ?? {}).map((n) => [n, `@${n}`]));
}

/**
 * Stretch a node to w × h: an image through the backend (its box — 9-slice, and since 2.0 a picture
 * keeps its preserveAspectRatio), a graphic by scale.
 */
function resize(backend: RendererBackend, node: Container, w: number, h: number): void {
  if (node instanceof NineSliceSprite || node instanceof Sprite) {
    backend.setProp(node, 'width', w);
    backend.setProp(node, 'height', h);
  } else if (node instanceof Graphics) {
    node.scale.set(1);
    const b = node.getLocalBounds();
    if (b.width > 0 && b.height > 0) node.scale.set(w / (b.x + b.width), h / (b.y + b.height));
  }
}
