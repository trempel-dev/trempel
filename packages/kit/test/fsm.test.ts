import { describe, expect, it } from 'vitest';
import { StateMachine, abortable } from '../src/flow/fsm.js';
import { EventBus } from '../src/flow/bus.js';
import { GameLoop, isAbort } from '../src/time/loop.js';

type S = 'idle' | 'play' | 'stop';

describe('StateMachine — cancellation of async enter', () => {
  it('a transition aborts the previous unfinished enter', async () => {
    const loop = new GameLoop();
    const log: string[] = [];
    const fsm = new StateMachine<{ loop: GameLoop }, S>({ loop })
      .add('idle', { enter: () => void log.push('idle') })
      .add('play', {
        enter: async (ctx, signal) => {
          log.push('play:start');
          await ctx.loop.wait(1, { signal });
          log.push('play:end (must not happen)');
        },
        exit: () => void log.push('play:exit'),
      })
      .add('stop', { enter: () => void log.push('stop') });
    await fsm.transition('idle');
    const playing = fsm.transition('play');
    loop.advance(0.5);
    await fsm.transition('stop');
    await playing; // resolves (aborted), does not reject
    loop.advance(2);
    expect(log).toEqual(['idle', 'play:start', 'play:exit', 'stop']);
    expect(fsm.state).toBe('stop');
  });

  it('transition from inside enter keeps the new state cancellable', async () => {
    const loop = new GameLoop();
    let aborted = false;
    const fsm = new StateMachine<null, S>(null);
    fsm.add('idle', {}).add('play', { enter: () => void fsm.transition('stop') }).add('stop', {
      enter: async (_c, signal) => {
        try {
          await loop.wait(1, { signal });
        } catch (e) {
          aborted = isAbort(e);
          throw e;
        }
      },
    });
    await fsm.transition('play');
    expect(fsm.state).toBe('stop');
    await fsm.transition('idle');
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
  });

  it('fails loud: unknown state, error in enter', async () => {
    const fsm = new StateMachine<null, S>(null).add('idle', { enter: () => { throw new Error('boom'); } });
    await expect(fsm.transition('play')).rejects.toThrow(/unknown state "play"/);
    await expect(fsm.transition('idle')).rejects.toThrow('boom');
  });

  it('update runs the current state, onChange reports', async () => {
    const seen: string[] = [];
    let ticks = 0;
    const fsm = new StateMachine<null, S>(null).add('idle', { update: () => void ticks++ }).add('play', {});
    fsm.onChange((to, from) => seen.push(`${from}->${to}`));
    await fsm.transition('idle');
    fsm.update(0.016);
    await fsm.transition('play');
    fsm.update(0.016);
    expect(ticks).toBe(1);
    expect(seen).toEqual(['null->idle', 'idle->play']);
  });

  it('abortable rejects on abort', async () => {
    const c = new AbortController();
    const p = abortable(new Promise(() => {}), c.signal);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
});

describe('EventBus', () => {
  it('typed on/once/off, errors rethrown after dispatch', () => {
    const bus = new EventBus<{ 'intent:play': undefined; win: { amount: number } }>();
    const got: number[] = [];
    const off = bus.on('win', (p) => got.push(p.amount));
    bus.once('win', (p) => got.push(p.amount * 10));
    bus.emit('win', { amount: 1 });
    bus.emit('win', { amount: 2 });
    off();
    bus.emit('win', { amount: 3 });
    expect(got).toEqual([1, 10, 2]);
    let second = false;
    bus.on('intent:play', () => {
      throw new Error('bad handler');
    });
    bus.on('intent:play', () => (second = true));
    expect(() => bus.emit('intent:play')).toThrow('bad handler');
    expect(second).toBe(true);
  });
});
