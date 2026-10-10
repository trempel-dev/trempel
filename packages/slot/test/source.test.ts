// Round sources: fixtures (order, buy match, walk all, pin, select), HTTP (POST → feed), a function.
import { describe, expect, it } from 'vitest';
import { fixtureSource, fnSource, httpSource } from '../src/feed/source.js';
import { FREE, LINES, LOSE } from './helpers.js';

const files = [
  { name: 'b-lines', transforms: LINES.transforms },
  { name: 'a-lose', transforms: LOSE.transforms },
  { name: 'c-buy', buy: 'fs', transforms: FREE.transforms },
];
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'no error', (e: Error) => e.message.split(':')[0]);

describe('sources', () => {
  it('fixtures: by name round-robin; a spin takes spins, a buy its buy; walk all; select and pin', async () => {
    const s = fixtureSource(files);
    expect(s.names).toEqual(['a-lose', 'b-lines', 'c-buy']);
    const spin = { bet: 1, buy: null };
    expect((await s.next(spin)).name).toBe('a-lose');
    expect((await s.next(spin)).name).toBe('b-lines');
    expect((await s.next(spin)).name).toBe('a-lose');
    expect(await s.next({ bet: 1, buy: 'fs' })).toMatchObject({ name: 'c-buy', buy: 'fs' });
    const all = fixtureSource(files, { walk: 'all' });
    expect([await all.next(spin), await all.next(spin), await all.next(spin)].map((f) => f.name)).toEqual(['a-lose', 'b-lines', 'c-buy']);
    s.select('b-lines');
    expect((await s.next(spin)).name).toBe('b-lines');
    s.select('a-lose', true);
    expect([(await s.next(spin)).name, (await s.next(spin)).name]).toEqual(['a-lose', 'a-lose']);
    await expect(fixtureSource(files, { pin: 'b-lines' }).next(spin)).resolves.toMatchObject({ name: 'b-lines' });
    expect(() => s.select('nope')).toThrow(/^E_SOURCE_FIXTURE/);
    expect(() => fixtureSource([])).toThrow(/^E_SOURCE_FIXTURE/);
    expect(await code(fixtureSource([files[0]]).next({ bet: 1, buy: 'fs' }))).toBe('E_SOURCE_FIXTURE');
    // a served feed is a copy: the player may not spoil the fixture
    const f = await fixtureSource(files, { pin: 'a-lose' }).next(spin);
    (f.transforms[0] as { type: string }).type = 'x';
    expect((await fixtureSource(files, { pin: 'a-lose' }).next(spin)).transforms[0].type).toBe('step');
  });

  it('http: POSTs the request, takes a feed or a bare list; fails loud', async () => {
    const calls: { url: string; body: string; method: string }[] = [];
    const answer = (body: unknown, ok = true) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body), method: String(init.method) });
        return { ok, status: ok ? 200 : 503, statusText: ok ? 'OK' : 'Unavailable', json: async () => body } as Response;
      }) as unknown as typeof fetch;
    const s = httpSource('https://rgs.test/round', { fetch: answer({ name: 'r7', transforms: LOSE.transforms }) });
    expect(await s.next({ bet: 2, buy: null })).toEqual({ name: 'r7', buy: null, transforms: LOSE.transforms });
    expect(calls[0]).toEqual({ url: 'https://rgs.test/round', method: 'POST', body: '{"bet":2,"buy":null}' });
    const bare = await httpSource('u', { fetch: answer(LINES.transforms) }).next({ bet: 1, buy: 'fs' });
    expect(bare).toMatchObject({ name: 'u#1', buy: 'fs' });
    expect(await code(httpSource('u', { fetch: answer({}, false) }).next({ bet: 1, buy: null }))).toBe('E_SOURCE_HTTP');
    expect(await code(httpSource('u', { fetch: answer({ nope: 1 }) }).next({ bet: 1, buy: null }))).toBe('E_SOURCE_HTTP');
  });

  it('fn: a function in the process', async () => {
    const s = fnSource((req) => ({ name: `made for ${req.bet}`, buy: req.buy, transforms: LOSE.transforms }));
    expect((await s.next({ bet: 5, buy: null })).name).toBe('made for 5');
  });
});
