// ops.ts — modal transform operators on the stage, as in Blender: G / R / S (a key, a gizmo handle
// or a drag of the selection) start one; while it runs the pointer and the keys drive it — X / Y
// constrain the axis (again — the other axes: local ↔ global, a third time — free), Shift+X —
// all but X, digits / «-» / «.» / Backspace — a typed value, Shift — precise (×0.1), Ctrl — steps
// (10 units, 15°, 0.1); LMB / Enter confirms, RMB / Esc cancels without a trace.
//
// Feedback is live on the runtime (setProp on the node handles — what the clip player writes);
// the confirm is ONE core batch (edit/ops.ts: G → node.move, R/S → node.setTransform about the
// node's pivot) = one undo entry. The status line under the stage reads like Blender's header.
// `.` then a click — the pivot there (node.setPivot keepWorld); Ctrl+. — the bounds' centre.

import type { NodeHandle } from '../../src/core.js';
import { apply, applyVec, canvasToScene, invert, multiply, translation, unionBox, type Box, type Matrix, type Pt } from '../geometry';
import {
  activeAxis,
  axesOf,
  isIdentityOp,
  opCommands,
  OP_LABEL,
  opPivot,
  opStatus,
  opTargets,
  paramsForPointer,
  paramsForValue,
  pivotCommands,
  stepped,
  targetCommands,
  targetMatrix,
  typedValue,
  typeKey,
  type Axis,
  type AxisSpace,
  type OpKind,
  type OpParams,
  type OpRequest,
  type OpTarget,
  defaultSpace,
} from '../ops';
import type { Editor } from './editor';

const PROPS = ['x', 'y', 'rotation', 'scale.x', 'scale.y', 'skew.x', 'skew.y'] as const;
const HELP = 'X/Y ось · Shift точно · Ctrl шаг · Enter/Esc';
const NAME: Record<OpKind, string> = { G: 'Сдвиг', R: 'Поворот', S: 'Масштаб' };

/** Pixi's local matrix from its transform props and pivot. */
export function pixiLocal(p: Record<string, number>, pv: Pt = { x: 0, y: 0 }): Matrix {
  const r = p.rotation;
  const a = Math.cos(r + p['skew.y']) * p['scale.x'];
  const b = Math.sin(r + p['skew.y']) * p['scale.x'];
  const c = -Math.sin(r - p['skew.x']) * p['scale.y'];
  const d = Math.cos(r - p['skew.x']) * p['scale.y'];
  return [a, b, c, d, p.x - (a * pv.x + c * pv.y), p.y - (b * pv.x + d * pv.y)];
}

/** Pixi's Matrix.decompose: props for a local matrix (position — where the pivot lands). */
export function pixiProps(m: Matrix, pv: Pt = { x: 0, y: 0 }): Record<string, number> {
  const [a, b, c, d, e0, f0] = m;
  const e = e0 + a * pv.x + c * pv.y;
  const f = f0 + b * pv.x + d * pv.y;
  const skewX = -Math.atan2(-c, d);
  const skewY = Math.atan2(b, a);
  const delta = Math.abs(skewX + skewY);
  const plain = delta < 1e-5 || Math.abs(Math.PI * 2 - delta) < 1e-5;
  return {
    x: e,
    y: f,
    rotation: plain ? skewY : 0,
    'skew.x': plain ? 0 : skewX,
    'skew.y': plain ? 0 : skewY,
    'scale.x': Math.hypot(a, b),
    'scale.y': Math.hypot(c, d),
  };
}

interface LiveTarget extends OpTarget {
  handle?: NodeHandle;
  local0?: Matrix;
  pixiPivot?: Pt;
}

interface Running {
  kind: OpKind;
  req: OpRequest;
  targets: LiveTarget[];
  /** Started by dragging (a gizmo handle, the selection): releasing the button confirms. */
  drag: boolean;
  /** Scene points: where the pointer started and where the (precise-scaled) pointer is now. */
  from: Pt;
  virt: Pt;
  raw: Pt;
  /** R: the angle swept so far (degrees), accumulated through ±180°. */
  sweep: number;
  /** Axes a first X/Y takes: one node — its local axes (the gizmo's), several — global. */
  space0: AxisSpace;
  typed: string | null;
  shift: boolean;
  ctrl: boolean;
  params: OpParams;
  /** Snap lines in scene units hit by the last move. */
  guides: { x?: number; y?: number };
  /** Candidate lines (scene) — the scope's other nodes, the scope, the stage. */
  lines: { x: number[]; y: number[] };
}

interface Picking {
  targets: OpTarget[];
  /** Dragging the gizmo's pivot circle (release sets it) vs `.` + click. */
  drag: boolean;
  at: Pt | null;
}

export class Operators {
  run: Running | null = null;
  pick: Picking | null = null;
  /** The last pointer position over the stage (screen px), for operators started by a key. */
  pointer: Pt | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly ed: Editor,
    private readonly status: HTMLElement,
    /** Stage-area px of a client point (the stage box). */
    private readonly local: (e: { clientX: number; clientY: number }) => Pt,
  ) {}

  get active(): boolean {
    return !!(this.run || this.pick);
  }

  /** Scene point of a stage-area point. */
  private scene(p: Pt): Pt {
    return apply(invert(this.ed.view()), p);
  }

  /** Targets of the selection (null — nothing operable; the reason goes to the log). */
  private targets(): OpTarget[] | null {
    const ed = this.ed;
    if (!ed.doc || ed.readOnly) return null;
    const paths = ed.selection.filter((p) => !ed.skipped(p));
    const t = opTargets(ed.doc.scene, paths, ed.bounds, (p) => ed.ref(p), (r) => ed.doc?.instance(r) ?? null);
    return t.length ? t : null;
  }

  /**
   * Start an operator on the selection. `axis`/`space` — preset (a gizmo arrow); `drag` — release
   * confirms; `at` — the pointer's stage point now (else the last one over the stage, else the
   * pivot's).
   */
  start(kind: OpKind, opts: { axis?: Axis | null; space?: AxisSpace; drag?: boolean; at?: Pt } = {}): boolean {
    if (this.active) return false;
    const targets = this.targets();
    if (!targets) return false;
    const ed = this.ed;
    const be = ed.backend;
    const live: LiveTarget[] = targets.map((t) => {
      const h = ed.isService(t.path) ? undefined : ed.handles.get(t.path);
      if (!h || !be?.getProp) return t;
      const props: Record<string, number> = {};
      for (const k of PROPS) props[k] = Number(be.getProp(h, k) ?? (k.startsWith('scale') ? 1 : 0));
      const pixiPivot = { x: Number(be.getProp(h, 'pivot.x') ?? 0), y: Number(be.getProp(h, 'pivot.y') ?? 0) };
      return { ...t, handle: h, pixiPivot, local0: pixiLocal(props, pixiPivot) };
    });
    const pivot = opPivot(targets);
    let at = opts.at ?? this.pointer;
    if (!at) {
      // no pointer over the stage yet: a point beside the pivot (S/R need a distance from it)
      const p = apply(ed.view(), pivot);
      at = { x: p.x + 80, y: p.y };
    }
    const from = this.scene(at);
    const space = opts.space ?? defaultSpace(targets);
    const req: OpRequest = { kind, axis: opts.axis ?? null, space };
    this.run = {
      kind,
      req,
      targets: live,
      drag: !!opts.drag,
      from,
      virt: from,
      raw: from,
      sweep: 0,
      space0: space,
      typed: null,
      shift: false,
      ctrl: false,
      params: paramsForPointer(req, targets, from, from, 0),
      guides: {},
      lines: kind === 'G' ? this.snapLines(targets) : { x: [], y: [] },
    };
    ed.operating = true;
    this.listen();
    this.update();
    ed.emit('op');
    return true;
  }

  /** `.`: the next click on the stage puts the selection's pivot there (keepWorld). */
  pickPivot(opts: { drag?: boolean; at?: Pt } = {}): boolean {
    if (this.active) return false;
    const targets = this.targets();
    if (!targets) return false;
    this.pick = { targets, drag: !!opts.drag, at: opts.at ? this.scene(opts.at) : null };
    this.ed.operating = true;
    this.listen();
    this.showStatus(opts.drag ? 'Пивот: отпустите в новой точке  [Esc — отмена]' : 'Пивот: кликните точку на сцене  [Esc — отмена]');
    this.ed.emit('op');
    return true;
  }

  /** Ctrl+.: the pivot of every selected node at its bounds' centre. */
  pivotToCentre(): void {
    const targets = this.targets();
    if (targets) this.ed.batch('пивот в центр', pivotCommands(targets, 'centre'));
  }

  // ---- the running operator ------------------------------------------------------------------

  private update(): void {
    const r = this.run;
    if (!r) return;
    const typed = typedValue(r.typed);
    const axis = activeAxis(r.req);
    const axes = axesOf(r.req.space, r.targets[r.targets.length - 1]);
    let p: OpParams;
    r.guides = {};
    if (typed != null) p = paramsForValue({ ...r.req, value: typed }, r.targets);
    else {
      p = paramsForPointer(r.req, r.targets, r.from, r.virt, r.kind === 'R' ? r.sweep : undefined);
      if (r.ctrl) p = stepped(p, axis, axes);
      else if (r.kind === 'G' && !r.shift) p = this.snap(p, axis, r);
    }
    r.params = p;
    // live: the runtime nodes take the new matrices
    const be = this.ed.backend;
    for (const t of r.targets) {
      if (!t.handle || !t.local0 || !be) continue;
      if (r.kind === 'S' && this.resizePreview(t, p)) continue;
      const Dp = multiply(targetMatrix(t, p), invert(t.own));
      const props = pixiProps(multiply(Dp, t.local0), t.pixiPivot);
      for (const k of PROPS) be.setProp(t.handle, k, props[k]);
    }
    const typing = r.typed != null ? ' · ввод' : '';
    this.showStatus(`${opStatus(r.req, p, r.typed, axes).replace(/^[^\s:]+/, NAME[r.kind])}${typing}  [${HELP}]`);
    this.ed.emit('op');
  }

  /**
   * v1.0: S on a resizable instance / a 9-slice image previews by its size (MountedScene.setSize) and
   * a shift, as the confirm will write it — not by scaling the drawn node. False — not such a target.
   */
  private resizePreview(t: LiveTarget, p: OpParams): boolean {
    const id = t.node.attrs.id;
    const scene = this.ed.session?.scene;
    const be = this.ed.backend;
    const slices = t.node.tag === 'image' && (t.node.attrs['data-slices'] != null || t.node.attrs['data-tile'] != null);
    if (!id || !scene || !be || !t.handle || !t.local0 || !(t.sized || slices)) return false;
    const calls = targetCommands(t, targetMatrix(t, p), 'S');
    if (calls.some((c) => c.name === 'node.setTransform' || (c.name === 'node.setAttr' && (c.args as { name: string }).name === 'transform'))) return false;
    const a = t.node.attrs;
    let w = t.sized?.w ?? Number(a.width);
    let h = t.sized?.h ?? Number(a.height);
    let d: Pt = { x: 0, y: 0 };
    const at: Pt = { x: Number(a.x ?? 0) || 0, y: Number(a.y ?? 0) || 0 };
    for (const c of calls) {
      const args = c.args as Record<string, unknown>;
      if (c.name === 'node.resize') {
        if (typeof args.width === 'number') w = args.width;
        if (typeof args.height === 'number') h = args.height;
      } else if (c.name === 'node.move') d = { x: Number(args.dx), y: Number(args.dy) };
      else if (c.name === 'node.setAttr') {
        const v = Number(args.value);
        if (args.name === 'width') w = v;
        else if (args.name === 'height') h = v;
        else if (args.name === 'x') at.x = v;
        else if (args.name === 'y') at.y = v;
      }
    }
    if (slices) d = applyVec(t.own, { x: at.x - (Number(a.x ?? 0) || 0), y: at.y - (Number(a.y ?? 0) || 0) });
    const ax = t.sized?.axes ?? 'xy';
    scene.setSize(id, ax.includes('x') ? w : undefined, ax.includes('y') ? h : undefined);
    const props = pixiProps(multiply(translation(d.x, d.y), t.local0), t.pixiPivot);
    for (const k of PROPS) be.setProp(t.handle, k, props[k]);
    return true;
  }

  private restore(): void {
    const r = this.run;
    const be = this.ed.backend;
    if (!r || !be) return;
    for (const t of r.targets) {
      if (!t.handle || !t.local0) continue;
      const id = t.node.attrs.id;
      if (id && (t.sized || t.node.attrs['data-slices'] != null || t.node.attrs['data-tile'] != null)) {
        try {
          const ax = t.sized?.axes ?? 'xy';
          const w = t.sized?.w ?? Number(t.node.attrs.width);
          const h = t.sized?.h ?? Number(t.node.attrs.height);
          this.ed.session?.scene?.setSize(id, ax.includes('x') ? w : undefined, ax.includes('y') ? h : undefined);
        } catch {
          // nothing to restore
        }
      }
      const props = pixiProps(t.local0, t.pixiPivot);
      for (const k of PROPS) be.setProp(t.handle, k, props[k]);
    }
  }

  /** Enter / LMB: one batch — one undo entry (nothing when the operator changed nothing). */
  confirm(): void {
    const r = this.run;
    if (!r) return;
    this.end();
    const calls = isIdentityOp(r.params) ? [] : opCommands(r.targets, r.params);
    const res = calls.length ? this.ed.batch(OP_LABEL[r.kind], calls) : null;
    if (!res?.ok || !res.changed.length) {
      this.restoreTargets(r);
      void this.ed.render();
    }
  }

  /** Esc / RMB: the nodes as they were, nothing in the document or the undo. */
  cancel(): void {
    if (this.pick) {
      this.end();
      return;
    }
    const r = this.run;
    if (!r) return;
    this.restore();
    this.end();
  }

  private restoreTargets(r: Running): void {
    const keep = this.run;
    this.run = r;
    this.restore();
    this.run = keep;
  }

  private end(): void {
    this.run = null;
    this.pick = null;
    this.ed.operating = false;
    for (const off of this.offs.splice(0)) off();
    this.showStatus(null);
    this.ed.emit('op');
  }

  private showStatus(text: string | null): void {
    this.status.hidden = text == null;
    this.status.textContent = text ?? '';
  }

  // ---- snapping (G): the selection's edges and centre to the scope's nodes and the stage ----------

  private snapLines(targets: OpTarget[]): { x: number[]; y: number[] } {
    const ed = this.ed;
    const sel = new Set(targets.map((t) => t.path));
    const scope = ed.scope;
    const kids = ed.node(scope)?.children ?? [];
    const boxes: Box[] = [];
    kids.forEach((_, i) => {
      const p = scope === '' ? String(i) : `${scope}/${i}`;
      const b = ed.bounds.get(p);
      if (b && !sel.has(p) && !ed.skipped(p)) boxes.push(b);
    });
    if (scope !== '' && ed.bounds.has(scope)) boxes.push(ed.bounds.get(scope)!);
    boxes.push(canvasToScene(ed.fit, { x: 0, y: 0, w: ed.fit.width, h: ed.fit.height }));
    const x: number[] = [];
    const y: number[] = [];
    for (const b of boxes.slice(0, 80)) {
      x.push(b.x, b.x + b.w / 2, b.x + b.w);
      y.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    return { x, y };
  }

  /** Snap a free / global-axis move: the nearest line within 6 screen px, per active axis. */
  private snap(p: OpParams, axis: Axis | null, r: Running): OpParams {
    if (p.kind !== 'G' || !p.delta || (axis && r.req.space === 'local' && !this.axisIsGlobal(r))) return p;
    const box = unionBox(r.targets.map((t) => t.box));
    if (!box) return p;
    const k = this.ed.view()[0];
    const tol = 6 / (k || 1);
    const best = (vals: number[], lines: number[]): { d: number; at: number } | null => {
      let out: { d: number; at: number } | null = null;
      for (const v of vals) for (const l of lines) {
        const d = l - v;
        if (Math.abs(d) <= tol && (!out || Math.abs(d) < Math.abs(out.d))) out = { d, at: l };
      }
      return out;
    };
    const d = { ...p.delta };
    const moved = { x: box.x + d.x, y: box.y + d.y };
    if (axis !== 'y') {
      const s = best([moved.x, moved.x + box.w / 2, moved.x + box.w], r.lines.x);
      if (s) {
        d.x += s.d;
        r.guides.x = s.at;
      }
    }
    if (axis !== 'x') {
      const s = best([moved.y, moved.y + box.h / 2, moved.y + box.h], r.lines.y);
      if (s) {
        d.y += s.d;
        r.guides.y = s.at;
      }
    }
    return { ...p, delta: d };
  }

  /** A local axis that happens to be the global one (an unrotated node): snapping still applies. */
  private axisIsGlobal(r: Running): boolean {
    const [ax] = axesOf(r.req.space, r.targets[r.targets.length - 1]);
    return Math.abs(ax.y) < 1e-9 && ax.x > 0;
  }

  // ---- input -----------------------------------------------------------------------------------

  private listen(): void {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
      const h = fn as EventListener;
      window.addEventListener(type, h, true);
      this.offs.push(() => window.removeEventListener(type, h, true));
    };
    on('pointermove', (e) => this.pointerMove(e));
    on('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.pick) {
        // a click off the stage (a panel) cancels the pick
        const onStage = !!(e.target as Element | null)?.closest?.('#stage-wrap');
        if (e.button === 0 && !this.pick.drag && onStage) this.pickAt(this.scene(this.local(e)));
        else if (!this.pick.drag) this.cancel();
        return;
      }
      if (e.button === 0) this.confirm();
      else this.cancel();
    });
    on('pointerup', (e) => {
      if (this.pick?.drag && e.button === 0) {
        e.stopPropagation();
        this.pickAt(this.scene(this.local(e)));
      } else if (this.run?.drag && e.button === 0) {
        e.stopPropagation();
        this.confirm();
      }
    });
    on('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    on('keydown', (e) => {
      if (this.key(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    on('keyup', (e) => {
      const r = this.run;
      if (r && (e.key === 'Shift' || e.key === 'Control')) {
        r.shift = e.shiftKey;
        r.ctrl = e.ctrlKey;
        this.update();
      }
    });
    on('blur', () => this.cancel());
  }

  private pickAt(at: Pt): void {
    const pk = this.pick;
    if (!pk) return;
    this.end();
    this.ed.batch('пивот', pivotCommands(pk.targets, at));
  }

  /** The pointer moved (the window's listener; the page calls it for the move that started a drag). */
  pointerMove(e: PointerEvent): void {
    const pt = this.local(e);
    this.pointer = pt;
    if (this.pick) {
      if (this.pick.drag) {
        this.pick.at = this.scene(pt);
        this.ed.emit('op');
      }
      return;
    }
    const r = this.run;
    if (!r) return;
    const raw = this.scene(pt);
    const k = e.shiftKey ? 0.1 : 1;
    const next = { x: r.virt.x + (raw.x - r.raw.x) * k, y: r.virt.y + (raw.y - r.raw.y) * k };
    if (r.kind === 'R') {
      const c = r.params.pivot;
      const a0 = Math.atan2(r.virt.y - c.y, r.virt.x - c.x);
      const a1 = Math.atan2(next.y - c.y, next.x - c.x);
      let da = a1 - a0;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      r.sweep += (da * 180) / Math.PI;
    }
    r.raw = raw;
    r.virt = next;
    r.shift = e.shiftKey;
    r.ctrl = e.ctrlKey;
    this.update();
  }

  /** A key while an operator runs; true — taken. */
  key(e: KeyboardEvent): boolean {
    if (this.pick) {
      if (e.key === 'Escape') this.cancel();
      return true;
    }
    const r = this.run;
    if (!r) return false;
    const k = e.key;
    if (k === 'Escape') {
      this.cancel();
      return true;
    }
    if (k === 'Enter' || k === ' ') {
      this.confirm();
      return true;
    }
    if (k === 'Shift' || k === 'Control') {
      r.shift = e.shiftKey;
      r.ctrl = e.ctrlKey;
      this.update();
      return true;
    }
    const letter = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : k.toLowerCase();
    if ((letter === 'x' || letter === 'y') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.constrain(letter, e.shiftKey);
      return true;
    }
    // G/R/S again: switch the operator (Blender), the pointer start stays
    if ((letter === 'g' || letter === 'r' || letter === 's') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const kind = letter.toUpperCase() as OpKind;
      if (kind !== r.kind) {
        r.kind = kind;
        r.req = { ...r.req, kind };
        r.sweep = 0;
        r.lines = kind === 'G' ? this.snapLines(r.targets) : { x: [], y: [] };
        this.update();
      }
      return true;
    }
    const code = /^Numpad(\d)$/.exec(e.code ?? '')?.[1];
    const typed = typeKey(r.typed, code ?? (e.code === 'NumpadDecimal' ? '.' : e.code === 'NumpadSubtract' ? '-' : k));
    if (typed !== undefined) {
      r.typed = typed;
      this.update();
      return true;
    }
    return !(e.metaKey || e.ctrlKey); // everything else is swallowed (no tool keys mid-operator); ⌘-chords pass
  }

  /**
   * X / Y: the first axes → the other ones → free (Blender's cycle; first — local for one node, the
   * gizmo's axes, global for several). Shift — exclude.
   */
  private constrain(axis: Axis, exclude: boolean): void {
    const r = this.run;
    if (!r) return;
    const q = r.req;
    const other: AxisSpace = r.space0 === 'local' ? 'global' : 'local';
    if (q.axis !== axis || !!q.exclude !== exclude) r.req = { ...q, axis, exclude, space: r.space0 };
    else if (q.space === r.space0) r.req = { ...q, space: other };
    else r.req = { ...q, axis: null, exclude: false, space: r.space0 };
    this.update();
  }

  /** The operator's pivot and running state in screen px (the gizmo draws the snap guides). */
  screenGuides(): { x?: number; y?: number } {
    const r = this.run;
    if (!r) return {};
    const V = this.ed.view();
    const out: { x?: number; y?: number } = {};
    if (r.guides.x != null) out.x = apply(V, { x: r.guides.x, y: 0 }).x;
    if (r.guides.y != null) out.y = apply(V, { x: 0, y: r.guides.y }).y;
    return out;
  }

  /** The pivot being dragged (screen px). */
  pickPoint(): Pt | null {
    return this.pick?.at ? apply(this.ed.view(), this.pick.at) : null;
  }
}

