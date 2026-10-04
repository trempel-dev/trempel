// backend.ts — renderer-agnostic backend interface.
// The core (scene build, binding, animation) never touches PixiJS directly; it speaks
// this interface. PixiBackend (render/pixi.ts) implements it; tests use a mock.

/** Opaque handle to a backend node (a Pixi display object, a mock record, etc.). */
export type NodeHandle = object;

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A <clipPath> handed to the backend (v0.7): its own attrs (transform) and its shape children —
 * path / rect / circle / ellipse, or g of those, each with raw attributes. A SceneNode fits.
 */
export interface ClipShape {
  tag: string;
  attrs: Record<string, string>;
  children: ClipShape[];
}

/** v0.9 pointer events of tml:on-over / on-out / on-down / on-up. */
export type PointerKind = 'over' | 'out' | 'down' | 'up';

export interface RendererBackend {
  /**
   * Create a node for a standard SVG tag (g/image/text/rect; v0.7: path/circle/ellipse/line) with
   * its raw attributes. <defs> and <clipPath> never reach the backend.
   */
  createNode(tag: string, attrs: Record<string, string>): NodeHandle;

  /**
   * Write a property by path. Path may be nested with dots ('scale.y') or one of the
   * special keys: 'text', 'href', 'visible', 'tint', 'x', 'y', 'alpha', 'rotation'; v0.8: 'z',
   * 'mix-blend-mode'; v0.9.1: 'display' ('none' hides), and on geometry 'stroke-dashoffset',
   * 'stroke-width', 'stroke-opacity' (clip columns dash / strokeWidth / strokeAlpha).
   */
  setProp(node: NodeHandle, path: string, value: unknown): void;

  /** Register a click/tap handler. */
  onClick(node: NodeHandle, handler: () => void): void;

  /**
   * Optional (v0.9): pointer handlers — `over` / `out` (hover), `down` / `up` (press; `up` also when
   * released outside). Required when the scene uses tml:on-over / on-out / on-down / on-up.
   */
  onPointer?(node: NodeHandle, kind: PointerKind, handler: () => void): void;

  addChild(parent: NodeHandle, child: NodeHandle): void;

  /** Attach the root node to a host container (e.g. a Pixi Application stage). */
  mount(root: NodeHandle, container: unknown): void;

  /** World-space bounds, used to lay out win lines over the grid. */
  getBounds(node: NodeHandle): Bounds;

  /**
   * Optional (v0.6): resolves once every asset load the backend has started so far has settled;
   * rejects (TrempelError) listing what failed. mount() exposes it as `MountedScene.ready`.
   * A backend without async assets may omit it — the scene is then ready immediately.
   */
  whenReady?(): Promise<void>;

  /**
   * Optional (v0.7): mask `node` by a clip path, or remove its mask (`null`). The geometry is in the
   * node's own coordinate system (SVG userSpaceOnUse), so it follows the node's transform; fill
   * only, stroke ignored. Each call gets its own mask (one <clipPath> on many nodes is fine).
   * Required when the scene uses clip-path.
   */
  setClip?(node: NodeHandle, clip: ClipShape | null): void;

  /**
   * Optional (v0.7): read a property by the same paths setProp writes ('x', 'scale.y', 'rotation'…).
   * The animation player uses it to remember a node's rest pose for relative tracks.
   */
  getProp?(node: NodeHandle, path: string): unknown;
}
