// widgets.ts — 2.3: the page's editors an inspector of a consumer gets through its host (InspectorUi
// of @trempel/scene/view): a curve (points [t, v]) and a gradient (colour and alpha stops). The scene
// knows nothing of particles; these are plain UI primitives — the kit's particle inspector draws
// its size-over-life and colour-over-life with them.

import type { InspectorUi } from '../../src/view.js';

const SVG = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
const rgb = (s: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number];

/** A curve editor: points [t, v], t 0..1, v in `range`. */
function curve(opts: Parameters<InspectorUi['curve']>[0]): ReturnType<InspectorUi['curve']> {
  const W = 200;
  const H = 90;
  const P = 6;
  let [lo, hi] = opts.range ?? [0, 1];
  let pts = opts.points.map((p) => [...p] as [number, number]);
  const box = document.createElement('div');
  box.className = 'w-curve';
  const svg = el('svg', { width: W + 2 * P, height: H + 2 * P });
  box.append(svg);
  if (opts.label) {
    const l = document.createElement('div');
    l.className = 'muted';
    l.textContent = opts.label;
    box.prepend(l);
  }
  const X = (t: number): number => P + t * W;
  const Y = (v: number): number => P + (1 - (v - lo) / (hi - lo || 1)) * H;
  const fromXY = (x: number, y: number): [number, number] => [r3(clamp((x - P) / W, 0, 1)), r3(lo + (1 - (y - P) / H) * (hi - lo))];
  const draw = (): void => {
    svg.replaceChildren();
    // the shown range grows to fit the points
    for (const [, v] of pts) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    svg.append(el('rect', { x: P, y: P, width: W, height: H, class: 'frame' }));
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    if (sorted.length) svg.append(el('path', { d: sorted.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`).join(''), class: 'line' }));
    pts.forEach((p, i) => {
      const c = el('circle', { cx: X(p[0]), cy: Y(p[1]), r: 4, class: 'pt' });
      c.dataset.i = String(i);
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        c.setPointerCapture(e.pointerId);
        const r = svg.getBoundingClientRect();
        const mv = (ev: PointerEvent): void => {
          pts[i] = fromXY(ev.clientX - r.left, ev.clientY - r.top);
          c.setAttribute('cx', String(X(pts[i][0])));
          c.setAttribute('cy', String(Y(pts[i][1])));
        };
        const up = (): void => {
          c.removeEventListener('pointermove', mv);
          c.removeEventListener('pointerup', up);
          pts.sort((a, b) => a[0] - b[0]);
          draw();
          opts.onChange(pts.map((p) => [...p] as [number, number]));
        };
        c.addEventListener('pointermove', mv);
        c.addEventListener('pointerup', up);
      });
      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (pts.length <= 2) return;
        pts.splice(i, 1);
        draw();
        opts.onChange(pts.map((p) => [...p] as [number, number]));
      });
      svg.append(c);
    });
  };
  svg.addEventListener('dblclick', (e) => {
    const r = svg.getBoundingClientRect();
    pts.push(fromXY(e.clientX - r.left, e.clientY - r.top));
    pts.sort((a, b) => a[0] - b[0]);
    draw();
    opts.onChange(pts.map((p) => [...p] as [number, number]));
  });
  draw();
  return {
    el: box,
    set(p) {
      pts = p.map((x) => [...x] as [number, number]);
      [lo, hi] = opts.range ?? [0, 1];
      draw();
    },
  };
}

/** A gradient editor: colour stops [t, r, g, b, …] over a strip, alpha stops [t, a] under it. */
function gradient(opts: Parameters<InspectorUi['gradient']>[0]): ReturnType<InspectorUi['gradient']> {
  let g = { color: opts.color.map((c) => [...c] as [number, number, number, number]), alpha: opts.alpha.map((a) => [...a] as [number, number]) };
  const box = document.createElement('div');
  box.className = 'w-gradient';
  const strip = document.createElement('div');
  strip.className = 'strip';
  const colors = document.createElement('div');
  colors.className = 'stops';
  const alphas = document.createElement('div');
  alphas.className = 'stops';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'picker';
  const alphaIn = document.createElement('input');
  alphaIn.type = 'number';
  alphaIn.min = '0';
  alphaIn.max = '1';
  alphaIn.step = '0.05';
  alphaIn.className = 'alpha';
  const edit = document.createElement('div');
  edit.className = 'row';
  edit.append(picker, alphaIn);
  box.append(colors, strip, alphas, edit);
  let focus: { kind: 'color' | 'alpha'; i: number } | null = null;
  const emit = (): void => opts.onChange({ color: g.color.map((c) => [...c] as [number, number, number, number]), alpha: g.alpha.map((a) => [...a] as [number, number]) });
  const sample = (t: number): [number, number, number, number] => {
    const at = <T extends number[]>(stops: T[], k: number): number[] => {
      const s = [...stops].sort((a, b) => a[0] - b[0]);
      if (!s.length) return [t, 1, 1, 1];
      if (t <= s[0][0]) return s[0];
      for (let i = 1; i < s.length; i++) {
        if (t <= s[i][0]) {
          const p = (t - s[i - 1][0]) / (s[i][0] - s[i - 1][0] || 1);
          return s[i].map((v, j) => s[i - 1][j] + (v - s[i - 1][j]) * p);
        }
      }
      return s[s.length - 1].slice(0, k);
    };
    const c = at(g.color, 4);
    const a = at(g.alpha, 2);
    return [c[1], c[2], c[3], a[1] ?? 1];
  };
  const draw = (): void => {
    const stops = Array.from({ length: 11 }, (_, i) => {
      const [r, gg, b, a] = sample(i / 10);
      return `rgba(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)},${a}) ${i * 10}%`;
    });
    strip.style.background = `linear-gradient(90deg, ${stops.join(', ')}), repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0 / 10px 10px`;
    for (const [kind, list, row] of [
      ['color', g.color, colors],
      ['alpha', g.alpha, alphas],
    ] as const) {
      row.replaceChildren();
      list.forEach((s, i) => {
        const m = document.createElement('div');
        m.className = `stop${focus?.kind === kind && focus.i === i ? ' on' : ''}`;
        m.dataset.kind = kind;
        m.dataset.i = String(i);
        m.style.left = `${s[0] * 100}%`;
        m.style.background = kind === 'color' ? hex(s[1], s[2] ?? 1, s[3] ?? 1) : `rgba(255,255,255,${s[1]})`;
        m.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          focus = { kind, i };
          syncEdit();
          m.setPointerCapture(e.pointerId);
          const r = row.getBoundingClientRect();
          let moved = false;
          const mv = (ev: PointerEvent): void => {
            moved = true;
            s[0] = r3(clamp((ev.clientX - r.left) / r.width, 0, 1));
            m.style.left = `${s[0] * 100}%`;
          };
          const up = (): void => {
            m.removeEventListener('pointermove', mv);
            m.removeEventListener('pointerup', up);
            draw();
            if (moved) emit();
          };
          m.addEventListener('pointermove', mv);
          m.addEventListener('pointerup', up);
        });
        m.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (list.length <= 1) return;
          list.splice(i, 1);
          focus = null;
          draw();
          emit();
        });
        row.append(m);
      });
    }
    syncEdit();
  };
  const syncEdit = (): void => {
    picker.hidden = focus?.kind !== 'color';
    alphaIn.hidden = focus?.kind !== 'alpha';
    if (focus?.kind === 'color') {
      const s = g.color[focus.i];
      if (s) picker.value = hex(s[1], s[2], s[3]);
    } else if (focus?.kind === 'alpha') {
      const s = g.alpha[focus.i];
      if (s) alphaIn.value = String(s[1]);
    }
  };
  picker.oninput = () => {
    if (focus?.kind !== 'color' || !g.color[focus.i]) return;
    const [r, gg, b] = rgb(picker.value);
    g.color[focus.i] = [g.color[focus.i][0], r3(r), r3(gg), r3(b)];
    draw();
  };
  picker.onchange = () => emit();
  alphaIn.onchange = () => {
    if (focus?.kind !== 'alpha' || !g.alpha[focus.i]) return;
    g.alpha[focus.i] = [g.alpha[focus.i][0], clamp(Number(alphaIn.value) || 0, 0, 1)];
    draw();
    emit();
  };
  for (const [kind, row] of [
    ['color', colors],
    ['alpha', alphas],
  ] as const) {
    row.addEventListener('dblclick', (e) => {
      const r = row.getBoundingClientRect();
      const t = r3(clamp((e.clientX - r.left) / r.width, 0, 1));
      const [cr, cg, cb, ca] = sample(t);
      if (kind === 'color') g.color.push([t, r3(cr), r3(cg), r3(cb)]);
      else g.alpha.push([t, r3(ca)]);
      g.color.sort((a, b) => a[0] - b[0]);
      g.alpha.sort((a, b) => a[0] - b[0]);
      draw();
      emit();
    });
  }
  draw();
  return {
    el: box,
    set(next) {
      g = { color: next.color.map((c) => [...c] as [number, number, number, number]), alpha: next.alpha.map((a) => [...a] as [number, number]) };
      draw();
    },
  };
}

export const widgets: InspectorUi = { curve, gradient };
