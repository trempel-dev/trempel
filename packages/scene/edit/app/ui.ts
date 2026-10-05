// ui.ts — the page around the editor: scene list, toolbar, errors and log, context menu, dialog,
// hot keys (keymap.ts: the blender / figma schemes), the stage's pointer (click = hit-test select,
// a drag on the selection = the G operator; space+drag = pan; wheel+⌘ = zoom), the modal operators
// (ops.ts) and their gizmo (gizmo.ts), the F3 command palette. Host-agnostic: the dev page
// (main.ts) and any host of `@trempel/scene/edit` call mountEditor() with their SceneIO.

import { parseViewport, viewportLabel } from '../../view/viewport';
import { coded, codeOf, within } from '../../src/core.js';
import { createStageRuntime, loadViewModule } from '../../view/runtime';
import type { ViewIssue } from '../../view/session';
import { commands } from '../../editor/index.js';
import { apply, invert, parentPath, mapBox, nodeWorld, type Call } from '../geometry';
import { hitTest } from '../hittest';
import { IMAGE_EXT, type SceneIO } from '../io';
import { Clips } from './clips';
import { mountClipsPanel, shotBackground } from './clipspanel';
import { ConsolePanel } from './console';
import { createTml, MACRO_DIR } from './tml';
import { openPalette, paletteOpen } from './palette';
import { commandFormOpen, openCommandForm, openCommandPalette, type CommandEntry } from './commandpalette';
import { actionOf, keyHint, loadScheme, saveScheme, type Action, type KeymapScheme } from './keymap';
import { Gizmo } from './gizmo';
import { Operators } from './ops';
import { Editor, ZOOM_MAX, ZOOM_MIN } from './editor';
import { Inspector } from './inspector';
import { PREFAB_MIME, PrefabPalette } from './prefabs';
import { Overlay } from './overlay';
import { PathTool } from './pathtool';
import { Reference } from './reference';
import { scenePixels, scenePng, stamp, viewBoxOf } from './snapshot';
import { Tree } from './tree';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const h = (tag: string, cls = '', text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** The page API the e2e tests and hosts drive (the same objects the UI uses). */
declare global {
  interface Window {
    tmlEdit?: Editor;
    /** The modal operators (G/R/S, pivot) and the gizmo (e2e). */
    tmlOps?: Operators;
    tmlGizmo?: Gizmo;
    tmlPrefabs?: PrefabPalette;
  }
}

export interface MountOptions {
  io: SceneIO;
  /** The folder's trempel.view.ts (dev: the virtual module); none — the bare runtime. */
  loadModule?: () => Promise<{ default: unknown }>;
  /** Scene to open first (id), else the first one. */
  scene?: string;
  /** The view to start with (from the URL): zoom (null — fit) and pan. */
  view?: { zoom: number | null; offset: { x: number; y: number } };
}

/** Dialog with buttons; resolves the index of the pressed one (Esc — the last). */
function confirmDialog(text: string, buttons: string[]): Promise<number> {
  return new Promise((resolve) => {
    $('dialog-text').textContent = text;
    const row = $('dialog-buttons');
    row.replaceChildren();
    const done = (k: number): void => {
      $('dialog').hidden = true;
      window.removeEventListener('keydown', esc, true);
      resolve(k);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(buttons.length - 1);
      }
    };
    buttons.forEach((b, i) => {
      const btn = h('button', i === 0 ? 'on' : '', b) as HTMLButtonElement;
      btn.dataset.k = String(i);
      btn.onclick = () => done(i);
      row.append(btn);
    });
    window.addEventListener('keydown', esc, true);
    $('dialog').hidden = false;
  });
}

export async function mountEditor(opts: MountOptions): Promise<Editor> {
  const { config, issue } = opts.loadModule ? await loadViewModule(opts.loadModule) : { config: {}, issue: null };
  const runtime = createStageRuntime(config, issue, opts.io.folderUrl(), opts.io.assetUrl?.bind(opts.io));
  const ed = new Editor(opts.io, runtime, { confirm: confirmDialog });
  await ed.init($('canvas-slot'));

  const wrap = $('stage-wrap');
  const box = $('stage-box');
  const area = (): void => {
    ed.area = { w: wrap.clientWidth, h: wrap.clientHeight };
  };
  area();
  new ResizeObserver(() => {
    area();
    ed.layout();
  }).observe(wrap);

  const overlay = new Overlay(ed, $('overlay') as unknown as SVGSVGElement);
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = box.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // modal operators G/R/S (+ the pivot) and the gizmo that starts them
  const ops = new Operators(ed, $('opstatus'), local);
  const gizmo = new Gizmo(ed, $('gizmo') as unknown as SVGSVGElement, ops, local);
  window.tmlOps = ops;
  window.tmlGizmo = gizmo;
  const pathTool = new PathTool(ed, $('pathtool') as unknown as SVGSVGElement);
  const menu = contextMenu(ed);
  new Tree(ed, $('tree'), menu);
  // href «…»: the host's native picker, else the folder's images in a palette (dev server)
  const pickImage = async (): Promise<string | null> => {
    if (opts.io.pick) return opts.io.pick({ title: 'Image', extensions: IMAGE_EXT });
    const sceneFiles = new Set(ed.scenes.flatMap((s) => [s.base, s.heir]).filter(Boolean));
    const files = ed.listing.files.filter((f) => IMAGE_EXT.includes(f.slice(f.lastIndexOf('.') + 1).toLowerCase()) && !sceneFiles.has(f));
    return openPalette({ placeholder: 'Image from the scene folder…', items: files.map((f) => ({ label: f, value: f })), empty: 'no images in the scene folder' });
  };
  // v0.9: an instance's href — a scene of the folder
  const pickScene = async (): Promise<string | null> =>
    openPalette({ placeholder: 'Prefab — a scene of the folder…', items: ed.prefabCandidates().map((f) => ({ label: f, value: f })), empty: 'no other scenes in the folder' });
  new Inspector(ed, $('inspector'), $('insp-what'), pickImage, pickScene, () => ops.pickPivot());
  // v0.9: the prefab palette (⌘P) — cards dragged onto the stage become instances
  const prefabs = new PrefabPalette(ed, config.prefabs ?? []);
  window.tmlPrefabs = prefabs;

  // ---- batch 2: clips, the reference layer, «снимок для видео» ------------------------------
  const clips = new Clips(ed);
  const reference = new Reference(ed, opts.io);
  /** PNG of the rest pose at 1:1 → renders/<scene>-<stamp>.png (a host that writes text only — a download). */
  const snapshot = async (background: string | null | undefined): Promise<string> => {
    const entry = ed.entry;
    if (!entry || !ed.doc) throw new Error(coded('E_EDIT_NO_SCENE', 'no scene is open'));
    await clips.stop();
    await ed.idle();
    const bytes = await scenePng(ed, background === undefined ? shotBackground() : background);
    const dir = entry.id.includes('/') ? entry.id.slice(0, entry.id.lastIndexOf('/') + 1) : '';
    const stem = entry.id.slice(dir.length);
    const file = `${dir}renders/${stem}-${stamp()}.png`;
    try {
      await opts.io.write(file, bytes);
      ed.log('info', `video snapshot: ${file}`);
      return file;
    } catch (e) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
      a.download = file.slice(file.lastIndexOf('/') + 1);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      ed.log('warn', coded('W_EDIT_SNAPSHOT', `the snapshot was not written to the folder (${e instanceof Error ? e.message : String(e)}) — downloaded instead: ${a.download}`));
      return a.download;
    }
  };
  mountClipsPanel(clips, () => {
    snapshot(undefined).catch((e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      ed.log('error', within('video snapshot', codeOf(m) ? m : coded('E_EDIT_SNAPSHOT', m)));
    });
  });
  ed.on('readonly', () => {
    const ro = $('readonly');
    ro.hidden = !ed.readOnly;
    ro.textContent = ed.readOnly ?? '';
    ro.title = ed.readOnly ?? '';
  });
  // reference controls: «эталон…» picks a picture of the folder, ✕ turns it off
  const refSync = (): void => {
    const on = !!reference.state.file;
    ($('ref-opacity') as HTMLInputElement).value = String(reference.state.opacity);
    ($('ref-over') as HTMLInputElement).checked = reference.state.over;
    $('ref-opacity').hidden = !on;
    $('ref-over-label').hidden = !on;
    $('ref-off').hidden = !on;
    $('ref-pick').textContent = on ? 'reference ●' : 'reference…';
    $('ref-pick').title = on ? `reference: ${reference.state.file} — pick another` : 'Reference: a picture under the scene, fitted to its viewBox (not written to the file)';
  };
  reference.onChange(refSync);
  $('ref-pick').onclick = async () => {
    const file = await pickImage();
    if (file) await reference.set({ file });
  };
  $('ref-off').onclick = () => void reference.set({ file: null });
  ($('ref-opacity') as HTMLInputElement).oninput = (e) => void reference.set({ opacity: Number((e.target as HTMLInputElement).value) });
  ($('ref-over') as HTMLInputElement).onchange = (e) => void reference.set({ over: (e.target as HTMLInputElement).checked });
  refSync();
  (window as unknown as { tmlClips?: Clips }).tmlClips = clips;
  (window as unknown as { tmlReference?: Reference }).tmlReference = reference;

  // ---- tml: the scripting object, the console tab, macros (⌘K) -------------------------------
  const cons = new ConsolePanel($('console-out'), $('console-in') as HTMLTextAreaElement);
  const tml = createTml(ed, opts.io, cons, {
    clips,
    reference,
    viewBox: () => viewBoxOf(ed),
    pixels: async (box) => scenePixels(ed, { box, background: runtime.config.background ?? '#18181c' }),
    snapshot,
  });
  cons.tml = tml;
  window.tml = tml;
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#bottom-tabs .tab')];
  const showTab = (name: string): void => {
    for (const t of tabs) t.classList.toggle('on', t.dataset.tab === name);
    $('pane-log').hidden = name !== 'log';
    $('pane-console').hidden = name !== 'console';
    $('pane-clips').hidden = name !== 'clips';
    if (name === 'console') ($('console-in') as HTMLTextAreaElement).focus();
  };
  for (const t of tabs) t.onclick = () => showTab(t.dataset.tab!);
  const runMacro = async (): Promise<void> => {
    const list = await tml.macros.reload();
    const name = await openPalette({
      placeholder: 'Macro…',
      items: list.map((m) => ({ label: m.title, hint: m.file, value: m.name })),
      empty: `no macros — put .js files into ${MACRO_DIR}/ of the scene folder`,
    });
    const m = list.find((x) => x.name === name);
    if (!m) return;
    cons.print('input', [`macro "${m.title}"`]);
    const ok = await cons.exec(() => tml.macros.run(m.name));
    ed.log(ok ? 'info' : 'error', ok ? `macro "${m.title}"` : coded('E_EDIT_SCRIPT', `macro "${m.title}" failed — see the Console`));
  };
  $('macros').onclick = () => void runMacro();
  window.addEventListener('beforeunload', (e) => {
    if (!ed.doc?.dirty) return;
    e.preventDefault();
    e.returnValue = ''; // the browser asks «leave the page?»
  });

  // ---- layout of the stage box -------------------------------------------------------------
  // the box fills the stage area (overlays and handles in its px); the canvas sits at the view's origin
  const slot = $('canvas-slot');
  ed.on('layout', () => {
    const z = ed.zoomValue();
    const o = ed.origin();
    slot.style.transform = `translate(${o.x}px, ${o.y}px)`;
    $('size').textContent = `${ed.fit.width}×${ed.fit.height} · ${Math.round(z * 100)}%`;
  });

  // ---- scene list, issues, log, toolbar state ----------------------------------------------
  let store = '';
  ed.on('scenes', () => {
    if (ed.listing.name && ed.listing.name !== store) cons.useStore((store = ed.listing.name));
    $('folder').textContent = `${ed.listing.name}${ed.listing.module ? ` · ${ed.listing.module}` : ''}${ed.listing.writable ? '' : ' · read-only'}`;
    const ul = $('scenes');
    ul.replaceChildren();
    for (const s of ed.scenes) {
      const li = h('li', s.id === ed.entry?.id ? 'on' : '');
      li.append(h('span', '', s.id));
      li.append(h('span', 'parts', [s.base ? 'svg' : '', s.heir ? 'tml' : '', s.contract ? 'contract' : '', s.state ? 'state' : ''].filter(Boolean).join(' · ')));
      li.onclick = () => void ed.openScene(s);
      ul.append(li);
    }
    $('empty').hidden = ed.scenes.length > 0;
    $('empty').textContent = ed.scenes.length ? '' : 'No scenes in the folder (X.svg).';
  });
  const renderIssues = (): void => {
    const list = ed.issues();
    const ul = $('issues');
    ul.replaceChildren();
    if (!list.length) ul.append(h('li', 'ok', ed.doc ? 'no errors' : '—'));
    for (const i of list) {
      const li = h('li', `${i.level}${i.id ? ' link' : ''}`);
      li.append(h('span', 'kind', i.kind), document.createTextNode(i.message));
      const clipName = i.kind === 'clips' ? /\$clip (\S+)/.exec(i.message)?.[1] : undefined;
      if (clipName && clips.list.some((c) => c.name === clipName)) {
        li.classList.add('link');
        li.title = `open clip ${clipName} in the Clips panel`;
        li.onclick = () => {
          showTab('clips');
          try {
            clips.select(clipName);
          } catch (e) {
            ed.log('error', e instanceof Error ? e.message : String(e));
          }
        };
      } else if (i.kind === 'clips') {
        li.classList.add('link');
        li.title = 'the Clips panel';
        li.onclick = () => showTab('clips');
      } else if (i.id) {
        li.title = `select #${i.id}`;
        li.onclick = () => {
          const p = ed.pathOfId(i.id!);
          if (p != null) ed.select([p], { scope: parentPath(p) });
        };
      }
      ul.append(li);
    }
    const errors = list.filter((x: ViewIssue) => x.level === 'error').length;
    const badge = $('issue-count');
    badge.className = `badge${errors ? ' err' : list.length ? ' warn' : ''}`;
    badge.textContent = errors ? String(errors) : list.length ? String(list.length) : 'ok';
  };
  ed.on('issues', renderIssues);
  ed.on('render', renderIssues);
  ed.on('log', () => {
    const ol = $('log');
    ol.replaceChildren();
    for (const l of [...ed.logs].reverse().slice(0, 120)) ol.append(h('li', l.level, l.text));
  });
  $('clear-log').onclick = () => {
    if (!$('pane-console').hidden) return cons.clear();
    ed.logs = [];
    ed.emit('log');
  };
  const syncDoc = (): void => {
    $('dirty').hidden = !ed.doc?.dirty;
    $('scene-name').textContent = ed.entry?.id ?? '';
    $('scene-dirty').hidden = !ed.doc?.dirty;
    ($('undo') as HTMLButtonElement).disabled = !ed.doc?.canUndo;
    ($('redo') as HTMLButtonElement).disabled = !ed.doc?.canRedo;
    ($('save') as HTMLButtonElement).disabled = !ed.doc || !ed.listing.writable;
    document.title = `${ed.doc?.dirty ? '● ' : ''}${ed.entry?.id ?? 'Trempel edit'} — Trempel edit`;
  };
  ed.on('doc', syncDoc);
  // a heir without its own base: «наследник от ui/button — база правится там» + open it
  const syncNoBase = (): void => {
    const nb = $('nobase');
    const info = ed.noBase;
    nb.hidden = !info;
    nb.replaceChildren();
    if (!info) return;
    nb.append(h('span', '', 'heir of '), h('code', '', info.extends.replace(/\.svg$/, '')), h('span', 'muted', ' — the base is edited there'));
    if (info.scene) {
      const b = h('button', 'on', 'open') as HTMLButtonElement;
      b.onclick = () => {
        const s = ed.scenes.find((x) => x.id === info.scene);
        if (s) void ed.openScene(s);
      };
      nb.append(b);
    } else nb.append(h('span', 'muted', '(not in the open folder)'));
  };
  ed.on('doc', syncNoBase);
  ed.on('render', syncDoc);
  ed.on('tool', () => {
    $('tool-select').classList.toggle('on', ed.tool === 'select');
    $('tool-path').classList.toggle('on', ed.tool === 'path');
  });

  $('tool-select').onclick = () => ed.setTool('select');
  $('tool-path').onclick = () => ed.setTool('path');
  $('undo').onclick = () => ed.undo();
  $('redo').onclick = () => ed.redo();
  $('save').onclick = () => void ed.save();
  ($('service') as HTMLInputElement).onchange = (e) => {
    ed.showService = (e.target as HTMLInputElement).checked;
    overlay.draw();
  };
  const vp = $('viewport') as HTMLSelectElement;
  vp.onchange = () => {
    ed.viewport = parseViewport(vp.value);
    void ed.render();
  };
  const zoomBy = (k: number, at?: { x: number; y: number }): void => ed.setZoom(ed.zoomValue() * k, at);
  $('zoom-in').onclick = () => zoomBy(1.25);
  $('zoom-out').onclick = () => zoomBy(1 / 1.25);
  $('zoom-fit').onclick = () => ed.setZoom(null);
  $('zoom-100').onclick = () => ed.setZoom(1);

  // ---- stage pointer: select + drag, hover, pan, zoom ----------------------------------------
  // The view moves, the stage never scrolls (Figma on a Mac): two-finger scroll / wheel — pan
  // (Shift — horizontal), pinch (wheel + ctrlKey, as macOS sends it) and ⌘+wheel — zoom to the
  // cursor; space+drag or the middle button — pan.
  let space = false;
  let pan: { x: number; y: number } | null = null;
  /** A press on the selection: moving past 3 px starts G (a drag), a click does nothing. */
  let press: { x: number; y: number; at: { x: number; y: number } } | null = null;
  const scenePoint = (e: MouseEvent): { x: number; y: number } => apply(invert(ed.view()), local(e));
  // capture: pan wins over the handles, the path tool and the service shapes
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (!(space || e.button === 1)) return;
      pan = { x: e.clientX, y: e.clientY };
      wrap.classList.add('panning');
      wrap.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || ed.tool !== 'select' || ed.readOnly) return; // a clip poses the stage: read-only
    const t = e.target as Element;
    if (t.closest('.gz, .service')) return; // the gizmo / service shapes handle it
    const tree = ed.hitTree();
    if (!tree) return;
    const hit = hitTest(tree, scenePoint(e), { scope: ed.scope, skip: ed.skipped });
    if (!hit) {
      if (!e.shiftKey) ed.select([]);
      return;
    }
    // Click selects; a drag moves only what is already selected (one press never both selects
    // and moves — a click that slides a pixel would otherwise displace the node).
    if (e.shiftKey) ed.select([hit.path], { add: true, scope: hit.scope });
    else if (!ed.selection.includes(hit.path)) ed.select([hit.path], { scope: hit.scope });
    else press = { x: e.clientX, y: e.clientY, at: local(e) };
  });
  wrap.addEventListener('dblclick', (e) => {
    if (ed.tool !== 'select' || ed.readOnly || ops.active) return;
    if ((e.target as Element).closest('.gz, .service')) return;
    const sel = ed.selection[ed.selection.length - 1];
    const n = sel != null ? ed.node(sel) : null;
    if (sel == null || !n) return;
    if (n.tag === 'path' || n.tag === 'line') ed.setTool('path');
    else if (n.tag === 'use') void ed.openPrefab(sel); // v0.9: an instance opens its prefab
    else if (n.tag === 'g') {
      ed.enterScope(sel);
      const tree = ed.hitTree();
      const hit = tree ? hitTest(tree, scenePoint(e), { scope: sel, skip: ed.skipped }) : null;
      if (hit) ed.select([hit.path], { scope: hit.scope });
    }
  });
  window.addEventListener('pointerup', () => {
    press = null;
  });
  wrap.addEventListener('pointermove', (e) => {
    ops.pointer = local(e);
    if (pan) {
      ed.panBy(e.clientX - pan.x, e.clientY - pan.y);
      pan = { x: e.clientX, y: e.clientY };
      return;
    }
    if (press && e.buttons & 1) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 3) {
        const at = press.at;
        press = null;
        if (ops.start('G', { drag: true, at })) ops.pointerMove(e);
      }
      return;
    }
    if (ed.tool !== 'select' || e.buttons || ed.readOnly || ops.active) return;
    const tree = ed.hitTree();
    const hit = tree ? hitTest(tree, scenePoint(e), { scope: ed.scope, skip: ed.skipped }) : null;
    overlay.setHover(hit?.path ?? null);
  });
  const panEnd = (e: PointerEvent): void => {
    if (!pan) return;
    pan = null;
    wrap.classList.remove('panning');
    if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
  };
  wrap.addEventListener('pointerup', panEnd);
  wrap.addEventListener('pointercancel', panEnd);
  wrap.addEventListener('pointerleave', () => overlay.setHover(null));
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault(); // no page zoom, no history swipe
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? wrap.clientHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        zoomBy(Math.min(2, Math.max(0.5, Math.exp(-dy * 0.01))), local(e));
        return;
      }
      if (e.shiftKey && !dx) ed.panBy(-dy, 0);
      else ed.panBy(-dx, -dy);
    },
    { passive: false },
  );
  // v0.9: a palette card dropped on the stage → an instance at that point
  wrap.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes(PREFAB_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  wrap.addEventListener('drop', (e) => {
    const p = e.dataTransfer?.getData(PREFAB_MIME);
    if (!p) return;
    e.preventDefault();
    if (ed.readOnly) {
      ed.log('warn', coded('W_EDIT_READ_ONLY', `the scene is read-only: ${ed.readOnly}`));
      return;
    }
    void prefabs.place(p, scenePoint(e));
  });
  wrap.addEventListener('contextmenu', (e) => {
    if (!ed.selection.length) return;
    e.preventDefault();
    menu(e.clientX, e.clientY);
  });

  // ---- keys ------------------------------------------------------------------------------------
  const setSpace = (on: boolean): void => {
    space = on;
    wrap.classList.toggle('space', on);
  };
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') setSpace(false);
  });
  window.addEventListener('blur', () => setSpace(false));
  // the keymap scheme: blender (default) / figma — a setting of the page
  let scheme: KeymapScheme = loadScheme();
  const schemeSel = $('keymap') as HTMLSelectElement;
  schemeSel.value = scheme;
  schemeSel.onchange = () => {
    scheme = schemeSel.value === 'figma' ? 'figma' : 'blender';
    saveScheme(scheme);
    hints();
  };
  const hints = (): void => {
    $('tool-select').title = `Select${scheme === 'figma' ? ' (V)' : ''}`;
    $('tool-path').title = `Contour (${keyHint('tool.path', scheme, isMac)}) — a path or a line`;
    $('commands').title = `Command palette (${keyHint('palette.commands', scheme, isMac)})`;
  };
  hints();

  // F3: the registry's commands, the operators and the macros; a command with arguments — a form
  const runCommandPalette = async (): Promise<void> => {
    const macros = await tml.macros.list().catch(() => []);
    const extra: CommandEntry[] = [
      { value: 'op:G', label: 'G — move', hint: 'operator: X/Y axis, a number, Enter' },
      { value: 'op:R', label: 'R — rotate', hint: 'operator about the pivot' },
      { value: 'op:S', label: 'S — scale', hint: 'operator from the pivot' },
      { value: 'op:.', label: '. — pivot to a point', hint: 'a click on the stage (node.setPivot keepWorld)' },
      { value: 'op:ctrl+.', label: 'Ctrl+. — pivot to the centre', hint: 'the bounds centre of the selection' },
      ...macros.map((m) => ({ value: `macro:${m.name}`, label: `macro: ${m.title}`, hint: m.file })),
    ];
    const pick = await openCommandPalette(commands, extra);
    if (!pick) return;
    if (pick.startsWith('op:')) {
      const k = pick.slice(3);
      if (k === '.') ops.pickPivot();
      else if (k === 'ctrl+.') ops.pivotToCentre();
      else ops.start(k as 'G' | 'R' | 'S');
      return;
    }
    if (pick.startsWith('macro:')) {
      const m = macros.find((x) => x.name === pick.slice(6));
      if (!m) return;
      cons.print('input', [`macro "${m.title}"`]);
      const ok = await cons.exec(() => tml.macros.run(m.name));
      ed.log(ok ? 'info' : 'error', ok ? `macro "${m.title}"` : coded('E_EDIT_SCRIPT', `macro "${m.title}" failed — see the Console`));
      return;
    }
    const c = commands[pick as keyof typeof commands];
    if (!c) return;
    const props = Object.keys(c.schema.properties ?? {});
    const sel = ed.selection.length ? ed.ref(ed.selection[ed.selection.length - 1]) : undefined;
    const defaults: Record<string, unknown> = {};
    if (props.includes('node') && sel != null) defaults.node = sel;
    const args = props.length ? await openCommandForm(pick, c.describe, c.schema, defaults) : {};
    if (!args) return;
    const r = ed.exec(pick, args);
    if (r?.ok) ed.log('info', `${pick} — done`);
  };
  $('commands').onclick = () => void runCommandPalette();

  /** Edits from the stage keys are off while a clip poses the stage. */
  const EDITS = new Set<Action>(['op.move', 'op.rotate', 'op.scale', 'pivot.pick', 'pivot.centre', 'node.duplicate', 'node.remove', 'nudge.left', 'nudge.right', 'nudge.up', 'nudge.down', 'nudge.left10', 'nudge.right10', 'nudge.up10', 'nudge.down10']);
  const NUDGE: Partial<Record<Action, [number, number]>> = {
    'nudge.left': [-1, 0], 'nudge.right': [1, 0], 'nudge.up': [0, -1], 'nudge.down': [0, 1],
    'nudge.left10': [-10, 0], 'nudge.right10': [10, 0], 'nudge.up10': [0, -10], 'nudge.down10': [0, 10],
  };
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (ops.active) return; // the operator takes the keys itself (capture)
    if (paletteOpen() || commandFormOpen() || !$('dialog').hidden) return;
    const action = actionOf(e, scheme, isMac);
    // palettes — also from a text field
    if (action === 'palette.macros' || action === 'palette.prefabs' || action === 'palette.commands') {
      e.preventDefault(); // not the browser's print / search
      if (action === 'palette.macros') void runMacro();
      else if (action === 'palette.prefabs') prefabs.toggle();
      else void runCommandPalette();
      return;
    }
    if (t.closest('input, textarea, select')) return;
    if (e.key === ' ') {
      if (!space) setSpace(true);
      if (t === document.body) e.preventDefault();
      return;
    }
    if (action === 'save' || action === 'undo' || action === 'redo' || action === 'zoom.fit' || action === 'zoom.100') {
      e.preventDefault();
      if (action === 'save') void ed.save();
      else if (action === 'undo') ed.undo();
      else if (action === 'redo') ed.redo();
      else ed.setZoom(action === 'zoom.fit' ? null : 1);
      return;
    }
    // the path tool's own keys (Delete a point, C / O, Esc / Enter / Tab — leave)
    if (ed.tool === 'path') {
      if (action === 'tool.path' && scheme === 'blender') {
        e.preventDefault();
        ed.setTool('select');
        return;
      }
      if (pathTool.key(e)) {
        e.preventDefault();
        return;
      }
    }
    if (!action) return;
    if (ed.readOnly && EDITS.has(action)) return; // a clip poses the stage (⏹ in the panel returns the rest pose)
    e.preventDefault();
    const nudge = NUDGE[action];
    if (nudge) {
      actions(ed).nudge(nudge[0], nudge[1]);
      return;
    }
    switch (action) {
      case 'op.move':
        ops.start('G');
        break;
      case 'op.rotate':
        ops.start('R');
        break;
      case 'op.scale':
        ops.start('S');
        break;
      case 'pivot.pick':
        ops.pickPivot();
        break;
      case 'pivot.centre':
        ops.pivotToCentre();
        break;
      case 'tool.select':
        ed.setTool('select');
        break;
      case 'tool.path': {
        // Tab (blender): into the group / the path's contour / the instance's prefab
        const sel = ed.selection.length === 1 ? ed.selection[0] : null;
        const n = sel != null ? ed.node(sel) : null;
        if (scheme === 'blender' && sel != null && (n?.tag === 'g' || n?.tag === 'use')) ed.enterScope(sel);
        else ed.setTool('path');
        break;
      }
      case 'scope.exit':
        ed.exitScope();
        break;
      case 'scope.enter':
        if (ed.selection.length === 1) {
          const n = ed.node(ed.selection[0]);
          if (n?.tag === 'g' || n?.tag === 'use') ed.enterScope(ed.selection[0]);
        }
        break;
      case 'node.duplicate':
        actions(ed).duplicate();
        break;
      case 'node.remove':
        actions(ed).remove();
        break;
      case 'node.hide':
        for (const p of ed.selection) if (!ed.hidden.has(p)) ed.toggleHidden(p);
        ed.select([]);
        break;
      case 'node.unhideAll':
        for (const p of [...ed.hidden]) ed.toggleHidden(p);
        break;
      case 'select.all': {
        const scope = ed.scope;
        const kids = ed.node(scope)?.children ?? [];
        const paths = kids.map((_, i) => (scope === '' ? String(i) : `${scope}/${i}`)).filter((p) => !ed.skipped(p) && !['defs', 'clipPath'].includes(ed.node(p)?.tag ?? ''));
        ed.select(paths, { scope });
        break;
      }
      case 'select.none':
        ed.select([]);
        break;
      case 'zoom.in':
        zoomBy(1.25);
        break;
      case 'zoom.out':
        zoomBy(1 / 1.25);
        break;
      default:
        break;
    }
  });

  // ---- go ---------------------------------------------------------------------------------------
  if (opts.view) {
    ed.zoom = opts.view.zoom == null ? null : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, opts.view.zoom));
    ed.offset = { ...opts.view.offset };
  }
  await ed.loadFolder();
  const first = ed.scenes.find((s) => s.id === opts.scene) ?? ed.scenes.find((s) => s.base && (s.heir || s.contract)) ?? ed.scenes.find((s) => s.base) ?? ed.scenes[0];
  if (first) await ed.openScene(first);
  vp.value = viewportLabel(ed.viewport);
  syncDoc();
  return ed;
}

// ---- actions shared by keys and the context menu -----------------------------------------------

export function actions(ed: Editor) {
  const movable = (): string[] => ed.selection.filter((p) => p !== '' && ed.node(p) && !['defs', 'svg'].includes(ed.node(p)!.tag));
  return {
    /** Arrow keys: a move in scene units, as each node's parent sees it. */
    nudge(dx: number, dy: number): void {
      const doc = ed.doc;
      if (!doc) return;
      const calls: Call[] = [];
      for (const p of movable()) {
        if (ed.node(p)?.tag === 'clipPath') continue;
        try {
          const P = nodeWorld(doc.scene, parentPath(p));
          const v = invert(P);
          const d = { x: v[0] * dx + v[2] * dy, y: v[1] * dx + v[3] * dy };
          calls.push({ name: 'node.move', args: { node: ed.ref(p), dx: Math.round(d.x * 10000) / 10000, dy: Math.round(d.y * 10000) / 10000 } });
        } catch {
          // degenerate parent
        }
      }
      ed.batch('nudge', calls);
    },
    duplicate(): void {
      const sel = movable();
      if (!sel.length) return;
      // later siblings first: earlier paths stay valid
      const sorted = [...sel].sort(comparePaths).reverse();
      const res = ed.batch('duplicate', sorted.map((p) => ({ name: 'node.duplicate', args: { node: ed.ref(p) } })));
      if (res?.ok) {
        // each copy lands right after its original; shift for copies inserted before it among the same parent
        const out = sel.map((p) => {
          const parent = parentPath(p);
          const idx = Number(p.split('/').pop());
          const before = sel.filter((q) => parentPath(q) === parent && Number(q.split('/').pop()) < idx).length;
          const n = idx + 1 + before;
          return parent === '' ? String(n) : `${parent}/${n}`;
        });
        ed.select(out);
      }
    },
    remove(): void {
      const sel = movable();
      if (!sel.length) return;
      const sorted = [...sel].sort(comparePaths).reverse().filter((p, i, all) => !all.some((q, j) => j !== i && p.startsWith(q + '/')));
      const res = ed.batch('delete', sorted.map((p) => ({ name: 'node.remove', args: { node: ed.ref(p) } })));
      if (res?.ok) ed.select([]);
    },
    newGroup(): void {
      const parent = ed.selection.length === 1 && ed.node(ed.selection[0])?.tag === 'g' ? ed.selection[0] : ed.scope;
      const id = freeId(ed, 'layer');
      const res = ed.exec('layer.create', parent === '' ? { id } : { parent: ed.ref(parent), id });
      if (res?.ok) {
        const n = ed.node(parent);
        if (n) ed.select([parent === '' ? String(n.children.length - 1) : `${parent}/${n.children.length - 1}`]);
      }
    },
    /** layer.create at the first selected node's place + reparent each selected into it — one undo. */
    wrap(): void {
      const sel = movable().sort(comparePaths);
      if (!sel.length) return;
      const parent = parentPath(sel[0]);
      if (sel.some((p) => parentPath(p) !== parent)) {
        ed.log('warn', coded('W_EDIT_SELECTION', 'wrap in group: the selected nodes have different parents'));
        return;
      }
      const id = freeId(ed, 'group');
      const index = Number(sel[0].split('/').pop());
      const calls: Call[] = [{ name: 'layer.create', args: parent === '' ? { id, index } : { parent: ed.ref(parent), id, index } }];
      // after the insert the selected nodes moved one down; reparent them by their (shifted) paths, first to last
      sel.forEach((p, i) => {
        const k = Number(p.split('/').pop()) + 1 - i;
        const at = parent === '' ? String(k) : `${parent}/${k}`;
        calls.push({ name: 'node.reparent', args: { node: ed.node(p)?.attrs.id ? ed.ref(p) : at, parent: id } });
      });
      const res = ed.batch('wrap in group', calls);
      if (res?.ok) ed.select([parent === '' ? String(index) : `${parent}/${index}`]);
    },
    /** clip.create rect = the node's bounds in its own space + clip.assign — one undo. */
    maskByBounds(): void {
      const doc = ed.doc;
      if (!doc || ed.selection.length !== 1) return;
      const p = ed.selection[0];
      const n = ed.node(p);
      const b = ed.bounds.get(p);
      if (!n || !b) return;
      if (n.tag !== 'g' && n.tag !== 'image') {
        ed.log('warn', coded('W_EDIT_SELECTION', `mask: clip-path goes on a <g> or an <image>, this is a <${n.tag}> — wrap it in a group`));
        return;
      }
      const local = mapBox(invert(nodeWorld(doc.scene, p)), b);
      const r = (v: number): number => Math.round(v * 100) / 100;
      const id = freeId(ed, `${n.attrs.id ?? 'node'}-clip`);
      ed.batch('mask by bounds', [
        { name: 'clip.create', args: { id, shape: 'rect', attrs: { x: r(local.x), y: r(local.y), width: r(local.w), height: r(local.h) } } },
        { name: 'clip.assign', args: { node: ed.ref(p), clip: id } },
      ]);
    },
    unmask(): void {
      for (const p of ed.selection) if (ed.node(p)?.attrs['clip-path']) ed.exec('clip.assign', { node: ed.ref(p), clip: null });
    },
  };
}

function comparePaths(a: string, b: string): number {
  const x = a.split('/').map(Number);
  const y = b.split('/').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function freeId(ed: Editor, stem: string): string {
  if (ed.pathOfId(stem) == null) return stem;
  for (let k = 2; ; k++) if (ed.pathOfId(`${stem}-${k}`) == null) return `${stem}-${k}`;
}

function contextMenu(ed: Editor): (x: number, y: number) => void {
  const m = $('menu');
  const close = (): void => {
    m.hidden = true;
  };
  window.addEventListener('pointerdown', (e) => {
    if (!m.hidden && !m.contains(e.target as Node)) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !m.hidden) {
      e.stopPropagation();
      close();
    }
  }, true);
  return (x, y) => {
    const a = actions(ed);
    const one = ed.selection.length === 1 ? ed.node(ed.selection[0]) : null;
    const items: [string, () => void, boolean][] = [
      ['Duplicate  ⌘D', a.duplicate, ed.selection.length > 0],
      ['Delete  ⌫', a.remove, ed.selection.length > 0],
      ['New group', a.newGroup, true],
      ['Wrap in group', a.wrap, ed.selection.length > 0],
      ['Mask by bounds', a.maskByBounds, !!one && (one.tag === 'g' || one.tag === 'image') && ed.bounds.has(ed.selection[0])],
      ['Remove mask', a.unmask, ed.selection.some((p) => !!ed.node(p)?.attrs['clip-path'])],
    ];
    m.replaceChildren();
    for (const [label, fn, enabled] of items) {
      const b = h('button', '', label) as HTMLButtonElement;
      b.disabled = !enabled;
      b.onclick = () => {
        close();
        fn();
      };
      m.append(b);
    }
    m.hidden = false;
    m.style.left = `${Math.min(x, innerWidth - 200)}px`;
    m.style.top = `${Math.min(y, innerHeight - 200)}px`;
  };
}

