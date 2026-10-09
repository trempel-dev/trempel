// main.ts — the viewer page: scene list, the selected scene drawn by the real runtime (mount() over
// PixiBackend), issues panel, stand-in state editor, click log, viewport presets, gallery, PNG.
//
// URL: ?scene=<id>&vp=<scene|W:H|WxH>&zoom=<fit|0.5…>&mode=gallery — shareable, and what the
// headless shot drives. `window.tmlView` is the page API for the headless shot (see shot.mjs).

import { Application, Container, Graphics, Rectangle } from 'pixi.js';
import { ClipPlayer, compileSceneClips } from '../clips';
import { clipFiles, type SceneEntry } from '../discover';
import { coded, fetchSceneLoader, within } from '../../src/core.js';
import type { ProjectInfo } from '../plugin';
import { clearContainer, createStageRuntime, folderSceneLoader, loadViewModule, type Opened, type StageRuntime } from '../runtime';
import type { LogEntry, OpenInput, ViewIssue, ViewSession } from '../session';
import { parseViewport, viewportLabel, type StageFit, type Viewport } from '../viewport';

let runtime: StageRuntime;

async function loadModule(): Promise<void> {
  const { config, issue } = await loadViewModule(() => import('virtual:trempel-view-module'));
  runtime = createStageRuntime(config, issue, folderUrl());
}
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const FILES = '/__tml/files/';
/** v1.1: the project as the server sees it (the folder under the project root, collections). */
let project: ProjectInfo | null = null;
const abs = (path: string): string => new URL(path, location.origin).href;
const enc = (rel: string): string => rel.split('/').map(encodeURIComponent).join('/');
/** URL of the scene folder: under the project root, so hrefs leaving the folder still load. */
const folderUrl = (): string => abs(project?.folderUrl ?? FILES);
/** URL of a folder file, or of a collection file (`@name/…`). */
const fileUrl = (rel: string): string => {
  const m = /^@([a-z][a-z0-9-]*)\/(.*)$/.exec(rel);
  if (m && project?.collections[m[1]]) return abs(project.collections[m[1]] + enc(m[2]));
  return new URL(enc(rel), folderUrl()).href;
};
/** Collection URLs for mount (absolute). */
const collectionUrls = (): Record<string, string> | undefined =>
  project && Object.keys(project.collections).length ? Object.fromEntries(Object.entries(project.collections).map(([k, v]) => [k, abs(v)])) : undefined;
/** Files of the collections, as `@name/…` (prefab documents load from them). */
let collectionFiles: string[] = [];

// ---- state of the page ------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
let scenes: SceneEntry[] = [];
/** Every file of the folder (clip files are found in it). */
let folderFiles: string[] = [];
let current: SceneEntry | null = null;
let session: ViewSession | null = null;
let fit: StageFit | null = null;
let stateText = ''; // editor text in effect for the current scene
let stateDirty = false;
let mode: 'scene' | 'gallery' = params.get('mode') === 'gallery' ? 'gallery' : 'scene';
let viewport: Viewport = safeViewport(params.get('vp') ?? 'scene');
let zoom = params.get('zoom') ?? 'fit';
let opening: Promise<unknown> = Promise.resolve();

function safeViewport(s: string): Viewport {
  try {
    return parseViewport(s);
  } catch {
    return { kind: 'scene' };
  }
}

// ---- Pixi -------------------------------------------------------------------------------------

const app = new Application();
/** Stage = what the PNG captures: optional background + the scene root placed by `fit`. */
const holder = new Container();
const world = new Container();

async function initPixi(): Promise<void> {
  await app.init({ width: 64, height: 64, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoDensity: false });
  $('stage').appendChild(app.canvas);
  app.stage.addChild(holder);
  holder.addChild(world);
}

function background(w: number, h: number): Graphics | null {
  const bg = runtime.config.background;
  if (!bg) return null;
  return new Graphics().rect(0, 0, w, h).fill(bg);
}

// ---- loading ------------------------------------------------------------------------------------

async function text(rel: string | undefined): Promise<string | undefined> {
  if (!rel) return undefined;
  const r = await fetch(fileUrl(rel));
  if (!r.ok) throw new Error(coded('E_FETCH', `${rel}: HTTP ${r.status}`));
  return r.text();
}

/** Open a scene into `target` (cleared first): fetch, mount, place, wait for textures. */
async function openInto(target: Container, entry: SceneEntry, state: string | undefined, vp: Viewport, hooks: Partial<Pick<OpenInput, 'onIssue' | 'onLog'>> = {}): Promise<Opened> {
  const [base, heir, contract] = await Promise.all([text(entry.base), text(entry.heir), text(entry.contract)]);
  const collections = collectionUrls();
  const listed = folderSceneLoader(folderUrl(), [...folderFiles, ...collectionFiles], async (rel) => (await text(rel))!, collections);
  // v1.1: a prefab outside the folder but inside the project root (a relative ../ path) — fetched as is.
  const rootUrl = abs(project?.rootUrl ?? FILES);
  const fetched = fetchSceneLoader();
  const loadScene = async (url: string) => (await listed(url)) ?? (url.startsWith(rootUrl) && !url.startsWith(folderUrl()) ? fetched(url) : null);
  const heirs = project && Object.keys(project.heirs ?? {}).length ? Object.fromEntries(Object.entries(project.heirs).map(([k, v]) => [k, abs(v)])) : undefined;
  return runtime.openInto(target, { id: entry.id, sources: { base, heir, contract }, docUrl: fileUrl(entry.base ?? entry.heir ?? entry.id), state, viewport: vp, hooks, loadScene, collections, heirs });
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- the scene mode -----------------------------------------------------------------------------

let extraIssues: ViewIssue[] = [];
/** v1.1: problems of .trempel/project.mdz — shown with every scene. */
let projectIssues: ViewIssue[] = [];
/** Click log of the current scene — survives state applies and reopens, cleared on scene change. */
let clicks: LogEntry[] = [];

async function open(entry: SceneEntry, opts: { keepState?: boolean } = {}): Promise<void> {
  if (entry.id !== current?.id) clicks = [];
  current = entry;
  const stateIssues: ViewIssue[] = [];
  if (!opts.keepState) {
    try {
      stateText = (await text(entry.state)) ?? '';
    } catch (e) {
      stateText = '';
      stateIssues.push({ level: 'error', kind: 'state', message: msg(e) });
    }
    stateDirty = false;
    ($('state') as HTMLTextAreaElement).value = stateText || '{\n  \n}';
  }
  syncUrl();
  renderList();
  extraIssues = [];
  try {
    const o = await openInto(world, entry, stateText, viewport, { onIssue: renderIssues, onLog: (e) => { clicks.push(e); renderLog(); } });
    session = o.session;
    fit = o.fit;
    extraIssues = [...stateIssues, ...o.extra];
  } catch (e) {
    session = null;
    fit = null;
    clearContainer(world);
    extraIssues = [...stateIssues, { level: 'error', kind: 'base', message: msg(e) }];
  }
  layout();
  renderIssues();
  renderLog();
  renderStateMeta();
}

function reopen(): Promise<void> {
  if (!current) return Promise.resolve();
  const p = opening.then(() => open(current!, { keepState: stateDirty }));
  opening = p.catch(() => {});
  return p;
}

function layout(): void {
  const f = fit ?? { width: 64, height: 64, scale: 1, x: 0, y: 0 };
  app.renderer.resize(f.width, f.height);
  holder.removeChildren();
  const bg = background(f.width, f.height);
  if (bg) holder.addChild(bg);
  holder.addChild(world);
  const wrap = $('stage-wrap');
  const z = zoom === 'fit' ? Math.min((wrap.clientWidth - 32) / f.width, (wrap.clientHeight - 32) / f.height, 1) : Number(zoom);
  app.canvas.style.width = `${Math.round(f.width * z)}px`;
  app.canvas.style.height = `${Math.round(f.height * z)}px`;
  $('size').textContent = `${f.width}×${f.height} · ${Math.round(z * 100)}%`;
}

function snapshot(): Promise<string> {
  const f = fit ?? { width: 64, height: 64 };
  return app.renderer.extract.base64({ target: holder, frame: new Rectangle(0, 0, f.width, f.height), format: 'png' });
}

// ---- the gallery ----------------------------------------------------------------------------------

let galleryRun = 0;

async function gallery(): Promise<void> {
  const run = ++galleryRun;
  const box = $('gallery');
  box.innerHTML = '';
  const off = new Container();
  const scene = new Container();
  for (const entry of scenes) {
    if (run !== galleryRun) break;
    const tile = el('div', 'tile');
    const img = el('div', 'img');
    const cap = el('div', 'cap');
    cap.append(el('span', '', entry.id));
    tile.append(img, cap);
    tile.onclick = () => setMode('scene', entry);
    box.append(tile);
    try {
      const stateSrc = await text(entry.state);
      const o = await openInto(scene, entry, stateSrc, viewport, {});
      off.removeChildren();
      const bg = background(o.fit.width, o.fit.height);
      if (bg) off.addChild(bg);
      off.addChild(scene);
      const k = Math.min(1, 520 / Math.max(o.fit.width, o.fit.height));
      const url = await app.renderer.extract.base64({ target: off, frame: new Rectangle(0, 0, o.fit.width, o.fit.height), resolution: k, format: 'png' });
      const image = new Image();
      image.src = url;
      img.append(image);
      cap.append(badge([...o.extra, ...o.session.issues]));
      bg?.destroy();
    } catch (e) {
      img.append(el('span', 'muted', msg(e)));
    }
  }
  clearContainer(scene);
}

// ---- rendering of the panels ----------------------------------------------------------------------

function el(tag: string, cls = '', textContent?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (textContent != null) e.textContent = textContent;
  return e;
}

function badge(issues: ViewIssue[]): HTMLElement {
  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.length - errors;
  if (errors) return el('span', 'badge err', String(errors));
  if (warns) return el('span', 'badge warn', String(warns));
  return el('span', 'badge', 'ok');
}

function allIssues(): ViewIssue[] {
  return [...projectIssues, ...extraIssues, ...(session?.issues ?? [])];
}

function renderList(): void {
  const ul = $('scenes');
  ul.innerHTML = '';
  for (const s of scenes) {
    const li = el('li', s === current || s.id === current?.id ? 'on' : '');
    li.append(el('span', '', s.id));
    const parts = [s.base ? 'svg' : '', s.heir ? 'tml' : '', s.contract ? 'contract' : '', s.state ? 'state' : ''].filter(Boolean);
    li.append(el('span', 'parts', parts.join(' · ')));
    li.onclick = () => setMode('scene', s);
    ul.append(li);
  }
}

function renderIssues(): void {
  const list = allIssues();
  const ul = $('issues');
  ul.innerHTML = '';
  if (!list.length) ul.append(el('li', 'ok', current ? 'no errors' : '—'));
  for (const i of list) {
    const li = el('li', i.level);
    li.append(el('span', 'kind', i.kind));
    li.append(el('pre', '', i.message));
    ul.append(li);
  }
  const count = $('issue-count');
  count.replaceWith(Object.assign(badge(list), { id: 'issue-count' }));
}

function renderLog(): void {
  const ol = $('log');
  ol.innerHTML = '';
  clicks.forEach((e, i) => (e.seq = i + 1));
  for (const e of [...clicks].reverse()) {
    const li = el('li') as HTMLLIElement;
    li.value = e.seq;
    li.append(`${e.node} `, el('span', 'muted', e.expr));
    if (e.calls.length) li.append(el('div', 'calls', '→ ' + e.calls.join(', ')));
    ol.append(li);
  }
}

function renderStateMeta(): void {
  $('state-src').textContent = current?.state ? `${current.state}${stateDirty ? ' (edited)' : ''}` : stateDirty ? 'edited' : 'no file';
  $('state').classList.toggle('dirty', stateDirty);
}

// ---- controls -----------------------------------------------------------------------------------

function syncUrl(): void {
  const p = new URLSearchParams();
  if (current) p.set('scene', current.id);
  if (viewport.kind !== 'scene') p.set('vp', viewportLabel(viewport));
  if (zoom !== 'fit') p.set('zoom', zoom);
  if (mode === 'gallery') p.set('mode', 'gallery');
  history.replaceState(null, '', `${location.pathname}${p.size ? '?' + p : ''}`);
}

function setMode(m: 'scene' | 'gallery', entry?: SceneEntry): void {
  mode = m;
  $('mode-scene').classList.toggle('on', m === 'scene');
  $('mode-gallery').classList.toggle('on', m === 'gallery');
  $('stage').hidden = m !== 'scene';
  $('gallery').hidden = m !== 'gallery';
  $('panel').style.visibility = m === 'scene' ? '' : 'hidden';
  syncUrl();
  if (m === 'gallery') {
    void gallery();
    return;
  }
  galleryRun++;
  const target = entry ?? current ?? scenes[0];
  if (target) {
    const p = opening.then(() => open(target, { keepState: target === current && stateDirty }));
    opening = p.catch(() => {});
  }
}

function bindControls(): void {
  const vpSel = $('viewport') as HTMLSelectElement;
  const cw = $('cw') as HTMLInputElement;
  const ch = $('ch') as HTMLInputElement;
  const label = viewportLabel(viewport);
  if (viewport.kind === 'size') {
    vpSel.value = 'custom';
    cw.value = String(viewport.w);
    ch.value = String(viewport.h);
    $('custom').hidden = false;
  } else if ([...vpSel.options].some((o) => o.value === label)) vpSel.value = label;
  const onViewport = (): void => {
    $('custom').hidden = vpSel.value !== 'custom';
    viewport = vpSel.value === 'custom' ? safeViewport(`${cw.value}x${ch.value}`) : safeViewport(vpSel.value);
    if (mode === 'gallery') setMode('gallery');
    else void reopen();
  };
  vpSel.onchange = onViewport;
  cw.onchange = onViewport;
  ch.onchange = onViewport;

  const zoomSel = $('zoom') as HTMLSelectElement;
  zoomSel.value = [...zoomSel.options].some((o) => o.value === zoom) ? zoom : 'fit';
  zoomSel.onchange = () => {
    zoom = zoomSel.value;
    syncUrl();
    layout();
  };
  window.addEventListener('resize', () => layout());

  const bgSel = $('bg') as HTMLSelectElement;
  bgSel.onchange = () => {
    $('stage-wrap').className = bgSel.value;
  };

  $('mode-scene').onclick = () => setMode('scene');
  $('mode-gallery').onclick = () => setMode('gallery');

  $('shot').onclick = async () => {
    if (mode !== 'scene' || !current) return;
    const a = document.createElement('a');
    a.href = await snapshot();
    a.download = `${current.id.replace(/\//g, '_')}.png`;
    a.click();
  };

  const area = $('state') as HTMLTextAreaElement;
  const apply = (): void => {
    stateText = area.value;
    stateDirty = true;
    void reopen();
  };
  $('apply').onclick = apply;
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      apply();
    }
  });
  area.addEventListener('input', () => {
    $('state').classList.add('dirty');
  });
  $('reset').onclick = () => {
    if (!current) return;
    stateDirty = false;
    const p = opening.then(() => open(current!));
    opening = p.catch(() => {});
  };
  $('clear-log').onclick = () => {
    clicks = [];
    renderLog();
  };
}

async function loadList(): Promise<void> {
  const r = await fetch('/__tml/scenes');
  const data = (await r.json()) as { name: string; module: string | null; scenes: SceneEntry[]; files?: string[]; error?: string; project?: ProjectInfo };
  scenes = data.scenes;
  folderFiles = data.files ?? [];
  project = data.project ?? null;
  collectionFiles = [];
  for (const name of Object.keys(project?.collections ?? {})) {
    const l = await fetch(`/__tml/list?dir=${encodeURIComponent(`@${name}`)}`, { cache: 'no-store' });
    if (l.ok) collectionFiles.push(...(((await l.json()) as { files?: string[] }).files ?? []));
  }
  $('folder').textContent = `${data.name}${data.module ? ` · ${data.module}` : ''}`;
  if (data.error) extraIssues = [{ level: 'error', kind: 'base', message: data.error }];
  projectIssues = (project?.errors ?? []).map((message) => ({ level: 'error', kind: 'collection', message }));
  if (current) current = scenes.find((s) => s.id === current!.id) ?? null;
  $('empty').hidden = scenes.length > 0;
  $('empty').textContent = scenes.length ? '' : 'No scenes in the folder (X.svg / X.tml.svg).';
  renderList();
}

// ---- page API for the headless shot -------------------------------------------------------------
//
// view:shot runs the page on Playwright's virtual clock: `open` mounts the scene and waits for its
// textures without waiting on any frame or timer; shot.mjs then moves the virtual time in fixed
// frame steps (`--settle`), and `snap` / `pose` take the pictures. Nothing here waits on time, so
// the PNG depends only on the scene and the number of frames played.

interface OpenResult {
  id: string;
  width: number;
  height: number;
  viewport: string;
  stubs: string[];
}

interface ShotResult {
  issues: ViewIssue[];
  png: string;
  /** With `clip`: one PNG per requested time (seconds). */
  frames?: { t: number; png: string }[];
}

declare global {
  interface Window {
    tmlView?: {
      scenes(): SceneEntry[];
      /** Mount a scene and wait for its textures (no frames, no timers). */
      open(id: string, opts?: { state?: string; viewport?: string }): Promise<OpenResult>;
      /** Snapshot of the opened scene, or (with `clip`) one per time of that clip. */
      snap(opts?: { clip?: string; t?: number[] }): Promise<ShotResult>;
    };
  }
}

/**
 * Pose the opened scene by a clip at each time and snapshot it (view:shot --clip --t). Clip compile
 * errors and an unknown clip are issues (kind `clips`); frames are still taken when the clip exists.
 */
async function clipFrames(entry: SceneEntry, name: string, times: number[]): Promise<{ frames: { t: number; png: string }[]; issues: ViewIssue[] }> {
  const issues: ViewIssue[] = [];
  const scene = session?.scene;
  if (!session || !scene || !session.animBackend) return { frames: [], issues: [{ level: 'error', kind: 'clips', message: coded('E_ANIM_PLAY', `clip ${name}: the scene is not mounted`) }] };
  const md: Record<string, string> = {};
  for (const f of clipFiles(folderFiles, entry.id)) md[f] = (await text(f)) ?? '';
  const compiled = compileSceneClips(md, session.tree);
  compiled.errors.forEach((m) => issues.push({ level: 'error', kind: 'clips', message: m }));
  const clip = compiled.clips.find((c) => c.name === name);
  if (!clip) {
    const have = compiled.clips.map((c) => c.name).join(', ') || '—';
    issues.push({ level: 'error', kind: 'clips', message: coded('E_ANIM_UNKNOWN', `the scene has no clip "${name}" (clips: ${have}; files: ${Object.keys(md).join(', ') || '—'})`) });
    return { frames: [], issues };
  }
  // 2.2: the module's onClipTime — what lives next to the clip (effects fired by markers) catches up
  const onClipTime = runtime?.config.onClipTime;
  const player = new ClipPlayer(scene, session.animBackend, {
    onTime: onClipTime
      ? (time) => {
          try {
            onClipTime({ id: entry.id, scene, ...time });
          } catch (e) {
            issues.push({ level: 'error', kind: 'component', message: coded('E_VIEW_MODULE', `view module onClipTime(): ${msg(e)}`) });
          }
        }
      : undefined,
  });
  player.loop = false; // a time past the end shows the last frame
  const frames: { t: number; png: string }[] = [];
  try {
    player.select(clip);
    for (const t of times) {
      player.seek(t);
      try {
        await session.animBackend.whenReady?.(); // textures a view / tex key switched to
      } catch (e) {
        issues.push({ level: 'error', kind: 'asset', message: msg(e) });
      }
      frames.push({ t, png: await snapshot() });
    }
  } catch (e) {
    issues.push({ level: 'error', kind: 'clips', message: within(`clip ${name}`, /^[EW]_[A-Z0-9_]+: /.test(msg(e)) ? msg(e) : coded('E_ANIM_PLAY', msg(e))) });
  }
  return { frames, issues };
}

function exposeApi(): void {
  window.tmlView = {
    scenes: () => scenes,
    async open(id, opts = {}) {
      const entry = scenes.find((s) => s.id === id);
      if (!entry) throw new Error(`no scene "${id}" in the folder; scenes: ${scenes.map((s) => s.id).join(', ') || '—'}`);
      if (opts.viewport) viewport = parseViewport(opts.viewport);
      if (opts.state != null) {
        stateText = opts.state;
        stateDirty = true;
        ($('state') as HTMLTextAreaElement).value = stateText;
      }
      await opening;
      await open(entry, { keepState: opts.state != null });
      const f = fit ?? { width: 0, height: 0 };
      return { id, width: f.width, height: f.height, viewport: viewportLabel(viewport), stubs: session?.stubs ?? [] };
    },
    async snap(opts = {}) {
      if (current && opts.clip) {
        const { frames, issues } = await clipFrames(current, opts.clip, opts.t?.length ? opts.t : [0]);
        return { issues: [...allIssues(), ...issues], png: frames[0]?.png ?? (await snapshot()), frames };
      }
      return { issues: allIssues(), png: await snapshot() };
    },
  };
}

// ---- boot ---------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  await Promise.all([initPixi(), loadList().then(loadModule)]);
  bindControls();
  exposeApi();
  if (params.has('headless')) return; // the shot drives the page
  const wanted = scenes.find((s) => s.id === params.get('scene'));
  setMode(mode, wanted);

  import.meta.hot?.on('tml:changed', async () => {
    await loadList();
    if (mode === 'gallery') setMode('gallery');
    else if (current) void reopen();
  });
}

void boot();
