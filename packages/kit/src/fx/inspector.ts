// inspector.ts — 2.3: the particle editor — the editor's inspector of `tml:type="fx"` nodes, brought
// by kitView() into a game's trempel.view.ts (`inspectors.fx`). The scene editor knows nothing of
// particles: it hands over the node, its component, the core commands, the folder's files and its
// widgets (curve, gradient); this panel does the rest.
//
//   - the effect of the node: presets of the kit, the project's effects (fx/<name>.json), the game's
//     table (a converter's systems.json) — changing it is heir.setAttr (data-effect of a node the heir
//     inserts, tml:effect of a base node);
//   - the config of each system in groups (emission, shape, life and motion, colour, size over life,
//     sheet, render); a value is a constant, a range or a curve; colours over life — a gradient;
//   - the preview is the node itself: every change replays it (⟲), «burst» fires a one-shot, the
//     seed is the node's (the same picture every time) or a random one;
//   - save: into the effect's file — systems.json: only the systems of this effect are rewritten,
//     the rest of the file byte for byte; fx/<name>.json — whole. An effect the game declares in code
//     (or a preset) is read-only here: «move to a file» writes fx/<name>.json (hooking that file up in
//     the game is the game's business);
//   - a palette: effects dragged onto the stage become effect nodes of the heir (heir.insertFx);
//   - `tml.inspect.fx` — the same for scripts and agents: list / get / update / save / extract.

import type { InspectorFactory, InspectorHost, InspectorPanel } from '@trempel/scene/view';
import { FX_DRAG_MIME } from '@trempel/scene/view';
import type { Fx } from './fx.js';
import { formatEffectFile, replaceItems } from './json-edit.js';
import { FxNode } from './node.js';
import { PARTICLES } from './presets.js';
import type { Curve, MinMax, ParticleConfig, RGBA } from './types.js';

/** Where an effect's configs live. */
export type FxOrigin =
  | { kind: 'systems'; file: string; indices: number[] }
  | { kind: 'file'; file: string; single: boolean }
  | { kind: 'preset' }
  | { kind: 'code' };

export interface FxInspectorOptions {
  fx: Fx;
  /** Effect files the game imports, by path relative to the scene folder → the imported JSON (identity tells where a config lives). */
  sources?: Record<string, unknown>;
  /** The project's own effects: a folder of the scene folder with <name>.json (default 'fx'). */
  folder?: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const BUILTIN_TEXTURES = ['circle', 'square', 'star', 'spark'];

/** The particle editor of kitView: panel, palette and the agent API over one effects table. */
export function fxInspector(o: FxInspectorOptions): Exclude<InspectorFactory, (h: InspectorHost) => InspectorPanel> {
  const folder = o.folder ?? 'fx';
  /** Project effects read from <folder>/*.json: name → file. */
  const project = new Map<string, { file: string; single: boolean }>();
  let scanned: Promise<void> | null = null;
  /** Edited, not saved yet: name → the configs. */
  const working = new Map<string, ParticleConfig[]>();
  const listeners = new Set<() => void>();
  const changed = (): void => listeners.forEach((f) => f());

  const scan = (host: InspectorHost): Promise<void> =>
    (scanned ??= (async () => {
      let files: string[] = [];
      try {
        files = (await host.files.list(folder)).filter((f) => f.startsWith(`${folder}/`) && f.endsWith('.json') && !f.slice(folder.length + 1).includes('/'));
      } catch {
        files = [];
      }
      for (const file of files) {
        try {
          const data = JSON.parse(await host.files.read(file)) as ParticleConfig | ParticleConfig[];
          const name = file.slice(folder.length + 1, -5);
          project.set(name, { file, single: !Array.isArray(data) });
          o.fx.tables({ effects: { [name]: Array.isArray(data) ? data : [data] } });
        } catch (e) {
          host.log('warn', `W_FX_EDIT: ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      changed();
    })());

  /** Where an effect lives — found once, before an edit replaces its configs in the table. */
  const origins = new Map<string, FxOrigin>();
  const origin = (name: string): FxOrigin => {
    const p = project.get(name);
    if (p) return { kind: 'file', file: p.file, single: p.single };
    const known = origins.get(name);
    if (known) return known;
    let configs: ParticleConfig[];
    try {
      configs = o.fx.configs(name);
    } catch {
      return { kind: 'code' };
    }
    let found: FxOrigin | null = null;
    for (const [file, data] of Object.entries(o.sources ?? {})) {
      if (!Array.isArray(data)) continue;
      const indices = configs.map((c) => (data as unknown[]).indexOf(c));
      if (indices.every((i) => i >= 0)) {
        found = { kind: 'systems', file, indices };
        break;
      }
    }
    found ??= name in PARTICLES && !o.fx.names().includes(name) ? { kind: 'preset' } : { kind: 'code' };
    origins.set(name, found);
    return found;
  };

  const names = (): { name: string; origin: FxOrigin['kind'] }[] => {
    const out = new Map<string, FxOrigin['kind']>();
    for (const n of project.keys()) out.set(n, 'file');
    for (const n of o.fx.names()) if (!out.has(n)) out.set(n, origin(n).kind);
    for (const n of Object.keys(PARTICLES)) if (!out.has(n)) out.set(n, 'preset');
    return [...out].map(([name, kind]) => ({ name, origin: kind }));
  };

  const get = (name: string): ParticleConfig[] => working.get(name) ?? clone(o.fx.configs(name));

  /** Apply edited configs: the table plays them (nodes replay on ⟲ / the next start). */
  const put = (name: string, configs: ParticleConfig[]): void => {
    origin(name);
    working.set(name, configs);
    o.fx.tables({ effects: { [name]: configs } });
    changed();
  };

  const save = async (host: InspectorHost, name: string): Promise<string | null> => {
    const configs = working.get(name);
    if (!configs) return null;
    const where = origin(name);
    if (where.kind === 'preset' || where.kind === 'code') {
      throw new Error(`E_FX_EDIT: ${name} is ${where.kind === 'preset' ? 'a preset of the kit' : 'declared in the game\'s code'} — move it to a file first (extract)`);
    }
    if (where.kind === 'file') {
      await host.files.write(where.file, formatEffectFile(where.single && configs.length === 1 ? configs[0] : configs));
    } else {
      const text = await host.files.read(where.file);
      const items = new Map<number, unknown>(where.indices.map((idx, i) => [idx, configs[i]]));
      await host.files.write(where.file, replaceItems(text, items));
      // the imported data follows the file (the identity keeps telling where it lives)
      const data = o.sources?.[where.file] as unknown[];
      where.indices.forEach((idx, i) => (data[idx] = configs[i]));
    }
    working.delete(name);
    o.fx.tables({ effects: { [name]: configs } });
    changed();
    return where.file;
  };

  const extract = async (host: InspectorHost, name: string): Promise<string> => {
    const file = `${folder}/${name}.json`;
    const configs = get(name);
    await host.files.write(file, formatEffectFile(configs.length === 1 ? configs[0] : configs));
    project.set(name, { file, single: configs.length === 1 });
    working.delete(name);
    o.fx.tables({ effects: { [name]: configs } });
    host.log('info', `${file}: the effect ${name} is a file now — the game loads it itself (its effects table)`);
    changed();
    return file;
  };

  /** The effect node component of the inspected node (FxNode in a component's `node`). */
  const nodeOf = (host: InspectorHost): FxNode | null => {
    const c = host.component() as { node?: unknown } | null;
    return c?.node instanceof FxNode ? c.node : null;
  };

  return {
    api(host) {
      void scan(host);
      return {
        /** Effects: { name, origin } (file — fx/*.json, systems — the game's systems.json, preset, code). */
        list: () => names(),
        /** Where an effect lives. */
        origin: (name: string) => origin(name),
        /** The configs of an effect (a copy; the edited ones when unsaved). */
        get: (name: string) => clone(get(name)),
        /** Change an effect (the preview plays it; not saved): fn mutates the configs, or returns new ones. */
        update: (name: string, fn: (configs: ParticleConfig[]) => ParticleConfig[] | void) => {
          const c = get(name);
          put(name, fn(c) ?? c);
          return clone(working.get(name)!);
        },
        /** Write the edited effect to its file; resolves the file (null — nothing edited). */
        save: (name: string) => save(host, name),
        /** Write an effect (a preset, one from code) to fx/<name>.json. */
        extract: (name: string) => extract(host, name),
        /** Names edited and not saved. */
        unsaved: () => [...working.keys()],
        /** Wait for the project's fx/*.json to be read. */
        ready: () => scan(host),
      };
    },

    palette(host) {
      const el = document.createElement('div');
      el.className = 'fx-palette';
      const draw = (): void => {
        el.replaceChildren();
        for (const { name, origin: kind } of names()) {
          const item = document.createElement('div');
          item.className = `fx-item ${kind}`;
          item.draggable = true;
          item.dataset.effect = name;
          item.textContent = `✦ ${name}`;
          item.title = `${kind} — drag onto the stage: an effect node in the selected group (the heir)`;
          item.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData(FX_DRAG_MIME, name);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
          });
          el.append(item);
        }
      };
      listeners.add(draw);
      void scan(host).then(draw);
      draw();
      return { el, dispose: () => listeners.delete(draw) };
    },

    panel(host) {
      const el = document.createElement('div');
      el.className = 'fx-inspector';
      const node = host.node!;
      const effect = node.tml.effect ?? node.attrs['data-effect'] ?? '';
      let sys = 0;
      let randomSeed = false;

      const replay = (): void => {
        const n = nodeOf(host);
        if (!n) return;
        if (randomSeed) {
          n.host.drop(FxNode.MAIN);
          n.host.fire(n.effect, { loop: n.opts.loop, scale: n.opts.scale }, `${FxNode.MAIN}:${Math.floor(Math.random() * 1e9)}`);
        } else n.play();
      };

      const row = (label: string, ...inputs: HTMLElement[]): HTMLElement => {
        const r = document.createElement('div');
        r.className = 'row';
        const l = document.createElement('span');
        l.className = 'k';
        l.textContent = label;
        r.append(l, ...inputs);
        return r;
      };
      const input = (value: string | number, on: (v: string) => void, type = 'number', key = ''): HTMLInputElement => {
        const i = document.createElement('input');
        i.type = type;
        if (type === 'number') i.step = 'any';
        i.value = String(value);
        if (key) i.dataset.key = key;
        i.onchange = () => on(i.value);
        return i;
      };
      const select = (value: string, options: string[], on: (v: string) => void, key = ''): HTMLSelectElement => {
        const s = document.createElement('select');
        for (const op of options) s.append(new Option(op, op));
        s.value = value;
        if (key) s.dataset.key = key;
        s.onchange = () => on(s.value);
        return s;
      };
      const check = (on0: boolean, on: (v: boolean) => void, key = ''): HTMLInputElement => {
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = on0;
        if (key) c.dataset.key = key;
        c.onchange = () => on(c.checked);
        return c;
      };
      const button = (text: string, on: () => void, title = ''): HTMLButtonElement => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.onclick = on;
        return b;
      };
      const group = (title: string, open = false): HTMLDetailsElement => {
        const d = document.createElement('details');
        d.open = open || openGroups.has(title);
        d.ontoggle = () => (d.open ? openGroups.add(title) : openGroups.delete(title));
        const s = document.createElement('summary');
        s.textContent = title;
        d.append(s);
        return d;
      };

      const draw = (): void => {
        el.replaceChildren();
        const where = effect ? origin(effect) : ({ kind: 'code' } as FxOrigin);
        const ro = where.kind === 'preset' || where.kind === 'code';
        // the effect of the node
        const all = names().map((x) => x.name);
        if (effect && !all.includes(effect)) all.unshift(effect);
        const pick = select(effect, all, (v) => {
          host.exec('heir.setAttr', { node: node.id, name: node.inserted ? 'data-effect' : 'tml:effect', value: v });
        }, 'effect');
        el.append(row('effect', pick));
        const dirty = working.has(effect);
        const info = document.createElement('div');
        info.className = 'muted';
        info.textContent =
          where.kind === 'systems'
            ? `${where.file} · systems ${where.indices.join(', ')}${dirty ? ' · ● unsaved' : ''}`
            : where.kind === 'file'
              ? `${where.file}${dirty ? ' · ● unsaved' : ''}`
              : where.kind === 'preset'
                ? 'a preset of the kit — read-only (move it to a file to edit)'
                : 'declared in the game\'s code — read-only (move it to a file to edit)';
        el.append(info);
        // preview
        el.append(
          row(
            'preview',
            button('⟲', replay, 'restart the node\'s effect'),
            button('burst', () => nodeOf(host)?.fire(effect), 'one more run of the effect at the node'),
            select(randomSeed ? 'random' : 'seed', ['seed', 'random'], (v) => {
              randomSeed = v === 'random';
              replay();
            }, 'seed'),
          ),
        );
        const actions = document.createElement('div');
        actions.className = 'row';
        if (ro) actions.append(button('move to a file', () => void extract(host, effect).then(draw), `write ${folder}/${effect}.json`));
        else {
          const s = button(`save${dirty ? ' ●' : ''}`, () => {
            save(host, effect).then(draw, (e: unknown) => host.log('error', e instanceof Error ? e.message : String(e)));
          });
          s.dataset.key = 'save';
          s.disabled = !dirty;
          actions.append(s);
          if (dirty)
            actions.append(
              button('revert', () => {
                working.delete(effect);
                const w = origin(effect);
                if (w.kind === 'systems') o.fx.tables({ effects: { [effect]: w.indices.map((i) => (o.sources![w.file] as ParticleConfig[])[i]) } });
                else {
                  scanned = null;
                  void scan(host).then(() => {
                    replay();
                    draw();
                  });
                }
                replay();
                host.log('info', `${effect}: edits dropped (the file is as it was)`);
                draw();
              }),
            );
        }
        el.append(actions);
        if (!effect) return;
        let configs: ParticleConfig[];
        try {
          configs = get(effect);
        } catch (e) {
          el.append(row('', document.createTextNode(e instanceof Error ? e.message : String(e)) as unknown as HTMLElement));
          return;
        }
        if (configs.length > 1) {
          el.append(row('system', select(String(sys), configs.map((_, i) => String(i)), (v) => {
            sys = Number(v);
            draw();
          }, 'system')));
        }
        sys = Math.min(sys, configs.length - 1);
        const c = configs[sys];
        const set = (fn: (c: ParticleConfig) => void): void => {
          if (ro) return;
          const next = clone(configs);
          fn(next[sys]);
          put(effect, next);
          replay();
          draw();
        };
        fields(el, c, set, ro);
      };

      /** The config's fields in groups. */
      const fields = (root: HTMLElement, c: ParticleConfig, set: (fn: (c: ParticleConfig) => void) => void, ro: boolean): void => {
        const num = (label: string, get: () => number | undefined, put: (c: ParticleConfig, v: number) => void, key: string): HTMLElement =>
          row(label, input(get() ?? '', (v) => set((x) => put(x, Number(v))), 'number', key));
        const minmax = (label: string, key: keyof ParticleConfig, d: MinMax = 0, optional = false): HTMLElement => {
          const v = (c[key] as MinMax | undefined) ?? (optional ? undefined : d);
          const mode = v === undefined ? 'none' : typeof v === 'number' ? 'const' : Array.isArray(v) ? 'range' : 'curve';
          const box = document.createElement('div');
          const head = row(
            label,
            select(mode, [...(optional ? ['none'] : []), 'const', 'range', 'curve'], (m) =>
              set((x) => {
                const cur = (x[key] as MinMax | undefined) ?? d;
                const base = typeof cur === 'number' ? cur : Array.isArray(cur) ? cur[0] : cur.mul;
                const out: MinMax | undefined = m === 'none' ? undefined : m === 'const' ? base : m === 'range' ? [base, base] : { curves: [[[0, 1], [1, 1]], [[0, 1], [1, 1]]], mul: base || 1 };
                if (out === undefined) delete (x as unknown as Record<string, unknown>)[key];
                else (x as unknown as Record<string, unknown>)[key] = out;
              }),
            `${String(key)}:mode`),
          );
          box.append(head);
          if (typeof v === 'number') head.append(input(v, (s) => set((x) => ((x as unknown as Record<string, unknown>)[key] = Number(s))), 'number', String(key)));
          else if (Array.isArray(v)) {
            head.append(
              input(v[0], (s) => set((x) => (((x as unknown as Record<string, MinMax>)[key] as [number, number])[0] = Number(s))), 'number', `${String(key)}:0`),
              input(v[1], (s) => set((x) => (((x as unknown as Record<string, MinMax>)[key] as [number, number])[1] = Number(s))), 'number', `${String(key)}:1`),
            );
          } else if (v) {
            head.append(input(v.mul, (s) => set((x) => (((x as unknown as Record<string, MinMax>)[key] as { mul: number }).mul = Number(s))), 'number', `${String(key)}:mul`));
            for (const k of [0, 1] as const) {
              box.append(
                host.ui.curve({
                  points: v.curves[k],
                  label: k ? 'max' : 'min',
                  onChange: (p) => set((x) => (((x as unknown as Record<string, MinMax>)[key] as { curves: [Curve, Curve] }).curves[k] = p)),
                }).el,
              );
            }
          }
          return box;
        };
        const color = (label: string, get: () => RGBA, put: (x: ParticleConfig, v: RGBA) => void, key: string): HTMLElement => {
          const v = get();
          const col = input(toHex(v), (s) => set((x) => put(x, [...fromHex(s), v[3]] as RGBA)), 'color', key);
          const a = input(v[3], (s) => set((x) => put(x, [v[0], v[1], v[2], Number(s)])), 'number', `${key}:a`);
          a.title = 'alpha';
          return row(label, col, a);
        };
        const pair = (label: string, get: () => [number, number] | undefined, put: (x: ParticleConfig, v: [number, number]) => void, key: string): HTMLElement => {
          const v = get() ?? [0, 0];
          return row(label, input(v[0], (s) => set((x) => put(x, [Number(s), v[1]])), 'number', `${key}:0`), input(v[1], (s) => set((x) => put(x, [v[0], Number(s)])), 'number', `${key}:1`));
        };

        const em = group('emission', true);
        em.append(
          num('rate /s', () => c.rate, (x, v) => (x.rate = v), 'rate'),
          num('duration', () => c.duration, (x, v) => (x.duration = v), 'duration'),
          row('loop', check(c.loop, (v) => set((x) => (x.loop = v)), 'loop'), document.createTextNode(' prewarm') as unknown as HTMLElement, check(c.prewarm, (v) => set((x) => (x.prewarm = v)), 'prewarm')),
          num('start delay', () => c.startDelay, (x, v) => (x.startDelay = v), 'startDelay'),
          num('max', () => c.max, (x, v) => (x.max = v), 'max'),
          row('when full', select(c.whenFull ?? 'skip', ['skip', 'wait'], (v) => set((x) => (x.whenFull = v as 'skip' | 'wait')), 'whenFull')),
        );
        c.bursts.forEach((b, i) => {
          em.append(
            row(
              `burst ${i + 1}`,
              ...(['time', 'count', 'cycles', 'interval', 'prob'] as const).map((k) => {
                const inp = input(b[k], (s) => set((x) => (x.bursts[i][k] = Number(s))), 'number', `bursts:${i}:${k}`);
                inp.title = k;
                return inp;
              }),
              button('✕', () => set((x) => x.bursts.splice(i, 1))),
            ),
          );
        });
        em.append(row('', button('+ burst', () => set((x) => x.bursts.push({ time: 0, count: 10, cycles: 1, interval: 0.01, prob: 1 })))));
        root.append(em);

        const sh = group('shape');
        sh.append(
          row('type', select(c.shape.type, ['point', 'circle', 'sphere', 'box'], (v) => set((x) => (x.shape.type = v as ParticleConfig['shape']['type'])), 'shape.type')),
          num('radius', () => c.shape.radius, (x, v) => (x.shape.radius = v), 'shape.radius'),
          num('arc (rad)', () => c.shape.arc, (x, v) => (x.shape.arc = v), 'shape.arc'),
          num('thickness', () => c.shape.thickness, (x, v) => (x.shape.thickness = v), 'shape.thickness'),
          pair('scale', () => c.shape.scale, (x, v) => (x.shape.scale = v), 'shape.scale'),
          pair('box', () => c.shape.box, (x, v) => (x.shape.box = v), 'shape.box'),
          row('radial (Cocos)', check(!!c.orbit, (v) => set((x) => (v ? (x.orbit = { radius: 50, speed: 1 }) : delete x.orbit)), 'orbit')),
        );
        if (c.orbit) {
          const ob = c.orbit;
          sh.append(
            row('orbit radius', input(typeof ob.radius === 'number' ? ob.radius : JSON.stringify(ob.radius), (s) => set((x) => (x.orbit!.radius = parseMinMax(s))), 'text', 'orbit.radius')),
            row('end radius', input(ob.endRadius == null ? '' : typeof ob.endRadius === 'number' ? ob.endRadius : JSON.stringify(ob.endRadius), (s) => set((x) => (s.trim() === '' ? delete x.orbit!.endRadius : (x.orbit!.endRadius = parseMinMax(s)))), 'text', 'orbit.endRadius')),
            row('turn rad/s', input(typeof ob.speed === 'number' ? ob.speed : JSON.stringify(ob.speed), (s) => set((x) => (x.orbit!.speed = parseMinMax(s))), 'text', 'orbit.speed')),
          );
        }
        root.append(sh);

        const life = group('life · speed · size · rotation', true);
        life.append(
          minmax('lifetime', 'lifetime', 1),
          minmax('speed', 'speed', 0),
          minmax('size', 'size', 1),
          minmax('end size', 'endSize', 1, true),
          minmax('rotation', 'rotation', 0),
          minmax('end rotation', 'endRotation', 0, true),
          minmax('spin', 'spin', 0, true),
          num('flip rotation', () => c.flipRotation, (x, v) => (x.flipRotation = v), 'flipRotation'),
          minmax('angle', 'angle', 0, true),
          num('gravity', () => c.gravity, (x, v) => (x.gravity = v), 'gravity'),
          num('gravity x', () => c.gravityX, (x, v) => (x.gravityX = v), 'gravityX'),
          minmax('radial accel', 'radialAccel', 0, true),
          minmax('tangential accel', 'tangentialAccel', 0, true),
          row('limit velocity', check(!!c.limitVelocity, (v) => set((x) => (v ? (x.limitVelocity = { limit: 1, dampen: 0.5 }) : delete x.limitVelocity)), 'limitVelocity')),
        );
        if (c.limitVelocity) {
          life.append(
            num('limit', () => c.limitVelocity!.limit, (x, v) => (x.limitVelocity!.limit = v), 'limitVelocity.limit'),
            num('dampen', () => c.limitVelocity!.dampen, (x, v) => (x.limitVelocity!.dampen = v), 'limitVelocity.dampen'),
          );
        }
        root.append(life);

        const col = group('colour', true);
        const two = Array.isArray(c.color[0]);
        col.append(row('random of two', check(two, (v) => set((x) => (x.color = v ? [x.color as RGBA, x.color as RGBA] : (x.color as [RGBA, RGBA])[0])), 'color:two')));
        if (two) {
          const cc = c.color as [RGBA, RGBA];
          col.append(color('colour A', () => cc[0], (x, v) => ((x.color as [RGBA, RGBA])[0] = v), 'color:0'), color('colour B', () => cc[1], (x, v) => ((x.color as [RGBA, RGBA])[1] = v), 'color:1'));
        } else col.append(color('colour', () => c.color as RGBA, (x, v) => (x.color = v), 'color'));
        col.append(row('per channel', check(!!c.colorPerChannel, (v) => set((x) => (x.colorPerChannel = v || undefined)), 'colorPerChannel')));
        col.append(row('over life', check(!!c.colorOverLifetime, (v) => set((x) => (v ? (x.colorOverLifetime = { color: [[0, 1, 1, 1], [1, 1, 1, 1]], alpha: [[0, 1], [1, 0]] }) : delete x.colorOverLifetime)), 'colorOverLifetime')));
        if (c.colorOverLifetime) {
          col.append(host.ui.gradient({ color: c.colorOverLifetime.color, alpha: c.colorOverLifetime.alpha, onChange: (g) => set((x) => (x.colorOverLifetime = { color: g.color, alpha: g.alpha })) }).el);
        }
        col.append(color('tint', () => c.tint, (x, v) => (x.tint = v), 'tint'));
        root.append(col);

        const sz = group('size over life');
        sz.append(row('curve', check(!!c.sizeOverLifetime, (v) => set((x) => (v ? (x.sizeOverLifetime = [[0, 1], [1, 1]]) : delete x.sizeOverLifetime)), 'sizeOverLifetime')));
        if (c.sizeOverLifetime) sz.append(host.ui.curve({ points: c.sizeOverLifetime, range: [0, 1], onChange: (p) => set((x) => (x.sizeOverLifetime = p)) }).el);
        root.append(sz);

        const sheet = group('sheet');
        sheet.append(row('tiles', check(!!c.sheet, (v) => set((x) => (v ? (x.sheet = { tilesX: 2, tilesY: 2, frameOverTime: [[0, 0], [1, 1]], mul: 1, cycles: 1 }) : delete x.sheet)), 'sheet')));
        if (c.sheet) {
          sheet.append(
            pair('tiles x · y', () => [c.sheet!.tilesX, c.sheet!.tilesY], (x, v) => ((x.sheet!.tilesX = v[0]), (x.sheet!.tilesY = v[1])), 'sheet.tiles'),
            num('cycles', () => c.sheet!.cycles, (x, v) => (x.sheet!.cycles = v), 'sheet.cycles'),
            num('mul', () => c.sheet!.mul, (x, v) => (x.sheet!.mul = v), 'sheet.mul'),
            host.ui.curve({ points: c.sheet.frameOverTime, label: 'frame over time', onChange: (p) => set((x) => (x.sheet!.frameOverTime = p)) }).el,
          );
        }
        root.append(sheet);

        const rd = group('render');
        rd.append(
          row('mode', select(c.render.mode, ['billboard', 'stretch'], (v) => set((x) => (x.render.mode = v as 'billboard' | 'stretch')), 'render.mode')),
          num('length scale', () => c.render.lengthScale, (x, v) => (x.render.lengthScale = v), 'render.lengthScale'),
          num('velocity scale', () => c.render.velocityScale, (x, v) => (x.render.velocityScale = v), 'render.velocityScale'),
          row('blend', select(c.blend, ['normal', 'add', 'screen'], (v) => set((x) => (x.blend = v as ParticleConfig['blend'])), 'blend')),
          row('texture', withList(input(c.texture, (s) => set((x) => (x.texture = s.trim() || 'circle')), 'text', 'texture'), BUILTIN_TEXTURES)),
          pair('unit px', () => c.unit, (x, v) => (x.unit = v), 'unit'),
          pair('pos', () => c.pos, (x, v) => (x.pos = v), 'pos'),
        );
        root.append(rd);
        if (ro) for (const i of root.querySelectorAll('input, select')) if (!(i as HTMLElement).dataset.key?.match(/^(effect|seed|system)$/)) (i as HTMLInputElement).disabled = true;
      };

      listeners.add(draw);
      void scan(host).then(draw);
      draw();
      return { el, dispose: () => listeners.delete(draw) };
    },
  };
}

/** Which <details> groups are open (kept across redraws and nodes). */
const openGroups = new Set<string>();

function toHex(c: RGBA): string {
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function fromHex(s: string): [number, number, number] {
  return [1, 3, 5].map((i) => Math.round((parseInt(s.slice(i, i + 2), 16) / 255) * 1000) / 1000) as [number, number, number];
}

/** "12" → 12; "[1, 2]" → [1, 2]; a curve object as JSON. */
function parseMinMax(s: string): MinMax {
  const t = s.trim();
  if (t.startsWith('[') || t.startsWith('{')) return JSON.parse(t) as MinMax;
  return Number(t) || 0;
}

function withList(i: HTMLInputElement, options: string[]): HTMLInputElement {
  const id = `fx-list-${options.join('-')}`;
  if (!document.getElementById(id)) {
    const dl = document.createElement('datalist');
    dl.id = id;
    for (const o of options) dl.append(new Option(o, o));
    document.body.append(dl);
  }
  i.setAttribute('list', id);
  return i;
}
