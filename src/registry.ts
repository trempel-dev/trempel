// registry.ts — registry of custom components (tml:type="...").
// A component owns its subtree: given its config it builds nodes via the backend and
// exposes a root handle (plus any component-specific API the controller calls).

import type { ScenePath } from './geom/path.js';
import type { SceneNode } from './parser.js';
import type { NodeHandle, RendererBackend } from './render/backend.js';

export interface ComponentContext {
  tag: string;
  attrs: Record<string, string>;
  /** tml:* config attributes (prefix stripped), e.g. cols/rows/cell/gap. */
  tml: Record<string, string>;
  backend: RendererBackend;
  /** Declared children from the scene tree (the component decides how to use them). */
  children: SceneNode[];
  /**
   * Resolve an href relative to the scene document (mount's `baseUrl`). Hrefs passed through
   * `backend` are already resolved; use this for assets the component loads on its own.
   */
  resolveHref?: (href: string) => string;
  /**
   * A component parameter (v0.7): `tml:<name>` from the heir, else `data-<name>` from the base
   * (`data-cols`, `data-cellw`…) — geometry that is appearance stays in the sterile base, logic may
   * override it. undefined when neither is set. The one place components read their config.
   */
  param(name: string): string | undefined;
  /** A geometry node of the scene as a measurable path (v0.7) — see MountedScene.path. */
  path(id: string): ScenePath;
  /** Show a data-views variant of an image of the scene (v0.8) — see MountedScene.setView. */
  setView(id: string, name: string): void;
  /** Geometry hit test of a node of the scene, scene coordinates (v0.9.1) — see MountedScene.hitTest. */
  hitTest(id: string, x: number, y: number): boolean;
}

/** What Registry.create needs; `param` / `path` / `setView` / `hitTest` default to the node's own attributes / an error. */
export type ComponentInit = Omit<ComponentContext, 'param' | 'path' | 'setView' | 'hitTest'> &
  Partial<Pick<ComponentContext, 'param' | 'path' | 'setView' | 'hitTest'>>;

/** tml:<name>, else data-<name> (v0.7 convention). */
export function componentParam(tml: Record<string, string>, attrs: Record<string, string>, name: string): string | undefined {
  return tml[name] ?? attrs[`data-${name}`];
}

/** Every component instance exposes at least its root node. */
export interface ComponentInstance {
  root: NodeHandle;
}

export type ComponentFactory = (ctx: ComponentContext) => ComponentInstance;

export class Registry {
  private factories = new Map<string, ComponentFactory>();

  register(name: string, factory: ComponentFactory): this {
    this.factories.set(name, factory);
    return this;
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  create(name: string, init: ComponentInit): ComponentInstance {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Trempel registry error: unknown component "${name}"`);
    }
    const ctx: ComponentContext = {
      ...init,
      param: init.param ?? ((p) => componentParam(init.tml, init.attrs, p)),
      path:
        init.path ??
        ((id) => {
          throw new Error(`Trempel component error: path("${id}") — компонент создан вне сцены, путей нет.`);
        }),
      setView:
        init.setView ??
        ((id) => {
          throw new Error(`Trempel component error: setView("${id}") — компонент создан вне сцены.`);
        }),
      hitTest:
        init.hitTest ??
        ((id) => {
          throw new Error(`Trempel component error: hitTest("${id}") — компонент создан вне сцены.`);
        }),
    };
    return factory(ctx);
  }
}
