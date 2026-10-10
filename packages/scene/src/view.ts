// view.ts — what a consumer's `trempel.view.ts` (next to its scenes) may export as default
// (`@trempel/scene/view`; the viewer and the editor page read it).
// Every field is optional: without the module the viewer runs the bare runtime (default registry
// — no components, plain PixiBackend, hrefs relative to the scene document).
//
//   import { defineView } from '@trempel/scene/view';
//   export default defineView({ registry: () => myRegistry(), backend: () => new MyBackend() });
//
// Inside the viewer `@trempel/scene` and `@trempel/scene/core` resolve to this runtime and `pixi.js` to one copy,
// so a consumer's components and backend subclass draw with exactly what the viewer mounts.

import type { Registry } from './registry.js';
import type { RendererBackend } from './render/backend.js';
import type { MountedScene } from './scene.js';

export interface FontSpec {
  family: string;
  /** Font file URL (absolute, relative to the scene folder: `fonts/x.woff2`, or — 2.0 — in a collection: `@ui/fonts/x.ttf`). */
  url: string;
  weight?: string;
  style?: string;
}

export interface ViewHookArgs {
  /** Scene id (path stem relative to the folder), e.g. `popups/map`. */
  id: string;
  scene: MountedScene;
  /** The reactive stand-in state (from X.state.json / the page editor). */
  state: Record<string, unknown>;
}

/** 2.2: the scene posed by a clip (the viewer's `view:shot --clip --t`, the editor's clip panel). */
export interface ViewClipArgs {
  /** Scene id (path stem relative to the folder). */
  id: string;
  scene: MountedScene;
  clip: string;
  /** Seconds into the clip as shown. */
  t: number;
  /** The clip's markers ($events) at or before `t` in this cycle, by time. */
  markers: { t: number; name: string }[];
}

/** 2.3: the editor's widgets an inspector may use (the page's own: curves, gradients). */
export interface InspectorUi {
  /**
   * A curve editor: points [t, v] (t 0..1) dragged in a box; double-click adds, right-click removes.
   * `range` — the value range shown (default 0..1); onChange — after a drag / an add / a remove.
   */
  curve(opts: { points: [number, number][]; range?: [number, number]; onChange(points: [number, number][]): void; label?: string }): { el: HTMLElement; set(points: [number, number][]): void };
  /**
   * A gradient editor: colour stops [t, r, g, b] (0..1) and alpha stops [t, a] over a strip; a stop
   * is dragged, clicked for its colour / alpha, double-click on the strip adds one, right-click removes.
   */
  gradient(opts: {
    color: [number, number, number, number][];
    alpha: [number, number][];
    onChange(g: { color: [number, number, number, number][]; alpha: [number, number][] }): void;
  }): { el: HTMLElement; set(g: { color: [number, number, number, number][]; alpha: [number, number][] }): void };
}

/** 2.3: what the editor gives an inspector panel (and an inspector's agent API). */
export interface InspectorHost {
  /** The node inspected: its id and the composed node (attrs of the base, tml of the heir); null — none (a palette, the API). */
  node: { id: string; tag: string; attrs: Record<string, string>; tml: Record<string, string>; inserted: boolean } | null;
  /** The mounted scene and the node's component instance (scene.components.get(id)). */
  scene(): MountedScene | null;
  component(): unknown;
  /** Run a command of the editor core (the base — node.*, the heir's effects — heir.setAttr / heir.insertFx): one undo step. */
  exec(name: string, args: Record<string, unknown>): { ok: boolean; errors?: string[] } | null;
  /** Files of the scene folder (paths relative to it). */
  files: { list(dir?: string): Promise<string[]>; read(path: string): Promise<string>; write(path: string, text: string): Promise<void> };
  ui: InspectorUi;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  /** Redraw the panels (after a change the inspector made outside the commands). */
  refresh(): void;
}

/** 2.3: an inspector panel: a DOM element and how to take it down. */
export interface InspectorPanel {
  el: HTMLElement;
  dispose(): void;
}

/** 2.3: a panel for the nodes of one `tml:type` (a function), or with a palette and an agent API too. */
export type InspectorFactory =
  | ((host: InspectorHost) => InspectorPanel)
  | {
      panel(host: InspectorHost): InspectorPanel;
      /** Shown under the inspector whatever is selected (e.g. effects to drag onto the stage). */
      palette?(host: InspectorHost): InspectorPanel;
      /** For scripts and agents: `tml.inspect[type]` (the same edits the panel makes). */
      api?(host: InspectorHost): Record<string, unknown>;
    };

/** 2.3: what is dragged from a palette onto the stage: an effect node (heir.insertFx into the selected group). */
export const FX_DRAG_MIME = 'application/x-trempel-fx';

export interface ViewConfig {
  /** Runs once before the first scene (install backend patches, preload art). */
  setup?: () => void | Promise<void>;
  /** Component registry; default — an empty one (the runtime has no built-ins). Called per mount. */
  registry?: () => Registry;
  /** Renderer backend, e.g. a PixiBackend subclass; must render with Pixi. Called per mount. */
  backend?: () => RendererBackend;
  /**
   * Base URL that relative hrefs resolve against, instead of the scene document: relative to the
   * scene document (`../art/`), or absolute. `false` — mount without baseUrl, as a host whose
   * resolveHref expects scene-relative hrefs (`ui/x.webp`); what resolveHref returns unchanged
   * still resolves against the scene document, so plain art keeps loading.
   */
  baseUrl?: string | false;
  /** Final href mapping after baseUrl (a bundler table, a skin lookup). */
  resolveHref?: (href: string) => string;
  /** Web fonts loaded before the first mount. */
  fonts?: FontSpec[];
  /** Default font family for <text> without font-family (PixiBackend option). */
  fontFamily?: string;
  /**
   * Extra expression context next to `state` (texts `t`, real handlers). Names the scene uses that
   * nobody provides become logging stubs.
   */
  context?: (state: Record<string, unknown>) => Record<string, unknown>;
  /** After each mount: seed components (grid fields, icons) from the state. */
  onMount?: (args: ViewHookArgs) => void;
  /**
   * 2.2: after every pose of the scene by a clip (a seek, a played frame): what lives in time next
   * to the clip — a particle effect fired by a marker — catches up to `t` (deterministically: the
   * same `t` and markers, the same picture).
   */
  onClipTime?: (args: ViewClipArgs) => void;
  /** Stage background (CSS colour); default — transparent over the checkerboard. */
  background?: string;
  /**
   * v0.9: folders of prefabs for the editor's palette (⌘P), relative to the scene folder, e.g.
   * `['ui', 'kit']`. The palette lists every scene of the open folder anyway; a folder outside it
   * (`../kit/ui`) is named in the palette as not reachable.
   */
  prefabs?: string[];
  /**
   * v1.1: collections for this folder — name → folder URL (relative to the scene folder, or
   * absolute). The tools read `.trempel/project.mdz` themselves; a name given here overrides the
   * project's (a skin under test, a CDN).
   */
  collections?: Record<string, string>;
  /**
   * 2.3: inspector panels of the editor for the nodes of a `tml:type` (`{ fx: … }`): the consumer
   * brings the editor of its components — the scene knows nothing of them.
   */
  inspectors?: Record<string, InspectorFactory>;
}

export function defineView(config: ViewConfig): ViewConfig {
  return config;
}
