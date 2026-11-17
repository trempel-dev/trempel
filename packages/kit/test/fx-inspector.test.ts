// 2.3: the particle inspector's data side — where an effect lives (a converter's systems.json by the
// identity of its configs, the project's fx/<name>.json, a preset, code), edits played by the
// table, saves: systems.json — only the edited systems rewritten, the rest byte for byte; an
// effect file — whole; «move to a file». The panel itself is DOM — the template's e2e drives it.

import { describe, it, expect } from 'vitest';
import type { InspectorHost } from '@trempel/scene/view';
import { Fx } from '../src/fx/fx.js';
import { fxInspector } from '../src/fx/inspector.js';
import { arrayItems, formatEffectFile, indentUnit, replaceItems } from '../src/fx/json-edit.js';
import { particleConfig, type ParticleConfig } from '../src/fx/types.js';

const sys = (key: string, rate: number): ParticleConfig => particleConfig({ key, rate, color: [1, 0.92941177, 0.5019608, 1], bursts: [{ time: 0, count: 3, cycles: 1, interval: 0.01, prob: 1 }] });

/** A systems.json as a converter writes it (one-space indent). */
const SYSTEMS = JSON.stringify([sys('a', 1), sys('glow', 0.52), sys('c', 3)], null, 1);

function fakeHost(files: Record<string, string>): InspectorHost & { files: InspectorHost['files']; logs: string[] } {
  const logs: string[] = [];
  return {
    node: null,
    scene: () => null,
    component: () => null,
    exec: () => null,
    files: {
      list: async (dir = '') => Object.keys(files).filter((f) => f.startsWith(dir)),
      read: async (p) => {
        if (!(p in files)) throw new Error(`no ${p}`);
        return files[p];
      },
      write: async (p, t) => {
        files[p] = t;
      },
    },
    ui: {} as InspectorHost['ui'],
    log: (_l, t) => logs.push(t),
    refresh: () => {},
    logs,
  };
}

describe('json-edit', () => {
  it('finds the array items and the indent unit', () => {
    const r = arrayItems(SYSTEMS)!;
    expect(r.length).toBe(3);
    expect(JSON.parse(SYSTEMS.slice(r[1][0], r[1][1])).key).toBe('glow');
    expect(indentUnit(SYSTEMS)).toBe(' ');
    expect(arrayItems('{"a": 1}')).toBeNull();
    expect(arrayItems('[1, "a,]", {"b": [2, 3]}]')!.length).toBe(3);
  });

  it('replaces one item: the rest of the text byte for byte', () => {
    const items = JSON.parse(SYSTEMS) as ParticleConfig[];
    const next = { ...items[1], rate: 1.04 };
    const out = replaceItems(SYSTEMS, new Map([[1, next]]));
    expect(JSON.parse(out)).toEqual([items[0], next, items[2]]);
    const a = SYSTEMS.split('\n');
    const b = out.split('\n');
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual(['  "rate": 0.52,']);
    // a compact file stays compact
    const compact = JSON.stringify(items);
    expect(replaceItems(compact, new Map([[2, { ...items[2], rate: 9 }]]))).toBe(JSON.stringify([items[0], items[1], { ...items[2], rate: 9 }]));
    expect(() => replaceItems(SYSTEMS, new Map([[5, {}]]))).toThrow(/^E_FX_EDIT: /);
    expect(formatEffectFile({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe('fxInspector api', () => {
  const setup = (extra: Record<string, string> = {}) => {
    const data = JSON.parse(SYSTEMS) as ParticleConfig[];
    const files: Record<string, string> = { 'fx/particles/systems.json': SYSTEMS, ...extra };
    const fx = new Fx(null);
    fx.tables({ effects: { glow: [data[1]], pair: [data[0], data[2]] } });
    const insp = fxInspector({ fx, sources: { 'fx/particles/systems.json': data } });
    const host = fakeHost(files);
    const api = insp.api!(host) as {
      list(): { name: string; origin: string }[];
      origin(n: string): unknown;
      get(n: string): ParticleConfig[];
      update(n: string, fn: (c: ParticleConfig[]) => void): ParticleConfig[];
      save(n: string): Promise<string | null>;
      extract(n: string): Promise<string>;
      unsaved(): string[];
      ready(): Promise<void>;
    };
    return { fx, api, files, host, data };
  };

  it('knows where each effect lives', async () => {
    const own = JSON.stringify(sys('mine', 5));
    const { api } = setup({ 'fx/mine.json': own });
    await api.ready();
    expect(api.origin('glow')).toEqual({ kind: 'systems', file: 'fx/particles/systems.json', indices: [1] });
    expect(api.origin('pair')).toEqual({ kind: 'systems', file: 'fx/particles/systems.json', indices: [0, 2] });
    expect(api.origin('mine')).toEqual({ kind: 'file', file: 'fx/mine.json', single: true });
    expect(api.origin('burst')).toEqual({ kind: 'preset' });
    const names = api.list();
    expect(names.find((x) => x.name === 'mine')?.origin).toBe('file');
    expect(names.find((x) => x.name === 'confetti')?.origin).toBe('preset');
  });

  it('«rate ×2» — the table plays it at once; save rewrites only that system of systems.json', async () => {
    const { api, files, fx, data } = setup();
    api.update('glow', (c) => {
      c[0].rate *= 2;
    });
    expect(fx.configs('glow')[0].rate).toBe(1.04);
    expect(api.unsaved()).toEqual(['glow']);
    expect(await api.save('glow')).toBe('fx/particles/systems.json');
    const a = SYSTEMS.split('\n');
    const b = files['fx/particles/systems.json'].split('\n');
    expect(a.filter((l, i) => l !== b[i])).toEqual(['  "rate": 0.52,']);
    expect(data[1].rate).toBe(1.04); // the imported data follows the file
    expect(api.origin('glow')).toEqual({ kind: 'systems', file: 'fx/particles/systems.json', indices: [1] });
    expect(api.unsaved()).toEqual([]);
  });

  it('a preset is read-only: save refuses, extract writes fx/<name>.json and it becomes a file', async () => {
    const { api, files, host } = setup();
    await api.ready();
    api.update('burst', (c) => {
      c[0].max = 10;
    });
    await expect(api.save('burst')).rejects.toThrow(/^E_FX_EDIT: /);
    expect(await api.extract('burst')).toBe('fx/burst.json');
    expect(JSON.parse(files['fx/burst.json']).max).toBe(10);
    expect(api.origin('burst')).toEqual({ kind: 'file', file: 'fx/burst.json', single: true });
    expect(host.logs.some((l) => l.includes('fx/burst.json'))).toBe(true);
    api.update('burst', (c) => {
      c[0].max = 12;
    });
    await api.save('burst');
    expect(files['fx/burst.json']).toBe(formatEffectFile({ ...JSON.parse(files['fx/burst.json']), max: 12 }));
  });
});
