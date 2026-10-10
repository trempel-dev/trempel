// Every skin's base passes the slot contract and the standard heir mounts on it (headless, no Pixi),
// prefabs and the `@skin` collection included; the same for the three popups. Run after every reskin.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Registry, mount, type RendererBackend } from '@trempel/scene/core';
import { loadProject } from '@trempel/scene/node';
import { SLOT_CONTRACT, SLOT_HEIR, SLOT_POPUPS, initialSlotState } from '@trempel/slot';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = loadProject(root);
const skins = readdirSync(join(root, 'skins'));
const read = (f: string) => readFileSync(f, 'utf8');
const sibling = (f: string, ext: string) => {
  const p = f.replace(/\.svg$/, ext);
  return existsSync(p) ? read(p) : undefined;
};

function backend(): RendererBackend {
  return {
    createNode: (tag, attrs) => ({ tag, attrs, props: {} as Record<string, unknown> }),
    setProp: (n, k, v) => void ((n as { props: Record<string, unknown> }).props[k] = v),
    onClick: () => {},
    addChild: () => {},
    mount: () => {},
    getBounds: () => ({ x: 0, y: 0, w: 0, h: 0 }),
  };
}

/** Mount a scene file of a skin with its prefabs and the project's collections. */
function mountFile(file: string, src: { heir: string; contract: string }, context: Record<string, unknown>, registry = new Registry()) {
  return mount({
    base: read(file),
    ...src,
    backend: backend(),
    registry,
    context,
    sceneUrl: file,
    collections: project.collections,
    loadScene: (url: string) => ({ base: read(url), heir: sibling(url, '.tml.svg'), contract: sibling(url, '.contract.xml') }),
  });
}

const noop = () => {};
const actions = { spinOrStop: noop, betUp: noop, betDown: noop, toggleTurbo: noop, toggleAuto: noop, skip: noop };

describe.each(skins)('skin %s', (skin) => {
  const dir = join(root, 'skins', skin);

  it('slot.svg + SLOT_HEIR + SLOT_CONTRACT mount; the reels are a 3×3 component; bindings evaluate', () => {
    const state = initialSlotState({ balance: 12.5, win: 3 });
    const registry = new Registry().register('reel-grid', (ctx) => {
      expect([ctx.attrs['data-cols'], ctx.attrs['data-rows']]).toEqual(['3', '3']);
      return { root: {} };
    });
    const scene = mountFile(join(dir, 'slot.svg'), { heir: SLOT_HEIR, contract: SLOT_CONTRACT }, { state, ...actions }, registry);
    const props = (id: string) => (scene.byId.get(id) as { props: Record<string, unknown> }).props;
    expect(props('win')).toMatchObject({ visible: true });
    expect(props('spinLabel').text).toBe('SPIN');
    expect(scene.byId.has('winFx')).toBe(true);
  });

  it.each([
    ['fsIntro', 'fs-intro.svg', 'fsIntroText', '8 FREE SPINS'],
    ['fsOutro', 'fs-outro.svg', 'fsOutroText', 'TOTAL 12.50'],
    ['bigwin', 'bigwin.svg', 'bigwinTitle', 'MEGA WIN'],
  ] as const)('popup %s mounts with SLOT_POPUPS; bindings', (name, file, id, text) => {
    const state = initialSlotState({ fsTotal: 8, fsWin: 12.5, bigWinTier: 'mega', bigWin: 40 });
    const scene = mountFile(join(dir, 'popups', file), SLOT_POPUPS[name], { state, skip: noop });
    expect(scene.byId.has('dim') && scene.byId.has('content')).toBe(true);
    expect((scene.byId.get(id) as { props: Record<string, unknown> }).props.text).toBe(text);
  });
});
