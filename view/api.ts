// api.ts — what a consumer's `trempel.view.ts` (next to its scenes) may export as default.
// Every field is optional: without the module the viewer runs the bare runtime (default registry
// with reel-grid, plain PixiBackend, hrefs relative to the scene document).
//
//   import { defineView } from '@trempel/scene/view';
//   export default defineView({ registry: () => myRegistry(), backend: () => new MyBackend() });
//
// Inside the viewer `@trempel/scene` and `@trempel/scene/core` resolve to this runtime and `pixi.js` to one copy,
// so a consumer's components and backend subclass draw with exactly what the viewer mounts.

import type { MountedScene, Registry, RendererBackend } from '../src/core.js';

export interface FontSpec {
  family: string;
  /** Font file URL (absolute, or relative to the scene folder: `fonts/x.woff2`). */
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

export interface ViewConfig {
  /** Runs once before the first scene (install backend patches, preload art). */
  setup?: () => void | Promise<void>;
  /** Component registry; default — the runtime's (reel-grid). Called per mount. */
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
  /** After each mount: seed components (reel fields, icons) from the state. */
  onMount?: (args: ViewHookArgs) => void;
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
}

export function defineView(config: ViewConfig): ViewConfig {
  return config;
}
