// runtime.ts — the browser half shared by the viewer (view/app) and the editor (edit/app): the
// consumer module (trempel.view.ts), its one-time setup (fonts, patches), and opening a scene into
// a Pixi container — real mount() over the module's backend and registry, placed by fitStage.
//
// Where documents and art come from is the caller's business (the viewer's dev server, the
// editor's SceneIO): it passes the sources as text and the URL the scene document lives at.

import { Container } from 'pixi.js';
import { createDefaultRegistry, PixiBackend, readHeirAsync, sceneStem } from '@trempel/scene';
import { preloadScenes, type AsyncSceneLoader, type Registry, type RendererBackend } from '../src/core.js';
import type { ViewConfig } from './api';
import { openScene, type OpenInput, type SceneSources, type ViewIssue, type ViewSession } from './session';
import { fitStage, type StageFit, type ViewBox, type Viewport } from './viewport';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface Opened {
  session: ViewSession;
  fit: StageFit;
  /** Problems outside the session (module hooks). */
  extra: ViewIssue[];
}

export interface OpenIntoInput {
  /** Scene id (path stem in the folder) — for the module's onMount. */
  id: string;
  sources: SceneSources;
  /** URL of the scene document: relative hrefs resolve against it (or the module's baseUrl). */
  docUrl: string;
  state?: string;
  viewport: Viewport;
  hooks?: Partial<Pick<OpenInput, 'onIssue' | 'onLog'>>;
  /** The editor wraps the backend (node bookkeeping) and the registry (stand-ins for unknown components). */
  wrapBackend?: (backend: RendererBackend) => RendererBackend;
  wrapRegistry?: (registry: Registry) => Registry;
  /** viewBox to fit when the scene has none (default: the drawn bounds). */
  fallbackBox?: ViewBox;
  /** v0.9: prefab documents by URL (resolved against docUrl) — see folderSceneLoader. */
  loadScene?: AsyncSceneLoader;
}

/**
 * A loader over a scene folder (v0.9): a URL under `folderUrl` → the folder-relative stem → its
 * base / heir / contract among `files` (only listed files are read). Anything else — null.
 */
export function folderSceneLoader(folderUrl: string, files: string[], read: (rel: string) => Promise<string>): AsyncSceneLoader {
  const listed = new Set(files);
  return async (url) => {
    if (!url.startsWith(folderUrl)) return null;
    const rel = url.slice(folderUrl.length).split(/[?#]/)[0].split('/').map(decodeURIComponent).join('/');
    const stem = sceneStem(rel);
    const get = (f: string): Promise<string | undefined> => (listed.has(f) ? read(f) : Promise.resolve(undefined));
    const [base, heir, contract] = await Promise.all([get(`${stem}.svg`), readHeirAsync(get, stem), get(`${stem}.contract.xml`)]);
    return base != null || heir != null ? { base, heir, contract } : null;
  };
}

export interface StageRuntime {
  readonly config: ViewConfig;
  /** Open a scene into `target` (cleared first): mount, place, wait for textures. */
  openInto(target: Container, input: OpenIntoInput): Promise<Opened>;
}

/** Load the folder's consumer module (`virtual:trempel-view-module` in the dev servers). */
export async function loadViewModule(load: () => Promise<{ default: unknown }>): Promise<{ config: ViewConfig; issue: ViewIssue | null }> {
  try {
    const m = await load();
    return { config: (m.default as ViewConfig | null) ?? {}, issue: null };
  } catch (e) {
    return { config: {}, issue: { level: 'error', kind: 'component', message: `модуль просмотра не загрузился — рисует голый рантайм: ${msg(e)}` } };
  }
}

export function clearContainer(target: Container): void {
  for (const c of target.removeChildren()) c.destroy({ children: true });
}

function boundsBox(c: Container): ViewBox {
  const b = c.getLocalBounds();
  return b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : { x: 0, y: 0, w: 640, h: 480 };
}

/**
 * @param config      the module's view config ({} — bare runtime)
 * @param moduleIssue the module failed to load: reported with every scene
 * @param folderUrl   URL of the scene folder (module fonts are relative to it)
 * @param mapUrl      last step for every URL handed to the runtime (fonts, hrefs): a host whose file
 *                    URLs cannot be resolved against (`/f/key?p=…`) gives the scene a virtual base
 *                    and maps the resolved URL to the real one here
 */
export function createStageRuntime(config: ViewConfig, moduleIssue: ViewIssue | null, folderUrl: string, mapUrl?: (url: string) => string): StageRuntime {
  let setupDone: Promise<void> | null = null;
  const setup = (): Promise<void> => {
    setupDone ??= (async () => {
      for (const f of config.fonts ?? []) {
        const url = new URL(f.url, folderUrl).href;
        const face = new FontFace(f.family, `url(${mapUrl ? mapUrl(url) : url})`, { weight: f.weight, style: f.style });
        document.fonts.add(await face.load());
      }
      await config.setup?.();
    })();
    return setupDone;
  };

  /** baseUrl / resolveHref for mount() from the module's settings. */
  const hrefs = (docUrl: string): { baseUrl?: string; resolveHref?: (href: string) => string } => {
    const map = config.resolveHref;
    const last = (u: string): string => (mapUrl ? mapUrl(u) : u);
    if (config.baseUrl === false) {
      return {
        resolveHref: (href) => {
          const r = map ? map(href) : href;
          return last(r === href ? new URL(href, docUrl).href : r);
        },
      };
    }
    const resolveHref = map ? (h: string) => last(map(h)) : mapUrl;
    return { baseUrl: config.baseUrl ? new URL(config.baseUrl, docUrl).href : docUrl, resolveHref };
  };

  return {
    config,
    async openInto(target, input) {
      const extra: ViewIssue[] = moduleIssue ? [moduleIssue] : [];
      try {
        await setup();
      } catch (e) {
        extra.push({ level: 'error', kind: 'component', message: `setup() модуля просмотра: ${msg(e)}` });
      }
      clearContainer(target);
      let backend: RendererBackend;
      let registry: Registry;
      try {
        backend = config.backend?.() ?? new PixiBackend({ fontFamily: config.fontFamily });
        registry = config.registry?.() ?? createDefaultRegistry();
      } catch (e) {
        extra.push({ level: 'error', kind: 'component', message: `модуль просмотра: ${msg(e)}` });
        backend = new PixiBackend({ fontFamily: config.fontFamily });
        registry = createDefaultRegistry();
      }
      const sceneUrl = input.docUrl;
      const path = `${input.id}.svg`;
      let loadScene;
      if (input.loadScene) {
        const url = (rel: string): string => new URL(rel, sceneUrl).href;
        loadScene = await preloadScenes({ ...input.sources, path, url }, input.loadScene);
      }
      const s = openScene({
        sources: input.sources,
        loadScene,
        sceneUrl,
        path,
        state: input.state,
        backend: input.wrapBackend ? input.wrapBackend(backend) : backend,
        registry: input.wrapRegistry ? input.wrapRegistry(registry) : registry,
        container: target,
        ...hrefs(input.docUrl),
        context: config.context,
        ...input.hooks,
      });
      if (s.scene && config.onMount) {
        try {
          config.onMount({ id: input.id, scene: s.scene, state: s.state });
        } catch (e) {
          extra.push({ level: 'error', kind: 'component', message: `onMount() модуля просмотра: ${msg(e)}` });
        }
      }
      await s.ready;
      const vb = s.viewBox ?? input.fallbackBox ?? boundsBox(target);
      const f = fitStage(vb, input.viewport);
      target.scale.set(f.scale);
      target.position.set(f.x, f.y);
      return { session: s, fit: f, extra };
    },
  };
}
