// transitions.ts — transitions by snapshots (2.1): the kit renders the screen leaving and the screen
// arriving into textures, hides the live screens while the transition plays with them, frees the
// textures after. game.screens.show(name, { transition }) uses it for a leaf or a function
// transition; a page turn inside one screen (turn()) and turning a page with a finger (drag()) use the
// same leaf.
//
//   'fade' (default) — the live cross-fade of Screens; 'none' — instant; { fade: s } — a fade of s;
//   { leaf: { dir, look, duration, back } } — the page leaf (fx/page-leaf.ts): dir +1 (forward) — the
//     snapshot of the leaving screen is the leaf, it turns right → left over the arriving one; dir −1
//     — the arriving screen comes back as the leaf over the leaving one (the phase runs from the
//     early finish to 0);
//   a function (ctx) => Promise — any transition over the two snapshots (the extension point).
//
// Snapshots: the root is rendered with its world matrix as it sits on the stage, shifted by the
// column's corner (rake №1: Pixi's `transform` replaces the root's world matrix — the parent's
// part must be in it; on a desktop the column is narrower than the window). Input is blocked while a
// transition runs (a blocker over the screens + game.input off). Without WebGL2 (or when the leaf's
// shader does not build, or `fallback` is set) a leaf is a cross-fade of the same snapshots.

import { Container, Graphics, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import { LEAF_LOOKS, PageLeaf, type LeafLook, type LeafLookName } from '../fx/page-leaf.js';
import type { Rect } from './layout.js';

/** A leaf transition / page turn. */
export interface LeafOptions {
  /** +1 — forward (the leaf goes right → left; default), −1 — back. */
  dir?: 1 | -1;
  /** 'hard' (a cover, no bend), 'soft' (a page; default) or { bend, twist }. */
  look?: LeafLookName | LeafLook;
  /** Seconds of a full turn (default: hard 0.95, soft 0.75); a shorter run takes its share. */
  duration?: number;
  /** The back of the leaf: a texture or a colour (default: paper). */
  back?: Texture | number;
}

/** What a function transition gets: the two snapshots and a layer over the hidden screens. */
export interface TransitionContext {
  /** The screen leaving / arriving, as they are on the window (w × h of the column). */
  readonly before: Texture;
  readonly after: Texture;
  /** At the column's corner, over the screens (under the popups): draw in (0..width, 0..height). */
  readonly layer: Container;
  readonly width: number;
  readonly height: number;
  readonly renderer: Renderer;
  /** Run `fn` every frame (UI channel, dt in s) until it returns true. */
  frame(fn: (dt: number) => boolean | void): Promise<void>;
  /** A sprite of a texture over the whole column. */
  sprite(texture: Texture): Sprite;
}

export type TransitionFn = (ctx: TransitionContext) => void | Promise<void>;

/** How game.screens.show switches (2.1). */
export type ScreenTransition = 'fade' | 'none' | { fade: number } | { leaf: LeafOptions } | TransitionFn;

export interface TransitionHost {
  renderer: Renderer;
  /** Per-frame callback (UI channel); returns its remover. */
  onFrame(fn: (dt: number) => void): () => void;
  /** The live screens: hidden while a transition shows the snapshots. */
  live: Container;
  /** The transition starts / ends (the game blocks its input). */
  busy?(on: boolean): void;
  /** Where drag() listens (the canvas). */
  canvas?: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>;
}

/** The page being turned by turn() / drag(): a screen (its root and its column on the window). */
export interface PageTarget {
  root: Container;
  rect: Rect;
}

export interface PageDragOptions {
  /** The screen whose page turns (a Screen fits). */
  page: PageTarget | (() => PageTarget);
  /** May a drag start now (the screen on top, nothing running)? */
  allowed(): boolean;
  /** Is there a page in that direction (+1 — the next one: the finger goes left)? */
  can(dir: 1 | -1): boolean;
  /** Switch the live page to the neighbour in `dir` (and back with −dir on a cancel). */
  change(dir: 1 | -1): void;
  look?: LeafLookName | LeafLook;
  /** Seconds of a full turn when let go (default: of the look). */
  duration?: number;
  back?: Texture | number;
  /** Horizontal px before the leaf follows the finger (default 12). */
  threshold?: number;
  /** The leaf follows the finger (the page under it is the neighbour already). */
  onStart?(dir: 1 | -1): void;
  /** Let go: the turn goes on (`committed`) or falls back. */
  onRelease?(dir: 1 | -1, committed: boolean): void;
  /** Settled (committed or not). */
  onEnd?(dir: 1 | -1, committed: boolean): void;
}

const DURATION: Record<LeafLookName, number> = { hard: 0.95, soft: 0.75 };

const cl = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeIn = (x: number) => Math.pow(x, 1.6);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 1.6);

const lookOf = (l: LeafLookName | LeafLook | undefined): LeafLook => (typeof l === 'object' ? l : LEAF_LOOKS[l ?? 'soft']);
const durationOf = (o: { look?: LeafLookName | LeafLook; duration?: number }): number =>
  o.duration ?? (typeof o.look === 'object' ? (o.look.bend === 0 ? DURATION.hard : DURATION.soft) : DURATION[o.look ?? 'soft']);

/** The leaf is possible here: WebGL2 (the kit's minimum). */
export function leafSupported(r: Renderer): boolean {
  const gl = (r as { gl?: unknown }).gl;
  return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
}

/** The phase run of a turn: from → to clamped to the early finish; `dur` s of a full turn. */
export function phaseRun(from: number, to: number, dur: number, gone: number, speed = 1): { a: number; b: number; seconds: number } {
  const a = Math.min(from, gone);
  const b = Math.min(to, gone);
  const span = Math.abs(to - from) || 1;
  return { a, b, seconds: Math.max(0.1, dur * Math.max(0.15, Math.abs(b - a) / span)) * speed };
}

/** On release of a drag: does the turn go on? A flick only if the finger was still moving. */
export function dragOutcome(g: { dir: 1 | -1; t: number; gone: number; v: number; sinceMove: number }): { forward: boolean; committed: boolean } {
  const flick = g.sinceMove < 90 && Math.abs(g.v) > 3;
  const forward = flick ? g.v < 0 : g.t > g.gone / 2;
  return { forward, committed: g.dir > 0 ? forward : !forward };
}

type Anim = { from: number; to: number; dur: number; k: number; ease: (x: number) => number; done: () => void };

export class Transitions {
  /** Over the screens, under the popups (createGame puts it there). */
  readonly layer = new Container();
  /** Force the cross-fade instead of the leaf (QA). */
  fallback = false;
  /** Slow motion: × the duration of every turn (QA, e2e). */
  speed = 1;
  private leafObj: PageLeaf | null | undefined;
  private readonly under = new Sprite();
  private readonly fade = new Sprite();
  private readonly custom = new Container();
  private readonly blocker = new Graphics();
  private readonly owned: Texture[] = [];
  private readonly frames = new Set<(dt: number) => boolean | void>();
  private paper: Texture | null = null;
  private anim: Anim | null = null;
  private running = 0;
  private dragging = false;
  private readonly offFrame: () => void;

  constructor(private readonly host: TransitionHost) {
    this.layer.label = 'transitions';
    this.layer.visible = false;
    this.blocker.eventMode = 'static'; // swallows pointer events while a transition runs
    this.under.visible = this.fade.visible = false;
    this.layer.addChild(this.blocker, this.under, this.custom, this.fade);
    this.offFrame = host.onFrame((dt) => this.step(dt));
  }

  /** A transition (or a drag) runs: the input waits. */
  get active(): boolean {
    return this.running > 0 || this.dragging;
  }

  /** The state now (e2e probe): running, the leaf's phase (the fade's alpha), the mode, snapshots alive. */
  get info(): { active: boolean; t: number; mode: 'leaf' | 'fade'; textures: number } {
    const leaf = this.leaf();
    return { active: this.active, t: leaf ? leaf.t : this.fade.alpha, mode: leaf ? 'leaf' : 'fade', textures: this.owned.length };
  }

  /** The leaf of this renderer (built at the first use), or null — the cross-fade then. */
  leaf(): PageLeaf | null {
    if (this.fallback) return null;
    if (this.leafObj === undefined) {
      this.leafObj = null;
      if (leafSupported(this.host.renderer)) {
        try {
          this.leafObj = new PageLeaf();
          this.leafObj.visible = false;
          this.layer.addChildAt(this.leafObj, this.layer.getChildIndex(this.fade));
        } catch (e) {
          console.warn('kit transitions: no page leaf (its shader), a cross-fade instead', e);
        }
      }
    }
    return this.leafObj;
  }

  /** Render a container as it sits on the window into a texture of `rect` (the column, px). Freed by the transition that takes it. */
  snapshot(root: Container, rect: Rect): RenderTexture {
    const renderer = this.host.renderer;
    const rt = RenderTexture.create({ width: Math.max(1, rect.w), height: Math.max(1, rect.h), resolution: renderer.resolution, antialias: false });
    const vis = root.visible;
    const alpha = root.alpha;
    root.visible = true;
    root.alpha = 1;
    // `transform` REPLACES the root's world matrix for this render: its parent's world × its own
    // local one, shifted by the column's corner.
    root.updateLocalTransform();
    const m = root.parent ? root.parent.worldTransform.clone().append(root.localTransform) : root.localTransform.clone();
    m.translate(-rect.x, -rect.y);
    renderer.render({ container: root, target: rt, clear: true, transform: m });
    root.visible = vis;
    root.alpha = alpha;
    this.owned.push(rt);
    return rt;
  }

  /**
   * Warm up before the first turn: compile the leaf's shader and upload the textures of `pages`
   * (screens not shown yet) — otherwise the first turn starts with a long frame.
   */
  warm(pages: PageTarget[]): void {
    const shots = pages.map((p) => ({ rt: this.snapshot(p.root, p.rect), rect: p.rect }));
    const leaf = this.leaf();
    const first = shots[0];
    if (leaf && first) {
      leaf.setSize(first.rect.w, first.rect.h);
      leaf.setFaces(first.rt, this.backOf(undefined));
      leaf.set(0.3);
      leaf.visible = true;
      this.host.renderer.render({ container: leaf, target: first.rt as RenderTexture, clear: false });
      leaf.visible = false;
      leaf.setFaces(Texture.WHITE, Texture.WHITE);
    }
    this.free();
  }

  /**
   * Play a transition over two snapshots taken by the caller (screens.show): the live screens are
   * hidden, the snapshots freed after. 'fade' / 'none' are not snapshot transitions (Screens plays them).
   */
  async play(spec: Exclude<ScreenTransition, 'fade' | 'none' | { fade: number }>, before: Texture, after: Texture, rect: Rect): Promise<void> {
    this.begin(rect);
    try {
      if (typeof spec === 'function') await this.custom1(spec, before, after, rect);
      else {
        const o = spec.leaf;
        const look = lookOf(o.look);
        if ((o.dir ?? 1) > 0) {
          this.cover(look, before, after, rect, o.back);
          await this.run(0, 1, durationOf(o));
        } else {
          this.cover(look, after, before, rect, o.back);
          await this.run(1, 0, durationOf(o));
        }
      }
    } finally {
      this.end();
    }
  }

  /**
   * Turn a page of one screen (an album's next world): `change` switches the live page (sync or
   * async) while the snapshots are taken around it.
   */
  async turn(page: PageTarget, change: () => void | Promise<void>, opts: LeafOptions = {}): Promise<void> {
    const before = this.snapshot(page.root, page.rect);
    try {
      await change();
    } catch (e) {
      this.free();
      throw e;
    }
    const after = this.snapshot(page.root, page.rect);
    await this.play({ leaf: opts }, before, after, page.rect);
  }

  /** Turn pages with a finger over `host.canvas`: the leaf follows, on release it settles or falls back. Returns the detach. */
  drag(opts: PageDragOptions): () => void {
    const canvas = this.host.canvas;
    if (!canvas) throw new Error('kit transitions: drag() needs the canvas');
    type D = { x0: number; y0: number; on: boolean; dir: 1 | -1; t: number; lastX: number; v: number; at: number; gone: number; w: number; id: number };
    let d: D | null = null;
    const threshold = opts.threshold ?? 12;
    const pageOf = () => (typeof opts.page === 'function' ? opts.page() : opts.page);
    const down = (ev: PointerEvent) => {
      if (d || this.active || !opts.allowed()) return;
      d = { x0: ev.clientX, y0: ev.clientY, on: false, dir: 1, t: 0, lastX: ev.clientX, v: 0, at: now(), gone: 1, w: 1, id: ev.pointerId };
    };
    const move = (ev: PointerEvent) => {
      if (!d || ev.pointerId !== d.id) return;
      const dx = ev.clientX - d.x0;
      if (!d.on) {
        const dy = ev.clientY - d.y0;
        if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy)) {
          if (Math.abs(dy) > threshold * 2) d = null; // a vertical gesture: not a page turn
          return;
        }
        const dir: 1 | -1 = dx < 0 ? 1 : -1;
        if (this.active || !opts.allowed() || !opts.can(dir)) {
          d = null;
          return;
        }
        const page = pageOf();
        d.on = true;
        d.dir = dir;
        d.w = page.rect.w;
        this.dragging = true;
        const leaving = this.snapshot(page.root, page.rect);
        opts.change(dir);
        const arriving = this.snapshot(page.root, page.rect);
        this.begin(page.rect);
        const look = lookOf(opts.look);
        if (dir > 0) this.cover(look, leaving, arriving, page.rect, opts.back);
        else this.cover(look, arriving, leaving, page.rect, opts.back);
        d.gone = this.gone();
        opts.onStart?.(dir);
      }
      const travel = d.w * 1.1;
      d.t = d.dir > 0 ? cl(-dx / travel, 0, 1) : cl(d.gone - dx / travel, 0, d.gone);
      d.v = ev.clientX - d.lastX;
      d.lastX = ev.clientX;
      d.at = now();
      this.set(d.t);
    };
    const up = (ev: PointerEvent) => {
      if (!d || ev.pointerId !== d.id) return;
      const g = d;
      d = null;
      if (!g.on) return;
      const { forward, committed } = dragOutcome({ ...g, sinceMove: now() - g.at });
      opts.onRelease?.(g.dir, committed);
      const to = forward ? 1 : 0;
      this.running++;
      this.dragging = false;
      void this.run(g.t, to, durationOf(opts) * Math.max(0.25, Math.abs(to - g.t))).then(() => {
        this.running--;
        if (!committed) opts.change(g.dir > 0 ? -1 : 1);
        this.end();
        opts.onEnd?.(g.dir, committed);
      });
    };
    const on = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up } as const;
    for (const [type, fn] of Object.entries(on)) canvas.addEventListener(type, fn as EventListener);
    return () => {
      for (const [type, fn] of Object.entries(on)) canvas.removeEventListener(type, fn as EventListener);
    };
  }

  /** Take everything down (game.destroy()). */
  destroy(): void {
    this.offFrame();
    this.free();
    this.paper?.destroy(true);
    if (!this.layer.destroyed) this.layer.destroy({ children: true });
  }

  // ── the pieces ──────────────────────────────────────────────────────────────────────────────────

  /** Block the input, hide the live screens, show the layer at the column. */
  private begin(r: Rect): void {
    if (this.running++ === 0 || !this.layer.visible) {
      this.host.busy?.(true);
      this.host.live.visible = false;
      this.layer.visible = true;
    }
    this.layer.position.set(r.x, r.y);
    this.blocker.clear().rect(-r.x, -r.y, Math.max(r.w + 2 * r.x, 1), Math.max(r.h + 2 * r.y, 1)).fill({ color: 0, alpha: 0.001 });
    this.under.visible = this.fade.visible = false;
    const leaf = this.leaf();
    if (leaf) {
      leaf.visible = false;
      leaf.setSize(r.w, r.h);
    }
  }

  /** The leaf lies over the column at rest (t = 0) with `under` beneath it; the fallback — `front` over `under`. */
  private cover(look: LeafLook, front: Texture, under: Texture, r: Rect, back: Texture | number | undefined): void {
    this.fit(this.under, under, r);
    const leaf = this.leaf();
    if (leaf) {
      leaf.look = look;
      leaf.setFaces(front, this.backOf(back));
      leaf.visible = true;
      leaf.set(0);
    } else {
      this.fit(this.fade, front, r);
      this.fade.alpha = 1;
    }
  }

  private fit(s: Sprite, tex: Texture, r: Rect): void {
    s.texture = tex;
    s.width = r.w;
    s.height = r.h;
    s.visible = true;
  }

  /** The phase where a portrait turn ends (the leaf off the column). */
  private gone(): number {
    return this.leaf()?.gone() ?? 1;
  }

  /** Put the leaf at phase t (the fallback: the front fades). */
  private set(t: number): void {
    const leaf = this.leaf();
    if (leaf) leaf.set(Math.min(t, leaf.gone()));
    else this.fade.alpha = 1 - t;
  }

  /** Animate the phase from → to (clamped to the early finish), `dur` s of a full turn. */
  private run(from: number, to: number, dur: number): Promise<void> {
    const { a, b, seconds } = phaseRun(from, to, dur, this.gone(), this.speed);
    const ease = !this.leaf() ? easeInOut : to > from ? easeIn : easeOut;
    this.set(a);
    return new Promise((done) => (this.anim = { from: a, to: b, dur: seconds, k: 0, ease, done }));
  }

  private async custom1(fn: TransitionFn, before: Texture, after: Texture, r: Rect): Promise<void> {
    const ctx: TransitionContext = {
      before,
      after,
      layer: this.custom,
      width: r.w,
      height: r.h,
      renderer: this.host.renderer,
      frame: (f) =>
        new Promise<void>((done) => {
          const g = (dt: number) => {
            if (f(dt)) {
              this.frames.delete(g);
              done();
            }
          };
          this.frames.add(g);
        }),
      sprite: (tex) => {
        const s = new Sprite(tex);
        s.width = r.w;
        s.height = r.h;
        return s;
      },
    };
    await fn(ctx);
  }

  private step(dt: number): void {
    for (const f of [...this.frames]) f(dt);
    const an = this.anim;
    if (!an) return;
    an.k = Math.min(1, an.k + dt / an.dur);
    this.set(an.from + (an.to - an.from) * an.ease(an.k));
    if (an.k >= 1) {
      this.anim = null;
      an.done();
    }
  }

  /** Hide the layer, free the snapshots, give the screens and the input back. */
  private end(): void {
    if (--this.running > 0) return;
    this.running = 0;
    this.anim = null;
    this.layer.visible = false;
    this.under.texture = Texture.EMPTY;
    this.fade.texture = Texture.EMPTY;
    this.under.visible = this.fade.visible = false;
    for (const c of this.custom.removeChildren()) c.destroy({ children: true });
    const leaf = this.leafObj;
    if (leaf) {
      leaf.setFaces(Texture.WHITE, Texture.WHITE);
      leaf.visible = false;
    }
    this.free();
    this.host.live.visible = true;
    this.host.busy?.(false);
  }

  private free(): void {
    for (const t of this.owned.splice(0)) t.destroy(true);
  }

  private backOf(back: Texture | number | undefined): Texture {
    if (back instanceof Texture) return back;
    if (typeof back === 'number') return colorTexture(back);
    return (this.paper ??= paperTexture());
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const colors = new Map<number, Texture>();
function colorTexture(rgb: number): Texture {
  let t = colors.get(rgb);
  if (!t) {
    if (typeof document === 'undefined') return Texture.WHITE;
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const g = c.getContext('2d');
    if (!g) return Texture.WHITE;
    g.fillStyle = `#${rgb.toString(16).padStart(6, '0')}`;
    g.fillRect(0, 0, 4, 4);
    colors.set(rgb, (t = Texture.from(c)));
  }
  return t;
}

/** The default back of a leaf: plain paper. */
function paperTexture(): Texture {
  if (typeof document === 'undefined') return Texture.WHITE;
  const c = document.createElement('canvas');
  c.width = 270;
  c.height = 480;
  const g = c.getContext('2d');
  if (!g) return Texture.WHITE;
  const grad = g.createLinearGradient(0, 0, 270, 0);
  grad.addColorStop(0, '#ebe6da');
  grad.addColorStop(0.92, '#f3efe6');
  grad.addColorStop(1, '#ddd6c6');
  g.fillStyle = grad;
  g.fillRect(0, 0, 270, 480);
  return Texture.from(c);
}
