// The thirty-line example of the root README is real: its base and heir compose without a
// problem, and mounted over the mock backend the click handler and the binding work as written.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkScene, mount, reactive } from '../src/core';
import { createMockBackend, isMockNode } from './helpers/mockBackend';

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const block = (name: string): string => {
  const m = new RegExp('```xml\\n(<!-- ' + name.replace('.', '\\.') + '[^\\n]*-->\\n[\\s\\S]*?)```').exec(README);
  if (!m) throw new Error(`README: no block ${name}`);
  return m[1];
};

describe('README — thirty lines', () => {
  it('hello.svg + hello.tml.svg: no problems; the label follows the clicks', () => {
    const base = block('hello.svg');
    const heir = block('hello.tml.svg');
    expect(checkScene({ base, heir, path: 'hello.svg' }).errors).toEqual([]);
    const backend = createMockBackend();
    const state = reactive({ clicks: 0 });
    const scene = mount({ base, heir, path: 'hello.svg', backend, context: { state, play: () => state.clicks++ } });
    const label = isMockNode(scene.byId.get('label')!);
    expect(label.props.text).toBe('Play');
    isMockNode(scene.byId.get('button')!).clicks.forEach((click) => {
      click();
      click();
    });
    expect(state.clicks).toBe(2);
    expect(label.props.text).toBe('Clicks: 2');
  });
});
