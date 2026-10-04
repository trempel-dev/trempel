import { describe, it, expect } from 'vitest';
import { Animator } from '../src/anim/player';
import type { AnimClip } from '../src/anim/types';
import { createMockBackend, createMockClock, isMockNode } from './helpers/mockBackend';

function xClip(from: number, to: number, ease?: 'quadIn'): AnimClip {
  return {
    tracks: [{ target: '$s', property: 'x', keys: [{ t: 0, v: from }, { t: 1, v: to, ease }] }],
  };
}

// Flush pending microtasks + one macrotask so sequence()'s awaits advance between ticks.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('player — interpolation', () => {
  it('samples initial value on play and interpolates linearly', async () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const node = backend.createNode('g', {});

    const h = anim.play(xClip(0, 10), { targets: { $s: node } });
    expect(isMockNode(node).props.x).toBe(0); // sampled at t=0 on play

    clock.t = 500;
    anim.tick();
    expect(isMockNode(node).props.x).toBeCloseTo(5, 6);

    clock.t = 1000;
    anim.tick();
    expect(isMockNode(node).props.x).toBeCloseTo(10, 6);
    await h.done; // completed at duration
  });

  it('applies the segment ease', () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const node = backend.createNode('g', {});

    anim.play(xClip(0, 10, 'quadIn'), { targets: { $s: node } });
    clock.t = 500;
    anim.tick(); // p=0.5, quadIn=0.25 → 2.5
    expect(isMockNode(node).props.x).toBeCloseTo(2.5, 6);
  });

  it('applies a track to multiple resolved targets (array)', () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const a = backend.createNode('g', {});
    const b = backend.createNode('g', {});

    anim.play(xClip(0, 8), { targets: { $s: [a, b] } });
    clock.t = 500;
    anim.tick();
    expect(isMockNode(a).props.x).toBeCloseTo(4, 6);
    expect(isMockNode(b).props.x).toBeCloseTo(4, 6);
  });
});

describe('player — markers', () => {
  it('emits markers as their time is crossed', () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const node = backend.createNode('g', {});
    const fired: string[] = [];

    const clip: AnimClip = {
      tracks: [{ target: '$s', property: 'x', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }],
      markers: [{ t: 0.5, name: 'mid' }, { t: 1, name: 'end' }],
    };
    anim.play(clip, { targets: { $s: node }, onMarker: (n) => fired.push(n) });

    clock.t = 400;
    anim.tick();
    expect(fired).toEqual([]);
    clock.t = 600;
    anim.tick();
    expect(fired).toEqual(['mid']);
    clock.t = 1000;
    anim.tick();
    expect(fired).toEqual(['mid', 'end']);
  });
});

describe('player — abort', () => {
  it('resolves done and stops writing after abort', async () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const node = backend.createNode('g', {});

    const h = anim.play(xClip(0, 10), { targets: { $s: node } });
    clock.t = 300;
    anim.tick();
    const frozen = isMockNode(node).props.x;
    h.abort();
    await h.done; // resolves on abort

    clock.t = 900;
    anim.tick();
    expect(isMockNode(node).props.x).toBe(frozen); // unchanged after abort
  });
});

describe('player — composition', () => {
  it('parallel resolves when all children finish', async () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const a = backend.createNode('g', {});
    const b = backend.createNode('g', {});

    const h = anim.parallel(
      anim.play(xClip(0, 10), { targets: { $s: a } }),
      anim.play(xClip(0, 20), { targets: { $s: b } }),
    );

    clock.t = 1000;
    anim.tick();
    await h.done; // resolves once both children finished at their duration
    expect(isMockNode(a).props.x).toBeCloseTo(10, 6);
    expect(isMockNode(b).props.x).toBeCloseTo(20, 6);
  });

  it('sequence runs clips one after another', async () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const node = backend.createNode('g', {});

    const c1: AnimClip = {
      tracks: [{ target: '$s', property: 'x', keys: [{ t: 0, v: 0 }, { t: 0.3, v: 5 }] }],
    };
    const c2: AnimClip = {
      tracks: [{ target: '$s', property: 'y', keys: [{ t: 0, v: 0 }, { t: 0.3, v: 9 }] }],
    };
    const seq = anim.sequence([
      { clip: c1, opts: { targets: { $s: node } } },
      { clip: c2, opts: { targets: { $s: node } } },
    ]);

    for (let ms = 0; ms <= 800; ms += 50) {
      clock.t = ms;
      anim.tick();
      await flush();
    }
    await seq.done;

    expect(isMockNode(node).props.x).toBeCloseTo(5, 6);
    expect(isMockNode(node).props.y).toBeCloseTo(9, 6);
  });
});

describe('player — dynamic speed', () => {
  it('reads speed live each frame', () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const anim = new Animator(backend, clock);
    const node = backend.createNode('g', {});
    let speed = 1;

    anim.play(xClip(0, 10), { targets: { $s: node }, speed: () => speed });

    clock.t = 100;
    anim.tick(); // 0.1s * 1 → localTime 0.1 → x=1
    expect(isMockNode(node).props.x).toBeCloseTo(1, 6);

    speed = 4;
    clock.t = 200;
    anim.tick(); // 0.1s * 4 → localTime 0.5 → x=5
    expect(isMockNode(node).props.x).toBeCloseTo(5, 6);
  });
});
