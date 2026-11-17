import { describe, expect, it } from 'vitest';
import type { RendererBackend } from '@trempel/scene';
import { Clips } from '../src/anim/clips.js';
import { GameLoop } from '../src/time/loop.js';

function mock(): RendererBackend & { set: Record<string, unknown>[] } {
  const set: Record<string, unknown>[] = [];
  return {
    set,
    createNode: () => ({}),
    setProp: (n, k, v) => void ((n as Record<string, unknown>)[k] = v),
    onClick: () => {},
    addChild: () => {},
    mount: () => {},
    getBounds: () => ({ x: 0, y: 0, w: 0, h: 0 }),
  };
}

const CLIP = { tracks: [{ target: 'btn', property: 'alpha', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }], markers: [{ t: 0.5, name: 'mid' }] };

describe('Clips — Trempel Animator on the kit loop', () => {
  it('plays on loop time, resolves node ids in the scene, markers, speed, platform pause', async () => {
    const loop = new GameLoop();
    const clips = new Clips(mock(), loop);
    const node: Record<string, unknown> = {};
    const markers: string[] = [];
    const h = clips.play(CLIP, { scene: { byId: new Map([['btn', node]]) }, onMarker: (m) => markers.push(m) });
    loop.advance(0.55);
    expect(node.alpha).toBeCloseTo(0.55, 1);
    expect(markers).toEqual(['mid']);
    loop.suspend();
    loop.advance(2);
    expect(node.alpha).toBeCloseTo(0.55, 1);
    loop.unsuspend();
    clips.speed = 2;
    loop.advance(0.3);
    await h.done;
    expect(node.alpha).toBe(1);
  });
});
