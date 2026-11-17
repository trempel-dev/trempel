import { describe, expect, it } from 'vitest';
import { GameLoop, isAbort } from '../src/time/loop.js';
import { Tweens } from '../src/anim/tweens.js';

describe('GameLoop — time comes from above', () => {
  it('steps ui and game channels, clamps dt, drives the ticker adapter', () => {
    const loop = new GameLoop();
    const seen: string[] = [];
    loop.add((dt) => seen.push(`ui ${dt.toFixed(2)}`), 'ui');
    loop.add((dt) => seen.push(`game ${dt.toFixed(2)}`));
    const ticks: number[] = [];
    loop.ticker.add((t) => ticks.push(t.deltaMS));
    loop.step(0.5); // clamped to 0.1
    expect(seen).toEqual(['ui 0.10', 'game 0.10']);
    expect(ticks).toEqual([100]);
    expect(loop.ticker.lastTime).toBeCloseTo(100);
  });

  it('platform pause (suspend) stops everything: tweens, timers, ticker', async () => {
    const loop = new GameLoop();
    const tweens = new Tweens();
    loop.add((dt) => tweens.update(dt), 'ui');
    const obj = { x: 0 };
    void tweens.to(obj, { x: 10 }, 1, 'linear');
    let ticks = 0;
    loop.ticker.add(() => ticks++);
    let fired = false;
    void loop.wait(0.5).then(() => (fired = true));
    loop.advance(0.25);
    expect(obj.x).toBeCloseTo(2.5);
    loop.suspend();
    loop.advance(5);
    expect(obj.x).toBeCloseTo(2.5);
    const before = ticks;
    loop.advance(1);
    expect(ticks).toBe(before);
    await Promise.resolve();
    expect(fired).toBe(false);
    loop.unsuspend();
    loop.advance(0.3);
    await Promise.resolve();
    expect(fired).toBe(true);
  });

  it('game pause stops the game channel and game timers, the ui channel keeps running', async () => {
    const loop = new GameLoop();
    let game = 0;
    let ui = 0;
    loop.add((dt) => (game += dt));
    loop.add((dt) => (ui += dt), 'ui');
    let gameTimer = false;
    let uiTimer = false;
    void loop.wait(0.2).then(() => (gameTimer = true));
    void loop.wait(0.2, { channel: 'ui' }).then(() => (uiTimer = true));
    loop.pause();
    loop.advance(1);
    await Promise.resolve();
    expect(game).toBe(0);
    expect(ui).toBeCloseTo(1);
    expect(uiTimer).toBe(true);
    expect(gameTimer).toBe(false);
    loop.resume();
    loop.advance(0.25);
    await Promise.resolve();
    expect(gameTimer).toBe(true);
    expect(game).toBeCloseTo(0.25);
  });

  it('wait rejects with AbortError on abort', async () => {
    const loop = new GameLoop();
    const ctrl = new AbortController();
    const p = loop.wait(1, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
});

describe('Tweens', () => {
  it('to / from / kill / delay', async () => {
    const tw = new Tweens();
    const a = { x: 0, y: 5 };
    const done = tw.to(a, { x: 10 }, 1, { ease: 'linear', delay: 0.5 });
    tw.update(0.5);
    expect(a.x).toBe(0);
    tw.update(0.5);
    expect(a.x).toBeCloseTo(5);
    tw.kill(a);
    tw.update(0.1);
    await done;
    expect(a.x).toBeCloseTo(5);
    void tw.from(a, { y: 0 }, 1, 'linear');
    expect(a.y).toBe(0);
    tw.update(1);
    expect(a.y).toBe(5);
    expect(() => tw.to(a, { x: 1 }, 1, 'nope' as never)).toThrow(/unknown ease/);
  });
});
