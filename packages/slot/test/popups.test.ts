// Slot overlays as popup scenes: the state → popup rule, the binder that opens/closes declared
// popups, and every popup heir mounting on a minimal base against its contract.
import { describe, expect, it } from 'vitest';
import { GameLoop } from '@trempel/kit/testing';
import { Registry, mount, type RendererBackend } from '@trempel/scene/core';
import { SLOT_POPUPS, SLOT_POPUP_NAMES, initialSlotState, slotPopupOf, bindSlotPopups } from '../src/index.js';

const backend = (): RendererBackend => ({
  createNode: (tag, attrs) => ({ tag, attrs, props: {} as Record<string, unknown> }),
  setProp: (n, k, v) => void ((n as { props: Record<string, unknown> }).props[k] = v),
  onClick: () => {},
  addChild: () => {},
  mount: () => {},
  getBounds: () => ({ x: 0, y: 0, w: 0, h: 0 }),
});

const TEXTS: Record<string, string[]> = { fsIntro: ['fsIntroText'], fsOutro: ['fsOutroText'], bigwin: ['bigwinTitle', 'bigwinAmount'] };
const baseOf = (name: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect id="dim" x="0" y="0" width="100" height="100" fill="#000000" data-stretch="xy"/>
  <g id="content" transform="translate(50,50)" data-anchor="0.5 0.5">${TEXTS[name].map((id) => `<text id="${id}" x="0" y="0">x</text>`).join('')}</g>
</svg>`;

describe('slot popups', () => {
  it('state → popup: big win over the free-spin phases; none otherwise', () => {
    const s = initialSlotState();
    expect(slotPopupOf(s)).toBe(null);
    expect(slotPopupOf({ ...s, phase: 'fsIntro' })).toBe('fsIntro');
    expect(slotPopupOf({ ...s, phase: 'fsOutro' })).toBe('fsOutro');
    expect(slotPopupOf({ ...s, phase: 'fsOutro', bigWinTier: 'big' })).toBe('bigwin');
  });

  it.each(SLOT_POPUP_NAMES)('%s: heir mounts on a base with #dim/#content against its contract', (name) => {
    const state = initialSlotState({ fsTotal: 10, fsWin: 3, bigWinTier: 'epic', bigWin: 7 });
    const scene = mount({ base: baseOf(name), ...SLOT_POPUPS[name], backend: backend(), registry: new Registry(), context: { state, skip: () => {} } });
    for (const id of ['dim', 'content', ...TEXTS[name]]) expect(scene.byId.has(id)).toBe(true);
  });

  it('a base without #dim fails its contract', () => {
    const base = baseOf('bigwin').replace(/<rect id="dim"[^>]*\/>/, '');
    expect(() => mount({ base, ...SLOT_POPUPS.bigwin, backend: backend(), registry: new Registry(), context: { state: initialSlotState(), skip: () => {} } })).toThrow(/dim/);
  });

  it('bindSlotPopups opens the wanted declared popup, closes the previous one, ignores undeclared', () => {
    const loop = new GameLoop();
    const state = initialSlotState();
    const log: string[] = [];
    const game = {
      state,
      loop,
      popups: { names: () => ['fsIntro', 'bigwin', 'pause'] },
      popup: (n: string) => void log.push(`open ${n}`),
      close: async (n: string) => void log.push(`close ${n}`),
    };
    const stop = bindSlotPopups(game as never);
    loop.step(1 / 60);
    state.phase = 'fsIntro';
    loop.step(1 / 60);
    state.bigWinTier = 'big';
    loop.step(1 / 60);
    state.bigWinTier = '';
    state.phase = 'fsOutro'; // not declared → nothing open
    loop.step(1 / 60);
    stop();
    state.phase = 'fsIntro';
    loop.step(1 / 60);
    expect(log).toEqual(['open fsIntro', 'close fsIntro', 'open bigwin', 'close bigwin']);
  });
});
