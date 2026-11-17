// Kit 2.2 (TRM-12 §3): choreography as data — the model and its md loader, the formula language,
// the Director on the loop's logical time, the kit's actions, the log against a reference timeline.
// Neutral examples: cards fly out one by one, stars light up in turn.
import { describe, expect, it, vi } from 'vitest';
import { GameLoop } from '../src/time/loop.js';
import { Tweens } from '../src/anim/tweens.js';
import { compile, evalNum, evaluate, scopeOf } from '../src/choreo/expr.js';
import { loadChoreo, parseValue, tableOf } from '../src/choreo/model.js';
import { Director, type ChoreoEvent } from '../src/choreo/director.js';
import { kitActions } from '../src/choreo/actions.js';
import { formatFindings, locate, stepTicks, tickGrid, verifyLive, verifyLog, type TimelineDoc } from '../src/choreo/verify.js';
import { Fx } from '../src/fx/fx.js';
import { FxNode } from '../src/fx/node.js';
import { particleConfig } from '../src/fx/types.js';
import { Container } from 'pixi.js';

const DEAL = `# Deal

Cards fly out one by one; then the stars light up in turn. Prose is documentation.

# $seq deal
$title: The cards fly out
$skip: on

| id    | ref     | each           | when     | t                 | dur     | target   | action        | value              | ease    | sound | sync     | skip |
|-------|---------|----------------|----------|-------------------|---------|----------|---------------|--------------------|---------|-------|----------|------|
| fly   | deal#0  | k=0..count-1   |          | step * k          | flyTime | card{k}  | tween:x       | x: 0 → 100 * k     | outQuad | whoosh| await    | now  |
| land  | deal#1  | k=0..count-1   |          | @fly.end          |         | card{k}  | fx:sparkle    |                    |         |       | parallel | cut  |
| stars | deal#2  |                | count > 2| @fly.end + 100    |         | sky      | run:stars     | n = 3              |         |       | await    |      |
| done  |         |                |          | max(@stars.end, @fly.end) |  |        | call:dealt    | total = count      |         |       | resolve  |      |

# $seq stars
$title: The stars light up in turn
| id   | each      | t       | dur  | target  | action      | value       | sync  |
|------|-----------|---------|------|---------|-------------|-------------|-------|
| glow | i=0..n-1  | 50 * i  | 200  | star{i} | tween:alpha | alpha → 1   | await |
`;

const CONSTS = `# $consts
| name    | normal | quick | turbo | ref |
|---------|--------|-------|-------|-----|
| step    | 120    | 60    | 0     | deal#0 |
| flyTime | 300    | 150   |       |     |
`;

const files = { 'deal.md': DEAL, 'consts.md': CONSTS };

/** Step a loop at 60 fps until the promise settles. */
async function settle<T>(loop: GameLoop, p: Promise<T>, max = 30): Promise<T> {
  let done = false;
  let out: T | undefined;
  let err: unknown;
  p.then((v) => ((done = true), (out = v)), (e) => ((done = true), (err = e)));
  while (!done) {
    if (loop.time > max) throw new Error('did not settle');
    loop.step(1 / 60);
    await Promise.resolve();
  }
  if (err) throw err;
  return out as T;
}

describe('choreo: formulas', () => {
  it('numbers, names, members, lists, objects, strings, operators, functions, ternary, refs', () => {
    const s = scopeOf({ a: 2, l: [1, 2, 3], o: { x: 5, y: { z: 7 } }, w: 'hi', '@fly.end': 300, '@fly': 0 });
    expect(evalNum('a * 3 + 1 - 4 / 2 % 3', s)).toBe(5);
    expect(evaluate("l[1] + o.x + o.y.z + o['x']", s)).toBe(19);
    expect(evaluate("[1, 2][0] == 1 and not (a > 3) or false", s)).toBe(true);
    expect(evaluate('{p: a, q: [a]}', s)).toEqual({ p: 2, q: [2] });
    expect(evaluate("a >= 2 ? 'big' : 'small'", s)).toBe('big');
    expect(evaluate('max(l) + min(1, 2) + floor(1.5) + ceil(1.2) + round(1.5) + abs(-1) + len(l) + sum(l) + len(w)', s)).toBe(3 + 1 + 1 + 2 + 2 + 1 + 3 + 6 + 2);
    expect(evaluate("pick(o, ['x']) == pick(o, ['x'])", s)).toBe(false); // lists compare by reference
    expect(evaluate("field([{n: 1}, {n: 2}], 'n')", s)).toEqual([1, 2]);
    expect(evaluate('has(l, 2) and not has(l, 9)', s)).toBe(true);
    expect(evaluate('@fly.end - @fly', s)).toBe(300);
    expect(evaluate('1e3 + .5 + -a', s)).toBe(998.5);
    expect(compile('a + 1')).toBe(compile('a + 1')); // cached
  });

  it('errors carry a code: unknown names list the known ones, bad syntax, wrong types', () => {
    const s = scopeOf({ a: 1 });
    expect(() => evaluate('b', s)).toThrow(/unknown name "b" \(known: a\)/);
    for (const bad of ['a +', '(a', "'x", 'a $ b', 'nope(1)', 'a b', '{1 2}', 'a.', 'a[0]', "pick(1, 2)", "field(1, 'x')", "field([{}], 'x')", '[1][5]', "{x: 1}.y", "'s' * 2", "pick({a: 1}, ['z'])"])
      expect(() => evaluate(bad, scopeOf({ a: 1 })), bad).toThrow(/^E_CHOREO_EXPR: /);
  });
});

describe('choreo: loading', () => {
  it('sequences, rows, consts per mode; tables with escaped pipes; value items', () => {
    const c = loadChoreo(files);
    expect(Object.keys(c.sequences)).toEqual(['deal', 'stars']);
    const deal = c.sequences.deal;
    expect(deal).toMatchObject({ title: 'The cards fly out', skip: 'on', file: 'deal.md' });
    expect(deal.rows.map((r) => r.id)).toEqual(['fly', 'land', 'stars', 'done']);
    expect(deal.rows[0]).toMatchObject({ ref: 'deal#0', each: [{ name: 'k', from: '0', to: 'count-1' }], skip: { kind: 'now' }, value: [{ name: 'x', from: '0', to: '100 * k' }] });
    expect(c.consts.flyTime).toEqual({ normal: '300', quick: '150', turbo: '300' });
    expect(c.constRefs.step).toBe('deal#0');
    expect(c.sequences.stars.skip).toBe('off');
    expect(tableOf('| a | b |\n|---|---|\n| x \\| y | 2 |', 'w')).toEqual([{ a: 'x | y', b: '2' }]);
    expect(tableOf('no table', 'w')).toEqual([]);
    expect(parseValue('y += 30; y -= 2; a -> 1; n = 3; p: 1 → 2', 'w')).toEqual([
      { name: 'y', by: '30' },
      { name: 'y', by: '-(2)' },
      { name: 'a', to: '1' },
      { name: 'n', set: '3' },
      { name: 'p', from: '1', to: '2' },
    ]);
  });

  it('strict: every problem is E_CHOREO_LOAD with the place', () => {
    const seq = (head: string, row: string, extra = '') => ({ 'x.md': `# $seq s\n${extra}\n| ${head} |\n|${head.split('|').map(() => '---').join('|')}|\n| ${row} |\n` });
    const bad: Record<string, string>[] = [
      seq('id | t | action | sync | wat', 'a | 0 | wait | await | 1'),
      seq('id | t | action | sync', 'a | 0 | wait | sometimes'),
      seq('id | t | action | sync', 'a |  | wait | await'),
      seq('id | t | action | sync | ease', 'a | 0 | wait | await | wobbly'),
      seq('id | t | action | sync | each', 'a | 0 | wait | await | k from 1'),
      seq('id | t | action | sync | skip', 'a | 0 | wait | await | later'),
      seq('id | t | action | sync | value', 'a | 0 | wait | await | x ~ 1'),
      seq('id | t | action | sync', 'a | 1 + | wait | await'),
      seq('id | t | action | sync', 'a | 0 | run:nope | await'),
      seq('id | t | action | sync', 'a | 0 | wait | await', '$skip: maybe'),
      seq('id | t | action | sync | target', 'a | 0 | wait | await | x{1 +}'),
      { 'x.md': '# $seq\n' },
      { 'x.md': '# $seq s\n| id | t | action | sync |\n|---|---|---|---|\n| a | 0 | wait | await |\n| a | 1 | wait | await |\n' },
      { 'x.md': '# $seq s\n| id | t |\n|---|---|\n| a | 0 | 1 |\n' },
      { 'x.md': '# $seq s\n', 'y.md': '# $seq s\n' },
      { 'x.md': '# $consts\n| name | normal |\n|---|---|\n| a |  |\n' },
      { 'x.md': '# $consts\n| name | normal |\n|---|---|\n|  | 1 |\n' },
      { 'x.md': '# $consts\n| name | normal |\n|---|---|\n| a | 1 |\n| a | 2 |\n' },
      { 'x.md': '# $seq s\n$x: {a: }\n' },
    ];
    for (const f of bad) expect(() => loadChoreo(f), JSON.stringify(f)).toThrow(/^E_CHOREO_LOAD: x\.md|^E_CHOREO_LOAD: y\.md/);
    // eases: the kit's by default, the game's list when given
    expect(() => loadChoreo(seq('id | t | action | sync | ease', 'a | 0 | wait | await | sineIn'))).toThrow(/ease "sineIn"/);
    expect(loadChoreo(seq('id | t | action | sync | ease', 'a | 0 | wait | await | sineIn'), { eases: ['sineIn'] }).sequences.s.rows[0].ease).toBe('sineIn');
  });
});

describe('choreo: the director', () => {
  const play = (o: { mode?: 'normal' | 'quick' | 'turbo'; count?: number; skipAt?: number; actions?: boolean } = {}) => {
    const loop = new GameLoop();
    const fired: ChoreoEvent[] = [];
    const dealt = vi.fn();
    const d = new Director({
      choreo: loadChoreo(files),
      loop,
      actions: o.actions === false ? undefined : { tween: () => {}, fx: () => {}, call: (e, _c, fn) => fn === 'dealt' && dealt(e.props) },
      sink: (e) => fired.push(e),
    });
    return { loop, d, fired, dealt };
  };

  it('logical times: each, mode constants, @row.end, nested runs, resolve; the log keeps t exact, at within a frame', async () => {
    const { loop, d, dealt } = play();
    const end = await settle(loop, d.run('deal', { count: 3 }));
    const fly = d.log.filter((e) => e.row === 'fly');
    expect(fly.map((e) => [e.t, e.target, e.vars.k, e.props[0]])).toEqual([
      [0, 'card0', 0, { name: 'x', from: 0, to: 0 }],
      [120, 'card1', 1, { name: 'x', from: 0, to: 100 }],
      [240, 'card2', 2, { name: 'x', from: 0, to: 200 }],
    ]);
    for (const e of d.log) expect(e.at - e.t).toBeGreaterThanOrEqual(-1e-6), expect(e.at - e.t).toBeLessThanOrEqual(1000 / 60 + 1e-6);
    // @fly.end = the latest card's end: 240 + 300
    expect(d.log.find((e) => e.row === 'stars')!.t).toBe(640);
    const glow = d.log.filter((e) => e.row === 'glow');
    expect(glow.map((e) => e.t)).toEqual([640, 690, 740]);
    expect(glow[0].chain.map((c) => c.seq)).toEqual(['deal', 'stars']);
    // stars ends at 740 + 200 = 940; done at max(940, 540) → resolve
    expect(end).toBe(940);
    expect(dealt).toHaveBeenCalledWith([{ name: 'total', set: 3 }]);
    expect(d.log.filter((e) => e.kind === 'seq').map((e) => `${e.seq}${e.row}`)).toEqual(['deal^', 'stars^', 'stars$', 'deal$']);
    expect(d.log.find((e) => e.row === 'fly')!.sound).toBe('whoosh');
    expect(d.active).toBe(false);
  });

  it('speed modes pick their constants; when switches rows off; an empty each binds nothing', async () => {
    const q = play({ mode: 'quick' });
    await settle(q.loop, q.d.run('deal', { count: 2 }, { mode: 'quick' }));
    expect(q.d.log.filter((e) => e.row === 'fly').map((e) => [e.t, e.dur])).toEqual([[0, 150], [60, 150]]);
    expect(q.d.log.some((e) => e.row === 'stars')).toBe(false); // count > 2 is false
    const t = play();
    await settle(t.loop, t.d.run('deal', { count: 0 }, { mode: 'turbo' }));
    expect(t.d.log.some((e) => e.row === 'fly')).toBe(false);
  });

  it('skip: not started now-rows start now, running ones end now, cut rows drop; a sequence without $skip is untouched', async () => {
    const { loop, d } = play();
    const p = d.run('deal', { count: 3 });
    while (loop.time < 0.15) loop.step(1 / 60);
    d.skip();
    await settle(loop, p);
    const fly = d.log.filter((e) => e.row === 'fly');
    // card1 started at 120 (before the skip); card2 was not started at 150 ms → starts now (the skip moment)
    expect(fly[1].t).toBe(120);
    expect(fly[2].t).toBeGreaterThanOrEqual(150);
    expect(fly[2].t).toBeLessThan(240);
    expect(d.log.filter((e) => e.row === 'land').length).toBe(0); // cut
  });

  it('poll: rows wait for a condition checked every frame with a fresh rand; cancel rejects; unknown sequence', async () => {
    const loop = new GameLoop();
    const choreo = loadChoreo({ 'p.md': '# $seq p\n| id | t | action | sync |\n|---|---|---|---|\n| go | poll: now > 100 and rand < 0.5 | wait | await |\n' });
    let n = 0;
    const d = new Director({ choreo, loop, random: () => (n++ % 2 ? 0.1 : 0.9) });
    const end = await settle(loop, d.run('p'));
    expect(end).toBeGreaterThan(100);
    const p = d.run('p');
    d.cancel();
    await expect(p).rejects.toThrow(/^E_CHOREO_RUN: p cancelled/);
    expect(() => d.run('nope')).toThrow(/^E_CHOREO_RUN: unknown sequence/);
    d.dispose();
  });

  it('a row with no action and no sink is E_CHOREO_ACTION; formula errors carry the row', async () => {
    const loop = new GameLoop();
    const d = new Director({ choreo: loadChoreo(files), loop, actions: {} });
    await expect(settle(loop, d.run('deal', { count: 1 }))).rejects.toThrow(/^E_CHOREO_ACTION: deal\.md:deal:fly: no action "tween"/);
    const e = new Director({ choreo: loadChoreo(files), loop, sink: () => {} });
    await expect(settle(loop, e.run('deal', {}))).rejects.toThrow(/^E_CHOREO_RUN: deal\.md:deal:fly: each: .*unknown name "count"/);
  });
});

describe('choreo: the kit\'s actions', () => {
  it('tween: from → to over dur with the ease, a late row starts that far in, skip jumps to the end', async () => {
    const loop = new GameLoop();
    const tweens = new Tweens();
    loop.add((dt) => tweens.update(dt), 'game');
    const cards = [0, 1, 2].map(() => ({ x: 0, alpha: 0, scale: { x: 1 } }));
    const stars = [0, 1, 2].map(() => ({ alpha: 0 }));
    const objs: Record<string, object> = { ...Object.fromEntries(cards.map((c, i) => [`card${i}`, c])), ...Object.fromEntries(stars.map((s, i) => [`star${i}`, s])) };
    const calls: unknown[] = [];
    const actions = kitActions({ tweens, target: (n) => objs[n], fx: undefined, calls: { dealt: (_e, a) => calls.push(a) } });
    const d = new Director({ choreo: loadChoreo(files), loop, actions: { ...actions, fx: () => {} } });
    await settle(loop, d.run('deal', { count: 3 }));
    loop.step(0.5);
    expect(cards.map((c) => c.x)).toEqual([0, 100, 200]);
    expect(stars.map((s) => s.alpha)).toEqual([1, 1, 1]);
    expect(calls).toEqual([{ total: 3 }]);
    // set, by, a dotted path, an instant row
    const one = loadChoreo({ 'o.md': '# $seq o\n| id | t | dur | target | action | value | sync | ease |\n|---|---|---|---|---|---|---|---|\n| a | 0 | 100 | card0 | tween:x | x += 50; scale.x = 3 | await | linear |\n| b | 0 |  | card1 | tween:x | x → 7 | await | |\n' });
    const d2 = new Director({ choreo: one, loop, actions });
    const p = d2.run('o');
    loop.step(1 / 60);
    expect(cards[0].scale.x).toBe(3);
    expect(cards[1].x).toBe(7);
    await settle(loop, p);
    loop.step(0.2);
    expect(cards[0].x).toBe(50);
  });

  it('clip with params, fx at a node, sound, missing pieces are E_CHOREO_ACTION', async () => {
    const loop = new GameLoop();
    const played: unknown[] = [];
    const aborted: string[] = [];
    const clips = { play: (clip: unknown, o: unknown) => (played.push([clip, o]), { abort: () => aborted.push('x'), done: Promise.resolve() }) };
    const fx = new Fx(null);
    fx.tables({ effects: { sparkle: particleConfig({ duration: 0.1, bursts: [{ time: 0, count: 3, cycles: 1, interval: 0, prob: 1 }] }) } });
    const node = new FxNode(fx, 'sky', 'sparkle', { autostart: false });
    const scene = { byId: new Map<string, object>([['box', new Container()]]), components: new Map<string, unknown>([['sky', { node }]]) };
    const sounds: string[] = [];
    const actions = kitActions({ clips: clips as never, clipOf: (n) => (n === 'bounce' ? ({ tracks: [] } as never) : undefined), fx, scene, sound: { play: (n) => sounds.push(n) } });
    const choreo = loadChoreo({
      'a.md': `# $seq a
$skip: on
| id | t | dur | target | action | value | sync | skip |
|---|---|---|---|---|---|---|---|
| c | 0 | 500 | | clip:bounce | toX = 120; toY = -4 | await | now |
| f | 0 | | sky | fx:sparkle | | parallel | |
| g | 0 | | box | fx:sparkle | | parallel | |
| s | 0 | | | sound:ding | | parallel | |
`,
    });
    const d = new Director({ choreo, loop, actions });
    const p = d.run('a');
    loop.step(1 / 60);
    d.skip();
    await settle(loop, p);
    expect(played[0]).toEqual([{ tracks: [] }, { scene, params: { toX: 120, toY: -4 } }]);
    expect(aborted).toEqual(['x']);
    expect(node.host.size).toBe(1);
    expect(fx.size).toBe(1);
    expect(sounds).toEqual(['ding']);
    for (const [deps, action] of [
      [{}, 'clip:bounce'],
      [{ clips: clips as never }, 'clip:nope'],
      [{}, 'fx:x'],
      [{}, 'sound:x'],
      [{}, 'call:x'],
      [{ scene }, 'tween:x'],
    ] as const) {
      const c = loadChoreo({ 'b.md': `# $seq b\n| id | t | target | action | value | sync |\n|---|---|---|---|---|---|\n| r | 0 | nobody | ${action} | x → 1 | await |\n` });
      const dd = new Director({ choreo: c, loop, actions: kitActions(deps as never) });
      await expect(settle(loop, dd.run('b')), action).rejects.toThrow(/^E_CHOREO_ACTION: /);
    }
  });
});

describe('choreo: verify against a reference timeline', () => {
  const TIMELINE: TimelineDoc = {
    meta: {},
    sequences: {
      deal: { steps: [{ t: 'step * k', dur: { normal: 300, quick: 150, turbo: 300 }, action: 'tween' }, { t: 'flyEnd', dur: 0 }, { t: { after: 'fly' }, dur: 0 }] },
      stars: { steps: [{ t: 0, dur: 0 }], order: { a: 1 } },
    },
  };
  const log = async (mode: 'normal' | 'quick' = 'normal') => {
    const loop = new GameLoop();
    const d = new Director({ choreo: loadChoreo(files), loop, sink: () => {} });
    await settle(loop, d.run('deal', { count: 3 }, { mode }));
    return d.log;
  };

  it('times and durations match within a frame / exactly; order-only steps; coverage; findings formatted', async () => {
    const l = await log();
    const r = verifyLog({ timeline: TIMELINE, log: l, mode: 'normal', vars: { step: 120 }, aliases: { flyEnd: 't_deal_0 + 300' }, sequences: ['deal'] });
    expect(r.findings, formatFindings(r.findings)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(6); // 3 fly + 3 land (each card lands at its own fly's end)
    expect(r.covered).toEqual(['deal#0', 'deal#1', 'deal#2']);
    expect(Object.keys(r.orderOnly)).toEqual(['deal#2']);
    // a wrong number is a finding
    const bad = verifyLog({ timeline: TIMELINE, log: l, mode: 'normal', vars: { step: 100 }, aliases: { flyEnd: 't_deal_0 + 300' }, sequences: ['deal'] });
    expect(bad.ok).toBe(false);
    expect(formatFindings(bad.findings)).toMatch(/^time deal#0 deal:fly k=1 expected 100\.0000 got 120\.0000/m);
    // quick: durations by mode
    const q = verifyLog({ timeline: TIMELINE, log: await log('quick'), mode: 'quick', vars: { step: 60 }, aliases: { flyEnd: 't_deal_0 + 150' }, sequences: ['deal'] });
    expect(q.findings.filter((f) => f.what === 'dur')).toEqual([]);
    expect(locate(TIMELINE, 'deal#9')).toBeUndefined();
    expect(locate(TIMELINE, 'stars:order')).toBeNull();
  });

  it('missing steps, unknown refs, unevaluable strings, variants', async () => {
    const l = await log();
    const tl: TimelineDoc = { meta: {}, sequences: { deal: { steps: [{ t: { wide: 5, tall: 9 }, dur: 0 }, { t: 'nonsense(', dur: 0 }, { t: 0, dur: 0 }, { t: 0, dur: 0 }] } } };
    const r = verifyLog({ timeline: tl, log: l, mode: 'normal', sequences: ['deal'], notPlayed: { 'deal#3': 'not in this scenario' }, variant: (o) => o.wide });
    const what = new Set(r.findings.map((f) => `${f.what} ${f.ref}`));
    expect(what.has('time deal#0')).toBe(true); // variant 5 ≠ fly times
    expect(what.has('unevaluable deal#1')).toBe(true);
    expect(what.has('missing deal#3')).toBe(false);
    const u = verifyLog({ timeline: { meta: {}, sequences: {} }, log: l, mode: 'normal' });
    expect(u.findings.some((f) => f.what === 'unknown-ref')).toBe(true);
  });

  it('live probes through the tick model: ok, on the grid, off, static fallback, accepted, not applicable', () => {
    expect(stepTicks(0)).toEqual([0, 0]);
    expect(stepTicks(100)).toEqual([6, 7]);
    expect(tickGrid([100, 100])).toEqual({ lo: 200, hi: (14 * 1000) / 60 });
    const probe = (id: string, median: number | null, expected: number | null = null) => ({ id, seq: 'deal', ref: '', what: id, expected, live: { median, min: median, max: median, n: median === null ? 0 : 5, nClean: 5 } });
    const live = { meta: {}, probes: [probe('a', 300), probe('b', 225), probe('c', 900), probe('d', null, 300), probe('e', 900), probe('f', 1), probe('g', 1)] };
    const r = verifyLive({
      live,
      measures: {
        a: { samples: [{ d: 300 }] },
        b: { samples: [{ d: 200, parts: [100, 100] }], extraTicks: 1 },
        c: { samples: [{ d: 300 }] },
        d: { samples: [{ d: 300 }] },
        e: { samples: [{ d: 300 }], accept: 'kept on purpose' },
        f: { na: 'not in this game' },
        g: { samples: [] },
        zz: { samples: [{ d: 1 }] },
      },
    });
    const v = Object.fromEntries(r.rows.map((x) => [x.id, x.verdict]));
    expect(v).toEqual({ a: 'ok', b: 'grid', c: 'off', d: 'static', e: 'accepted', f: 'na' });
    expect(r.findings.map((f) => `${f.what} ${f.id}`).sort()).toEqual(['no-samples g', 'off-grid c', 'unknown-probe zz']);
    expect(r.ok).toBe(false);
  });
});

describe('choreography log limit', () => {
  it('keeps the newest entries within logLimit (a game idles for hours)', async () => {
    const { Director: D } = await import('../src/choreo/director.js');
    const d = new D({ choreo: { seqs: new Map(), consts: {} } as never, loop: { add: () => () => {}, now: () => 0 } as never, logLimit: 8 });
    for (let i = 0; i < 50; i++) (d as unknown as { record(e: unknown): void }).record({ t: i } as never);
    expect(d.log.length).toBeLessThanOrEqual(8);
    expect((d.log.at(-1) as unknown as { t: number }).t).toBe(49);
  });
});
