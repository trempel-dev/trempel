import { describe, expect, it } from 'vitest';
import { EventPlayer, type PlayContext } from '../src/flow/player.js';
import { GameLoop, isAbort } from '../src/time/loop.js';

type Ev = { type: 'play'; grid: string } | { type: 'win'; amount: number } | { type: 'end' };

/** Run the loop until the promise settles (headless clock). */
async function settle<T>(loop: GameLoop, p: Promise<T>, max = 10): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  p.then((v) => ((done = true), (value = v)), (e) => ((done = true), (error = e)));
  for (let t = 0; t < max && !done; t += 1 / 60) {
    loop.step(1 / 60);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!done) throw new Error('did not settle');
  if (error) throw error;
  return value as T;
}

function make(loop: GameLoop, log: string[], extra: Partial<ConstructorParameters<typeof EventPlayer<Ev>>[0]> = {}) {
  return new EventPlayer<Ev>({
    loop,
    handlers: {
      play: async (e, ctx) => {
        log.push(`play ${e.grid}`);
        await ctx.wait(1);
        log.push(ctx.skipping ? 'play skipped' : 'play done');
      },
      win: async (e, ctx: PlayContext<Ev>) => {
        log.push(`win ${e.amount}`);
        await ctx.wait(2);
      },
      end: () => void log.push('end'),
    },
    ...extra,
  });
}

describe('EventPlayer — book playback, headless', () => {
  it('plays a book in order, waits on game time', async () => {
    const loop = new GameLoop();
    const log: string[] = [];
    const p = make(loop, log);
    const t0 = loop.time;
    await settle(loop, p.play([{ type: 'play', grid: 'A' }, { type: 'win', amount: 5 }, { type: 'end' }]));
    expect(log).toEqual(['play A', 'play done', 'win 5', 'end']);
    expect(loop.time - t0).toBeGreaterThanOrEqual(3 - 1e-6);
  });

  it('stream: push() appends while playing', async () => {
    const loop = new GameLoop();
    const log: string[] = [];
    const p = make(loop, log);
    const a = p.push({ type: 'play', grid: 'A' });
    const b = p.push({ type: 'end' });
    expect(p.busy).toBe(true);
    await settle(loop, Promise.all([a, b]));
    expect(log).toEqual(['play A', 'play done', 'end']);
    expect(p.busy).toBe(false);
  });

  it('skip(): waits resolve now, handlers see skipping', async () => {
    const loop = new GameLoop();
    const log: string[] = [];
    const p = make(loop, log);
    const done = p.play([{ type: 'play', grid: 'A' }, { type: 'win', amount: 3 }]);
    loop.advance(0.1);
    p.skip();
    await settle(loop, done, 0.2);
    expect(log).toEqual(['play A', 'play skipped', 'win 3']);
    expect(loop.time).toBeLessThan(0.5);
  });

  it('cancel(): aborts the current event and drops the queue', async () => {
    const loop = new GameLoop();
    const log: string[] = [];
    const p = make(loop, log);
    const done = p.play([{ type: 'play', grid: 'A' }, { type: 'end' }]);
    loop.advance(0.2);
    p.cancel();
    await expect(done).rejects.toSatisfy(isAbort);
    loop.advance(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['play A']);
    // usable again after a cancel
    await settle(loop, p.play([{ type: 'end' }]));
    expect(log).toEqual(['play A', 'end']);
  });

  it('timeout: a hanging handler fails loud instead of hanging the round', async () => {
    const loop = new GameLoop();
    const p = new EventPlayer<Ev>({ loop, timeout: 0.5, handlers: { end: () => new Promise(() => {}) } });
    await expect(settle(loop, p.play([{ type: 'end' }]))).rejects.toThrow(/did not finish in 0.5s/);
  });

  it('unknown event: throws by default, skipped on request', async () => {
    const loop = new GameLoop();
    const strict = new EventPlayer<Ev>({ loop, handlers: {} });
    await expect(strict.play([{ type: 'end' }])).rejects.toThrow(/no handler for event "end"/);
    const lax = new EventPlayer<Ev>({ loop, handlers: {}, unknown: 'skip' });
    await lax.play([{ type: 'end' }]);
  });

  it('platform pause freezes the book', async () => {
    const loop = new GameLoop();
    const log: string[] = [];
    const p = make(loop, log);
    const done = p.play([{ type: 'play', grid: 'A' }]);
    loop.suspend();
    loop.advance(5);
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['play A']);
    loop.unsuspend();
    await settle(loop, done);
    expect(log).toEqual(['play A', 'play done']);
  });
});
