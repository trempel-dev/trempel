// timeline.ts — 2.3: the Timeline tab (replaces the batch-2 «Clips» panel and keeps all it did: the
// clip list, ▶ ⏸ ⏹, loop, speed, onion, «снимок для видео»).
//
// What the md clip holds, drawn: an events lane on top ($events; `fx:` markers with the effect
// icon), then a track per `## $track` unfolded into a row per column (x, rotation, alpha, tex…).
// A key is a diamond; `step` — a square; a clip parameter (`$name`) — a diamond with its name.
// Everything the timeline changes is a clip command of the core (editor/clips.ts) on the clip
// file's ClipsDocument — in the scene's history, so ⌘Z / ⌘S cover it like the base:
//
//   drag keys / events → key.move / event.move (one step, snapped by the command); Delete →
//   key.remove / event.remove; double-click a column row → key.set (the value the clip shows
//   there); the side panel — a key's value, parameter, ease (named, or a Bézier with two handles);
//   an event's name; a new event / track; the clip — new, rename, duplicate, remove, $duration
//   (the field, or drag the end on the ruler), $loop. ● Rec — see rec.ts.
//
// The playhead poses the scene (the clip panel's player: exact seek; the module's onClipTime —
// effects fired by markers catch up). ←/→ — a frame, ⇧ — 0.1 s (the grid focused).

import { coded, codeOf, type AnimClip } from '../../src/core.js';
import { resolveEase } from '../../src/anim/easing.js';
import { sampleTrack } from '../../src/anim/player.js';
import { FRAME, fmtTime, CLIP_COLUMNS, type ClipInfo, type ClipsDocument, type CommandResult, type KeyRef, type EventRef } from '../../editor/index.js';
import type { Clips } from './clips';
import type { Editor } from './editor';
import { recordCalls } from './rec';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const SVG = 'http://www.w3.org/2000/svg';
const BG_KEY = 'tml-edit:i2v-background';
/** Width of the row labels, px. */
const LABEL = 150;
const EASES = ['linear', 'in', 'out', 'inOut', 'outBack', 'inBack', 'outBounce', 'step', 'quadIn', 'quadOut', 'quadInOut', 'cubicInOut', 'backOut', 'elasticOut'];
/** Column → the compiled property it drives (sampling for a new key). */
const PROP: Record<string, string> = { scale: 'scale.x', scaleX: 'scale.x', scaleY: 'scale.y', skewX: 'skew.x', skewY: 'skew.y', dash: 'stroke-dashoffset', strokeWidth: 'stroke-width', strokeAlpha: 'stroke-opacity', tex: 'href', view: 'href' };
const DEG = new Set(['rotation', 'skewX', 'skewY']);

export interface ShotSetting {
  color: string;
  transparent: boolean;
}

/** The «снимок для видео» background setting (null — transparent). */
export function shotBackground(): string | null {
  const t = ($('shot-transparent') as HTMLInputElement | null)?.checked;
  return t ? null : (($('shot-bg') as HTMLInputElement | null)?.value ?? '#ffffff');
}

const sameT = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;
const keyId = (k: KeyRef): string => `${k.target}\u0000${k.column}\u0000${fmtTime(k.t)}`;
const evId = (e: EventRef): string => `${fmtTime(e.t)}\u0000${e.event}`;

/** A small modal text prompt (resolves null on Esc / Cancel). */
export function ask(title: string, initial = '', hint = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const root = h('div', 'tl-ask');
    const box = h('div', 'box');
    const input = h('input');
    input.value = initial;
    input.spellcheck = false;
    const ok = h('button', 'on', 'OK');
    const cancel = h('button', '', 'Cancel');
    box.append(h('div', '', title), input, ...(hint ? [h('div', 'muted', hint)] : []), h('div', 'row'));
    box.lastElementChild!.append(ok, cancel);
    root.append(box);
    document.body.append(root);
    const done = (v: string | null): void => {
      root.remove();
      resolve(v);
    };
    ok.onclick = () => done(input.value.trim() || null);
    cancel.onclick = () => done(null);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    };
    input.focus();
    input.select();
  });
}

export class Timeline {
  /** Selected keys and events (by value: they survive re-renders). */
  keys = new Map<string, KeyRef>();
  events = new Map<string, EventRef>();
  /** Folded tracks (target#index). */
  private folded = new Set<string>();
  /** px per second (0 — fit the clip into the lane width). */
  pps = 0;
  private drag: { kind: 'move'; x0: number; dt: number } | { kind: 'scrub' } | { kind: 'end'; d: number } | { kind: 'box'; x0: number; y0: number; el: HTMLElement } | null = null;

  constructor(
    readonly ed: Editor,
    readonly clips: Clips,
  ) {}

  // ---- the model --------------------------------------------------------------------------------

  /** The clip file's document of the selected clip (null — no clip). */
  get doc(): ClipsDocument | null {
    const c = this.clips.current;
    return c && this.ed.doc ? this.ed.doc.clipsDoc(c.file) : null;
  }

  /** The selected clip as written (tracks, keys by column, events). */
  get info(): ClipInfo | null {
    const c = this.clips.current;
    return c ? (this.doc?.clip(c.name) ?? null) : null;
  }

  /** Run a clip command on the selected clip's file; errors to the log. */
  run(name: string, args: Record<string, unknown>): CommandResult | null {
    const d = this.doc;
    if (!d) {
      this.ed.log('error', coded('E_EDIT_CLIP', 'no clip selected — pick one in the Timeline'));
      return null;
    }
    return this.report(name, d.exec(name, args));
  }

  batch(label: string, calls: { name: string; args: Record<string, unknown> }[]): CommandResult | null {
    const d = this.doc;
    if (!d || !calls.length) return null;
    if (calls.length === 1) return this.run(calls[0].name, calls[0].args);
    return this.report(label, d.batch(label, calls));
  }

  private report(what: string, r: CommandResult): CommandResult {
    if (!r.ok) this.ed.log('error', `${what}: ${(r.errors ?? []).join('; ')}`);
    return r;
  }

  /** The value the clip shows for target.column at t, as a cell (a new key keeps the pose). */
  valueAt(target: string, column: string, t: number): number | string {
    const info = this.info;
    const keys = info?.tracks.find((tr) => tr.target === target && tr.columns.includes(column))?.keys[column] ?? [];
    const before = [...keys].reverse().find((k) => k.t <= t + 1e-9) ?? keys[0];
    const compiled: AnimClip | undefined = this.clips.current?.clip;
    const prop = PROP[column] ?? column;
    const tr = compiled?.tracks.find((x) => x.target === target && x.property === prop);
    if (tr && column !== 'tex' && column !== 'view' && column !== 'tint' && !before?.param) {
      try {
        const v = sampleTrack(tr, t, this.clips.params);
        if (typeof v === 'number' && Number.isFinite(v)) return Math.round((DEG.has(column) ? (v * 180) / Math.PI : v) * 1e4) / 1e4;
      } catch {
        // a parameter not given: the written cell below
      }
    }
    if (before) return before.value;
    return column.startsWith('scale') || column === 'alpha' ? 1 : column === 'tint' ? '#ffffff' : 0;
  }

  /** Clip names → a new clip file for a scene without one (anim/<scene>.md next to it). */
  newClipFile(): string {
    const id = this.ed.entry?.id ?? 'scene';
    const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/') + 1) : '';
    return `${dir}anim/${id.slice(dir.length)}.md`;
  }

  // ---- clip commands of the bar -------------------------------------------------------------------

  async createClip(name?: string): Promise<void> {
    const doc = this.ed.doc;
    if (!doc) return;
    const n = name ?? (await ask('New clip — its name', 'clip'));
    if (!n) return;
    const file = this.clips.current?.file ?? doc.clipFiles()[0] ?? this.newClipFile();
    const d = doc.clipsDoc(file) ?? doc.createClips(file);
    const r = this.report('clip.create', d.exec('clip.create', { name: n, duration: 1 }));
    if (r.ok) await this.selectAfterRender(n);
  }

  private async selectAfterRender(name: string): Promise<void> {
    await this.ed.idle();
    try {
      this.clips.select(name);
    } catch (e) {
      this.ed.log('error', e instanceof Error ? e.message : String(e));
    }
  }

  // ---- mount -------------------------------------------------------------------------------------

  mount(onShot: () => void): void {
    const clips = this.clips;
    const name = $('clip-name') as HTMLSelectElement;
    const num = $('clip-t') as HTMLInputElement;
    const slider = $('clip-time') as HTMLInputElement;
    const dur = $('clip-dur');
    const loop = $('clip-loop') as HTMLInputElement;
    const speed = $('clip-speed') as HTMLSelectElement;
    const onion = $('clip-onion') as HTMLInputElement;
    const delta = $('clip-onion-d') as HTMLInputElement;
    const info = $('clip-info');
    const durAttr = $('clip-duration') as HTMLInputElement;
    const loopAttr = $('clip-loop-attr') as HTMLInputElement;
    const bg = $('shot-bg') as HTMLInputElement;
    const transparent = $('shot-transparent') as HTMLInputElement;
    const grid = $('tl-grid');

    const fail = (e: unknown): void => {
      info.textContent = e instanceof Error ? e.message : String(e);
    };
    const guard = (fn: () => void) => () => {
      try {
        fn();
      } catch (e) {
        fail(e);
      }
    };

    const fillList = (): void => {
      const keep = clips.selected ?? '';
      name.replaceChildren();
      const none = h('option', '', clips.list.length ? '— clip —' : 'no clips');
      none.value = '';
      name.append(none);
      for (const c of clips.list) {
        const o = h('option', '', `${c.name} · ${c.duration.toFixed(2)} s`);
        o.value = c.name;
        o.title = c.file;
        name.append(o);
      }
      name.value = keep;
    };

    const sync = (): void => {
      const c = clips.current;
      const i = this.info;
      name.value = clips.selected ?? '';
      const d = c?.duration ?? 0;
      slider.max = String(d || 1);
      slider.disabled = !c;
      num.disabled = !c;
      dur.textContent = c ? `/ ${d.toFixed(2)} s` : '';
      durAttr.disabled = !c;
      if (document.activeElement !== durAttr) durAttr.value = i?.duration != null ? String(i.duration) : '';
      durAttr.placeholder = c ? d.toFixed(2) : '';
      loopAttr.disabled = !c;
      loopAttr.checked = !!i?.loop;
      loop.checked = clips.loop;
      speed.value = String(clips.speed);
      onion.checked = clips.onion.on;
      $('clip-play').toggleAttribute('disabled', !clips.list.length || clips.playing);
      $('clip-pause').toggleAttribute('disabled', !clips.playing);
      $('clip-stop').toggleAttribute('disabled', !clips.active);
      for (const id of ['clip-rename', 'clip-dup', 'clip-del']) $(id).toggleAttribute('disabled', !c);
      $('clip-new').toggleAttribute('disabled', !this.ed.doc);
      $('clip-rec').classList.toggle('on', clips.rec);
      info.textContent = c
        ? `${c.file}${clips.errors.length ? ` · clip errors: ${clips.errors.length}` : ''}`
        : clips.errors.length
          ? `clip errors: ${clips.errors.length} (see the Errors panel)`
          : '';
      this.params();
      this.draw();
    };
    const tick = (): void => {
      const t = clips.time;
      slider.value = String(t);
      if (document.activeElement !== num) num.value = t.toFixed(2);
      this.placeHead();
    };

    name.onchange = guard(() => {
      this.keys.clear();
      this.events.clear();
      clips.select(name.value || null);
    });
    $('clip-play').onclick = guard(() => clips.play(name.value || undefined));
    $('clip-pause').onclick = guard(() => clips.pause());
    $('clip-stop').onclick = () => void clips.stop();
    $('clip-rec').onclick = () => clips.setRec(!clips.rec);
    slider.oninput = guard(() => clips.seek(Number(slider.value)));
    num.onchange = guard(() => clips.seek(Number(num.value) || 0));
    loop.onchange = () => clips.setLoop(loop.checked);
    speed.onchange = () => clips.setSpeed(Number(speed.value));
    onion.onchange = () => clips.setOnion(onion.checked, Number(delta.value));
    delta.onchange = () => clips.setOnion(onion.checked, Number(delta.value));
    durAttr.onchange = () => {
      const c = clips.selected;
      const v = Number(durAttr.value);
      if (c) this.run('clip.setAttr', { clip: c, name: 'duration', value: durAttr.value.trim() === '' ? null : v });
    };
    loopAttr.onchange = () => {
      const c = clips.selected;
      if (c) this.run('clip.setAttr', { clip: c, name: 'loop', value: loopAttr.checked ? true : null });
    };
    $('clip-new').onclick = () => void this.createClip();
    $('clip-rename').onclick = async () => {
      const c = clips.selected;
      const n = c && (await ask(`Rename clip ${c}`, c));
      if (c && n && n !== c && this.run('clip.rename', { clip: c, name: n })?.ok) await this.selectAfterRender(n);
    };
    $('clip-dup').onclick = async () => {
      const c = clips.selected;
      const n = c && (await ask(`Duplicate clip ${c} as`, `${c}2`));
      if (c && n && this.run('clip.duplicate', { clip: c, name: n })?.ok) await this.selectAfterRender(n);
    };
    $('clip-del').onclick = async () => {
      const c = clips.selected;
      if (!c) return;
      const k = await this.ed.ui.confirm(`Remove clip "${c}" from ${clips.current?.file}?`, ['Remove', 'Cancel']);
      if (k !== 0) return;
      await clips.stop();
      if (this.run('clip.remove', { clip: c })?.ok) clips.select(null);
    };

    // «снимок для видео»: the background setting survives reloads
    try {
      const saved = JSON.parse(localStorage.getItem(BG_KEY) ?? 'null') as ShotSetting | null;
      if (saved) {
        bg.value = saved.color;
        transparent.checked = saved.transparent;
      }
    } catch {
      /* no storage */
    }
    const keep = (): void => {
      bg.disabled = transparent.checked;
      try {
        localStorage.setItem(BG_KEY, JSON.stringify({ color: bg.value, transparent: transparent.checked }));
      } catch {
        /* no storage */
      }
    };
    bg.onchange = keep;
    transparent.onchange = keep;
    bg.disabled = transparent.checked;
    $('shot-take').onclick = onShot;

    // recording: base commands → keys at the playhead
    this.ed.recorder = (label, calls) => {
      const c = clips.current;
      if (!clips.rec || !clips.active || !c || !this.ed.doc) return undefined;
      return recordCalls(
        { doc: this.ed.doc, file: c.file, clip: c.name, compiled: c.clip, t: clips.time, params: clips.params, pathOf: (ref) => this.ed.pathOfId(ref) },
        label,
        calls,
      );
    };

    // the grid: keys, scrub, keyboard
    grid.addEventListener('pointerdown', (e) => this.down(e));
    grid.addEventListener('pointermove', (e) => this.move(e));
    grid.addEventListener('pointerup', (e) => this.up(e));
    grid.addEventListener('dblclick', (e) => this.dbl(e));
    grid.addEventListener('keydown', (e) => this.key(e));
    new ResizeObserver(() => this.draw()).observe(grid);

    clips.on('list', () => {
      fillList();
      sync();
    });
    clips.on('state', sync);
    clips.on('tick', tick);
    this.ed.on('doc', sync);
    fillList();
    sync();
  }

  // ---- drawing -----------------------------------------------------------------------------------

  /** Seconds shown in the lanes (the clip, at least 0.5 s). */
  private span(): number {
    const c = this.clips.current;
    return Math.max(0.5, c?.duration ?? 1);
  }

  private scale(): number {
    const grid = $('tl-grid');
    const w = Math.max(100, grid.clientWidth - LABEL - 24);
    return this.pps || w / this.span();
  }

  private x(t: number): number {
    return LABEL + t * this.scale();
  }

  /** Time under a client x (snapped to a frame). */
  private timeAt(clientX: number, snap = true): number {
    const grid = $('tl-grid');
    const r = grid.getBoundingClientRect();
    const t = Math.max(0, (clientX - r.left + grid.scrollLeft - LABEL) / this.scale());
    return snap ? Math.round(t / FRAME) * FRAME : t;
  }

  private params(): void {
    const box = $('clip-params');
    const names = this.clips.paramNames();
    box.replaceChildren();
    if (!names.length) return;
    box.append(h('span', 'muted', 'params'));
    for (const n of names) {
      const l = h('label', '', `$${n}`);
      const i = h('input');
      i.type = 'number';
      i.step = '1';
      i.value = String(this.clips.params[n] ?? 0);
      i.dataset.param = n;
      i.onchange = () => this.clips.setParam(n, Number(i.value) || 0);
      l.append(i);
      box.append(l);
    }
  }

  draw(): void {
    const grid = $('tl-grid');
    const c = this.clips.current;
    const info = this.info;
    grid.replaceChildren();
    this.side();
    if (!c || !info) {
      grid.append(h('div', 'tl-empty muted', this.clips.list.length ? 'pick a clip' : this.ed.doc ? 'no clips — ＋ makes one' : ''));
      return;
    }
    const span = this.span();
    const width = this.x(span) + 24;
    const inner = h('div', 'tl-inner');
    inner.style.width = `${width}px`;
    // ruler
    const ruler = h('div', 'tl-row tl-ruler');
    ruler.append(h('div', 'tl-label', 'time'));
    const step = span > 6 ? 1 : span > 2 ? 0.5 : span > 1 ? 0.25 : 0.1;
    for (let t = 0; t <= span + 1e-9; t += step) {
      const tick = h('div', 'tl-tick', fmtTime(t));
      tick.style.left = `${this.x(t)}px`;
      ruler.append(tick);
    }
    const end = h('div', 'tl-end');
    end.title = `$duration ${c.duration.toFixed(2)} s — drag to change`;
    end.style.left = `${this.x(c.duration)}px`;
    ruler.append(end);
    inner.append(ruler);
    // events
    const evRow = h('div', 'tl-row tl-events');
    evRow.dataset.lane = 'events';
    evRow.append(h('div', 'tl-label', 'events'));
    for (const ev of info.events) {
      const m = h('div', `tl-ev${ev.event.startsWith('fx:') ? ' fx' : ''}${this.events.has(evId(ev)) ? ' sel' : ''}`);
      m.dataset.t = String(ev.t);
      m.dataset.event = ev.event;
      m.style.left = `${this.x(ev.t)}px`;
      m.title = `${ev.event} · ${fmtTime(ev.t)} s`;
      m.append(h('span', 'icon', ev.event.startsWith('fx:') ? '✦' : '▾'), h('span', 'name', ev.event));
      evRow.append(m);
    }
    inner.append(evRow);
    // tracks
    for (const tr of info.tracks) {
      const fk = `${tr.target}#${tr.index}`;
      const head = h('div', 'tl-row tl-track');
      const label = h('div', 'tl-label');
      const fold = h('span', 'fold', this.folded.has(fk) ? '▸' : '▾');
      fold.onclick = () => {
        if (this.folded.has(fk)) this.folded.delete(fk);
        else this.folded.add(fk);
        this.draw();
      };
      const tgt = h('span', 'target', `#${tr.target}`);
      tgt.title = `select #${tr.target} on the stage; the side panel — the track`;
      tgt.dataset.target = tr.target;
      tgt.onclick = () => {
        const p = this.ed.pathOfId(tr.target);
        if (p != null) this.ed.select([p]);
        this.track = { target: tr.target, index: tr.index };
        this.keys.clear();
        this.events.clear();
        this.side();
      };
      label.append(fold, tgt);
      if (Object.keys(tr.attrs).length) label.title = Object.entries(tr.attrs).map(([k, v]) => `$${k}: ${v}`).join('\n');
      head.append(label);
      // the summary: every key time of the track
      const times = new Map<string, number>();
      for (const col of tr.columns) for (const k of tr.keys[col]) times.set(fmtTime(k.t), k.t);
      for (const t of times.values()) {
        const d = h('div', 'tl-key sum');
        d.style.left = `${this.x(t)}px`;
        head.append(d);
      }
      inner.append(head);
      if (this.folded.has(fk)) continue;
      for (const col of tr.columns) {
        const row = h('div', 'tl-row tl-col');
        row.dataset.target = tr.target;
        row.dataset.column = col;
        row.append(h('div', 'tl-label', col));
        for (const k of tr.keys[col]) {
          const ref: KeyRef = { target: tr.target, column: col, t: k.t };
          const d = h('div', `tl-key${k.ease === 'step' ? ' step' : ''}${k.param ? ' param' : ''}${this.keys.has(keyId(ref)) ? ' sel' : ''}`);
          d.dataset.target = tr.target;
          d.dataset.column = col;
          d.dataset.t = String(k.t);
          d.style.left = `${this.x(k.t)}px`;
          d.title = `${col} = ${k.value} at ${fmtTime(k.t)} s${k.ease ? ` · ${k.ease}` : ''}`;
          if (k.param) d.append(h('span', 'plabel', `$${k.param}`));
          row.append(d);
        }
        inner.append(row);
      }
    }
    const head = h('div', 'tl-head');
    head.id = 'tl-playhead';
    inner.append(head);
    grid.append(inner);
    this.placeHead();
  }

  private placeHead(): void {
    const el = document.getElementById('tl-playhead');
    if (el) el.style.left = `${this.x(this.clips.time)}px`;
  }

  // ---- the side panel ------------------------------------------------------------------------------

  /** A track chosen by its label (the side panel shows its actions). */
  private track: { target: string; index: number } | null = null;

  side(): void {
    const box = $('tl-side');
    box.replaceChildren();
    const c = this.clips.current;
    const info = this.info;
    if (!c || !info) return;
    const keys = [...this.keys.values()];
    const events = [...this.events.values()];
    const row = (...els: HTMLElement[]): HTMLElement => {
      const r = h('div', 'row');
      r.append(...els);
      box.append(r);
      return r;
    };
    if (keys.length) {
      box.append(h('h4', '', keys.length === 1 ? `key · ${keys[0].column} of #${keys[0].target} at ${fmtTime(keys[0].t)} s` : `${keys.length} keys`));
      if (keys.length === 1) {
        const k = keys[0];
        const cell = info.tracks.find((tr) => tr.target === k.target && tr.columns.includes(k.column))?.keys[k.column].find((x) => sameT(x.t, k.t));
        const v = h('input');
        v.id = 'tl-value';
        v.value = cell?.value ?? '';
        v.onchange = () => {
          const raw = v.value.trim();
          const n = Number(raw);
          this.run('key.set', { clip: c.name, target: k.target, column: k.column, t: k.t, value: raw !== '' && Number.isFinite(n) ? n : raw });
        };
        row(h('span', 'muted', 'value'), v);
        if (!['tex', 'view', 'tint'].includes(k.column)) {
          const p = h('input');
          p.id = 'tl-param';
          p.placeholder = 'name';
          p.value = cell?.param ?? '';
          p.title = 'A clip parameter ($name — given at play time); empty — a number again';
          p.onchange = () => {
            const name = p.value.trim().replace(/^\$/, '');
            const back = Number(this.valueAt(k.target, k.column, k.t));
            this.run('key.setParam', { clip: c.name, target: k.target, column: k.column, t: k.t, param: name || null, ...(name ? {} : { value: Number.isFinite(back) ? back : 0 }) });
          };
          row(h('span', 'muted', '$param'), p);
        }
      }
      this.easeEditor(box, c.name, keys, info);
      const del = h('button', '', 'remove (Delete)');
      del.onclick = () => this.removeSelected();
      row(del);
      return;
    }
    if (events.length === 1) {
      const ev = events[0];
      box.append(h('h4', '', `event at ${fmtTime(ev.t)} s`));
      const n = h('input');
      n.id = 'tl-event-name';
      n.value = ev.event;
      n.onchange = () => {
        if (n.value.trim() && this.run('event.set', { clip: c.name, event: ev, name: n.value.trim() })?.ok) {
          this.events.clear();
          this.events.set(evId({ t: ev.t, event: n.value.trim() }), { t: ev.t, event: n.value.trim() });
        }
      };
      row(h('span', 'muted', 'name'), n);
      const del = h('button', '', 'remove (Delete)');
      del.onclick = () => this.removeSelected();
      row(del);
      return;
    }
    if (this.track) {
      const tr = info.tracks.find((x) => x.target === this.track!.target && x.index === this.track!.index);
      if (tr) {
        box.append(h('h4', '', `track #${tr.target}${tr.index ? ` (${tr.index + 1})` : ''}`));
        const to = h('input');
        to.value = tr.target;
        to.onchange = () => {
          if (to.value.trim() && this.run('track.retarget', { clip: c.name, target: tr.target, index: tr.index, to: to.value.trim() })?.ok) this.track = { target: to.value.trim(), index: tr.index };
        };
        row(h('span', 'muted', 'target'), to);
        for (const a of ['path', 'orient', 'orient-offset', 'offset'] as const) {
          if (a !== 'path' && !tr.columns.includes('motion')) continue;
          if (a === 'path' && !tr.columns.includes('motion')) continue;
          const i = h('input');
          i.value = tr.attrs[a] ?? '';
          i.onchange = () => this.run('track.setAttr', { clip: c.name, target: tr.target, index: tr.index, name: a, value: i.value.trim() === '' ? null : i.value.trim() });
          row(h('span', 'muted', `$${a}`), i);
        }
        const del = h('button', '', 'remove the track');
        del.onclick = () => {
          if (this.run('track.remove', { clip: c.name, target: tr.target, index: tr.index })?.ok) this.track = null;
        };
        row(del);
        return;
      }
      this.track = null;
    }
    // nothing selected: a new event, a new track
    box.append(h('h4', '', 'at the playhead'));
    const ev = h('input');
    ev.id = 'tl-new-event';
    ev.placeholder = 'sfx:pop · fx:<effect>@<node>';
    const addEv = h('button', '', '+ event');
    addEv.onclick = () => {
      if (ev.value.trim()) this.run('event.add', { clip: c.name, t: Math.round(this.clips.time * 1e4) / 1e4, event: ev.value.trim() });
    };
    ev.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') addEv.click();
    };
    row(ev, addEv);
    const sel = this.ed.selection.map((p) => this.ed.node(p)?.attrs.id).filter((x): x is string => !!x);
    const col = h('select');
    col.id = 'tl-new-column';
    for (const k of CLIP_COLUMNS) col.append(new Option(k, k));
    const addKey = h('button', '', '◆ key');
    addKey.title = sel.length ? `a key of ${sel.map((x) => `#${x}`).join(', ')} at the playhead (the value shown)` : 'select a node with an id on the stage';
    addKey.disabled = !sel.length;
    addKey.onclick = () => {
      const t = Math.round(this.clips.time * 1e4) / 1e4;
      this.batch(
        '◆ key',
        sel.map((target) => ({ name: 'key.set', args: { clip: c.name, target, column: col.value, t, value: this.valueAt(target, col.value, t) } })),
      );
    };
    row(h('span', 'muted', sel.length ? sel.map((x) => `#${x}`).join(' ') : 'no node'), col, addKey);
    box.append(h('div', 'muted hint', 'click — select · ⇧/⌘ — add · drag — move · empty lane drag — box · double-click a row — a key · Delete — remove · ←/→ — a frame'));
  }

  /** Ease of the selected keys: a list, the curve, a Bézier with two handles. */
  private easeEditor(box: HTMLElement, clip: string, keys: KeyRef[], info: ClipInfo): void {
    const eases = keys.map((k) => info.tracks.find((tr) => tr.target === k.target && tr.columns.includes(k.column))?.keys[k.column].find((x) => sameT(x.t, k.t))?.ease ?? '');
    const cur = eases.every((e) => e === eases[0]) ? eases[0] : '?';
    const r = h('div', 'row');
    const sel = h('select');
    sel.id = 'tl-ease';
    sel.append(new Option('— none (linear) —', ''), ...EASES.map((e) => new Option(e, e)), new Option('Bézier…', 'bezier'));
    if (cur === '?') sel.append(new Option('(mixed)', '?'));
    const bez = /^\[(.+)\]$/.exec(cur)?.[1].split(',').map(Number);
    sel.value = cur === '?' ? '?' : bez ? 'bezier' : cur;
    const apply = (ease: string | number[] | null): void => void this.run('key.setEase', { clip, keys, ease });
    sel.onchange = () => {
      if (sel.value === '?') return;
      if (sel.value === 'bezier') apply(bez ?? [0.25, 0.1, 0.25, 1]);
      else apply(sel.value || null);
    };
    r.append(h('span', 'muted', 'ease'), sel);
    box.append(r);
    // the curve (and the handles of a Bézier)
    const S = 120;
    const P = 10;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', String(S + 2 * P));
    svg.setAttribute('height', String(S + 2 * P));
    svg.setAttribute('class', 'tl-curve');
    const pt = (x: number, y: number): [number, number] => [P + x * S, P + (1 - y) * S];
    const path = document.createElementNS(SVG, 'path');
    const drawCurve = (fn: (p: number) => number): void => {
      let d = '';
      for (let i = 0; i <= 48; i++) {
        const [x, y] = pt(i / 48, fn(i / 48));
        d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      path.setAttribute('d', d);
    };
    const frame = document.createElementNS(SVG, 'rect');
    frame.setAttribute('x', String(P));
    frame.setAttribute('y', String(P));
    frame.setAttribute('width', String(S));
    frame.setAttribute('height', String(S));
    frame.setAttribute('class', 'frame');
    svg.append(frame, path);
    const easeOf = (): ((p: number) => number) => {
      try {
        return resolveEase((bez ? bez : cur && cur !== '?' ? cur : 'linear') as never);
      } catch {
        return (p) => p;
      }
    };
    drawCurve(easeOf());
    if (bez && bez.length === 4) {
      const b = [...bez];
      const lines = [document.createElementNS(SVG, 'line'), document.createElementNS(SVG, 'line')];
      const dots = [document.createElementNS(SVG, 'circle'), document.createElementNS(SVG, 'circle')];
      const place = (): void => {
        const ends: [number, number][] = [pt(0, 0), pt(1, 1)];
        for (let i = 0; i < 2; i++) {
          const [x, y] = pt(b[i * 2], b[i * 2 + 1]);
          dots[i].setAttribute('cx', String(x));
          dots[i].setAttribute('cy', String(y));
          lines[i].setAttribute('x1', String(ends[i][0]));
          lines[i].setAttribute('y1', String(ends[i][1]));
          lines[i].setAttribute('x2', String(x));
          lines[i].setAttribute('y2', String(y));
        }
        drawCurve(resolveEase(b as [number, number, number, number]));
      };
      dots.forEach((dot, i) => {
        dot.setAttribute('r', '5');
        dot.setAttribute('class', 'handle');
        dot.dataset.handle = String(i);
        dot.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          dot.setPointerCapture(e.pointerId);
          const rect = svg.getBoundingClientRect();
          const mv = (ev: PointerEvent): void => {
            b[i * 2] = Math.max(0, Math.min(1, (ev.clientX - rect.left - P) / S));
            b[i * 2 + 1] = Math.max(-1, Math.min(2, 1 - (ev.clientY - rect.top - P) / S));
            place();
          };
          const up = (): void => {
            dot.removeEventListener('pointermove', mv);
            dot.removeEventListener('pointerup', up);
            apply(b.map((v) => Math.round(v * 100) / 100));
          };
          dot.addEventListener('pointermove', mv);
          dot.addEventListener('pointerup', up);
        });
      });
      svg.append(...lines, ...dots);
      place();
    }
    box.append(svg);
  }

  // ---- pointer -------------------------------------------------------------------------------------

  private hitKey(e: Event): HTMLElement | null {
    return (e.target as HTMLElement).closest('.tl-key:not(.sum), .tl-ev');
  }

  private down(e: PointerEvent): void {
    const grid = $('tl-grid');
    const target = e.target as HTMLElement;
    const c = this.clips.current;
    if (!c || e.button !== 0) return;
    grid.focus();
    if (target.closest('.tl-end')) {
      this.drag = { kind: 'end', d: c.duration };
      grid.setPointerCapture(e.pointerId);
      return;
    }
    if (target.closest('.tl-ruler') || target.closest('#tl-playhead')) {
      this.drag = { kind: 'scrub' };
      grid.setPointerCapture(e.pointerId);
      this.seek(this.timeAt(e.clientX));
      return;
    }
    const k = this.hitKey(e);
    if (k) {
      const add = e.shiftKey || e.metaKey || e.ctrlKey;
      const isEv = k.classList.contains('tl-ev');
      const id = isEv ? evId({ t: Number(k.dataset.t), event: k.dataset.event! }) : keyId({ target: k.dataset.target!, column: k.dataset.column!, t: Number(k.dataset.t) });
      const has = isEv ? this.events.has(id) : this.keys.has(id);
      if (!add && !has) {
        this.keys.clear();
        this.events.clear();
      }
      if (add && has) {
        if (isEv) this.events.delete(id);
        else this.keys.delete(id);
      } else if (isEv) this.events.set(id, { t: Number(k.dataset.t), event: k.dataset.event! });
      else this.keys.set(id, { target: k.dataset.target!, column: k.dataset.column!, t: Number(k.dataset.t) });
      this.track = null;
      this.drag = { kind: 'move', x0: e.clientX, dt: 0 };
      grid.setPointerCapture(e.pointerId);
      this.restyle();
      this.side();
      return;
    }
    if (target.closest('.tl-label')) return;
    // an empty lane: a box selection (a plain click — the playhead goes there)
    const r = grid.getBoundingClientRect();
    const el = h('div', 'tl-box');
    grid.append(el);
    this.drag = { kind: 'box', x0: e.clientX - r.left + grid.scrollLeft, y0: e.clientY - r.top + grid.scrollTop, el };
    grid.setPointerCapture(e.pointerId);
    if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
      this.keys.clear();
      this.events.clear();
      this.track = null;
    }
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const grid = $('tl-grid');
    if (d.kind === 'scrub') this.seek(this.timeAt(e.clientX));
    else if (d.kind === 'end') {
      d.d = Math.max(FRAME, this.timeAt(e.clientX));
      const end = grid.querySelector<HTMLElement>('.tl-end');
      if (end) end.style.left = `${this.x(d.d)}px`;
    } else if (d.kind === 'move') {
      d.dt = Math.round((e.clientX - d.x0) / this.scale() / FRAME) * FRAME;
      for (const el of grid.querySelectorAll<HTMLElement>('.tl-key.sel, .tl-ev.sel')) el.style.transform = `translateX(${d.dt * this.scale()}px)`;
    } else if (d.kind === 'box') {
      const r = grid.getBoundingClientRect();
      const x = e.clientX - r.left + grid.scrollLeft;
      const y = e.clientY - r.top + grid.scrollTop;
      Object.assign(d.el.style, { left: `${Math.min(x, d.x0)}px`, top: `${Math.min(y, d.y0)}px`, width: `${Math.abs(x - d.x0)}px`, height: `${Math.abs(y - d.y0)}px` });
    }
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    const grid = $('tl-grid');
    if (grid.hasPointerCapture(e.pointerId)) grid.releasePointerCapture(e.pointerId);
    const c = this.clips.current;
    if (!d || !c) return;
    if (d.kind === 'end') {
      if (!sameT(d.d, c.duration)) this.run('clip.setAttr', { clip: c.name, name: 'duration', value: Math.round(d.d * 1e4) / 1e4 });
      else this.draw();
    } else if (d.kind === 'move') {
      if (d.dt !== 0) this.moveSelected(d.dt);
      else this.restyle();
    } else if (d.kind === 'box') {
      const box = d.el.getBoundingClientRect();
      d.el.remove();
      if (box.width < 3 && box.height < 3) {
        this.seek(this.timeAt(e.clientX));
        this.side();
        this.restyle();
        return;
      }
      for (const el of grid.querySelectorAll<HTMLElement>('.tl-key:not(.sum), .tl-ev')) {
        const b = el.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
        if (el.classList.contains('tl-ev')) this.events.set(evId({ t: Number(el.dataset.t), event: el.dataset.event! }), { t: Number(el.dataset.t), event: el.dataset.event! });
        else this.keys.set(keyId({ target: el.dataset.target!, column: el.dataset.column!, t: Number(el.dataset.t) }), { target: el.dataset.target!, column: el.dataset.column!, t: Number(el.dataset.t) });
      }
      this.restyle();
      this.side();
    }
  }

  private dbl(e: MouseEvent): void {
    const c = this.clips.current;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tl-col, .tl-events');
    if (!c || !row || this.hitKey(e)) return;
    const t = Math.round(this.timeAt(e.clientX) * 1e4) / 1e4;
    if (row.classList.contains('tl-events')) {
      void ask(`New event at ${fmtTime(t)} s`, '', 'sfx:pop · fx:<effect>@<node> · any name the game handles').then((name) => {
        if (name) this.run('event.add', { clip: c.name, t, event: name });
      });
      return;
    }
    const target = row.dataset.target!;
    const column = row.dataset.column!;
    this.run('key.set', { clip: c.name, target, column, t, value: this.valueAt(target, column, t) });
  }

  private key(e: KeyboardEvent): void {
    const c = this.clips.current;
    if (!c) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const step = (e.shiftKey ? 0.1 : FRAME) * (e.key === 'ArrowLeft' ? -1 : 1);
      this.seek(Math.max(0, Math.min(c.duration, this.clips.time + step)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      this.removeSelected();
    } else if (e.key === 'Escape') {
      this.keys.clear();
      this.events.clear();
      this.restyle();
      this.side();
    }
  }

  private seek(t: number): void {
    try {
      this.clips.seek(t);
    } catch (e) {
      this.ed.log('error', e instanceof Error ? e.message : String(e));
    }
  }

  /** The selected keys and events by dt: one step. */
  moveSelected(dt: number): CommandResult | null {
    const c = this.clips.current;
    if (!c) return null;
    const keys = [...this.keys.values()];
    const events = [...this.events.values()];
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    if (keys.length) calls.push({ name: 'key.move', args: { clip: c.name, keys, dt } });
    if (events.length) calls.push({ name: 'event.move', args: { clip: c.name, events, dt } });
    const r = this.batch('move keys', calls);
    if (r?.ok) {
      // the selection follows (the snapped times are read back after the render)
      const snap = (t: number): number => Math.max(0, Math.round((t + dt) / FRAME) * FRAME);
      const k2 = keys.map((k) => ({ ...k, t: this.nearKey(k.target, k.column, snap(k.t)) }));
      const e2 = events.map((ev) => ({ ...ev, t: this.nearEvent(ev.event, snap(ev.t)) }));
      this.keys = new Map(k2.map((k) => [keyId(k), k]));
      this.events = new Map(e2.map((ev) => [evId(ev), ev]));
    }
    this.draw();
    return r;
  }

  private nearKey(target: string, column: string, t: number): number {
    const keys = this.info?.tracks.find((tr) => tr.target === target && tr.columns.includes(column))?.keys[column] ?? [];
    let best = t;
    for (const k of keys) if (Math.abs(k.t - t) < 2.5 * FRAME && Math.abs(k.t - t) <= Math.abs(best - t) + 1e-9) best = k.t;
    return best;
  }

  private nearEvent(event: string, t: number): number {
    let best = t;
    for (const ev of this.info?.events ?? []) if (ev.event === event && Math.abs(ev.t - t) < 2.5 * FRAME) best = ev.t;
    return best;
  }

  removeSelected(): CommandResult | null {
    const c = this.clips.current;
    if (!c) return null;
    const keys = [...this.keys.values()];
    const events = [...this.events.values()];
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    if (keys.length) calls.push({ name: 'key.remove', args: { clip: c.name, keys } });
    if (events.length) calls.push({ name: 'event.remove', args: { clip: c.name, events } });
    const r = this.batch('remove keys', calls);
    if (r?.ok) {
      this.keys.clear();
      this.events.clear();
    }
    this.draw();
    return r;
  }

  /** Selection classes only (no rebuild). */
  private restyle(): void {
    const grid = $('tl-grid');
    for (const el of grid.querySelectorAll<HTMLElement>('.tl-key:not(.sum)')) {
      el.style.transform = '';
      el.classList.toggle('sel', this.keys.has(keyId({ target: el.dataset.target!, column: el.dataset.column!, t: Number(el.dataset.t) })));
    }
    for (const el of grid.querySelectorAll<HTMLElement>('.tl-ev')) {
      el.style.transform = '';
      el.classList.toggle('sel', this.events.has(evId({ t: Number(el.dataset.t), event: el.dataset.event! })));
    }
  }
}

/** A message for the log (code first). */
export function clipMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return codeOf(m) ? m : coded('E_EDIT_CLIP', m);
}
