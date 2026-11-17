// compat.ts — the previous names of the format (`gml:` + its xmlns, `X.gml.svg`, `gameml.view.ts`,
// `.gml/`) still work for one release, each with a deprecation warning once.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, parse, parseHeir, sceneStem, isHeirFile } from '../src/core';
import { onDeprecated, readHeir, readHeirAsync, heirSuffix, VIEW_MODULES, PROJECT_DIRS, legacyName, upgradeDocument } from '../src/compat';
import { discoverScenes } from '../view/discover';
import { createMockBackend, isMockNode } from './helpers/mockBackend';
import { reactive } from '../src/reactive';
import { codesOf } from './helpers/codes';

let warned: string[] = [];
beforeEach(() => {
  warned = [];
  onDeprecated((m) => warned.push(m));
});

const BASE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text id="t"/></svg>`;
const OLD_HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:gml="http://gameml.dev/ns" gml:extends="scene.svg">
  <gml:ref id="t" gml:bind="state.n"/>
  <g gml:insert="after t"><rect id="r" width="1" height="1" gml:visible = "state.n > 1"/></g>
</svg>`;

describe('compat — previous names, one release', () => {
  it('an heir with gml: and the old xmlns mounts as tml:, warning once', () => {
    const state = reactive({ n: 2 });
    const scene = mount({ base: BASE, heir: OLD_HEIR, backend: createMockBackend(), context: { state } });
    expect(isMockNode(scene.byId.get('t')!).props.text).toBe(2);
    expect(isMockNode(scene.byId.get('r')!).props.visible).toBe(true);
    parseHeir(OLD_HEIR);
    expect(codesOf(warned)).toEqual(['W_COMPAT_GML']);
    expect(warned[0]).toMatch(/gml:.*tml:/);
    expect(warned[0]).toMatch(/migrate-tml\.mjs/);
  });

  it('the rewrite touches only the prefix and the namespace; current documents pass untouched', () => {
    const up = upgradeDocument(OLD_HEIR);
    expect(up).toContain('xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg"');
    expect(up).toContain('<tml:ref id="t" tml:bind="state.n"/>');
    expect(up).toContain('tml:visible = "state.n > 1"');
    expect(up).not.toMatch(/gml/);
    const tmlOldNs = '<svg xmlns:tml="http://gameml.dev/ns"><tml:ref id="a"/></svg>';
    expect(upgradeDocument(tmlOldNs)).toBe('<svg xmlns:tml="https://trempel.dev/ns/scene"><tml:ref id="a"/></svg>');
    const now = up;
    expect(upgradeDocument(now)).toBe(now);
    expect(parse(BASE).tml).toEqual({});
    expect(warned.length).toBe(1);
  });

  it('X.gml.svg is read when there is no X.tml.svg (warns); X.tml.svg wins', async () => {
    const files: Record<string, string> = { 'a.gml.svg': 'old', 'b.tml.svg': 'new', 'b.gml.svg': 'stale' };
    const get = (f: string): string | undefined => files[f];
    expect(readHeir(get, 'a')).toBe('old');
    expect(readHeir(get, 'b')).toBe('new');
    expect(readHeir(get, 'c')).toBeUndefined();
    expect(await readHeirAsync(async (f) => files[f], 'a')).toBe('old');
    expect(codesOf(warned)).toEqual(['W_COMPAT_HEIR']);
    expect(warned[0]).toMatch(/a\.gml\.svg.*a\.tml\.svg/);
    expect(sceneStem('ui/x.gml.svg')).toBe('ui/x');
    expect(sceneStem('ui/x.tml.svg')).toBe('ui/x');
    expect(isHeirFile('x.gml.svg') && isHeirFile('x.tml.svg') && !isHeirFile('x.svg')).toBe(true);
    expect(heirSuffix('x.gml.svg')).toBe('.gml.svg');
  });

  it('listings see old heirs; the module and the editor folder: new name first, the old one warns', () => {
    expect(discoverScenes(['game.svg', 'game.gml.svg', 'menu.tml.svg'])).toEqual([
      { id: 'game', base: 'game.svg', heir: 'game.gml.svg' },
      { id: 'menu', heir: 'menu.tml.svg' },
    ]);
    expect(VIEW_MODULES).toEqual(['trempel.view.ts', 'gameml.view.ts']);
    expect(PROJECT_DIRS).toEqual(['.trempel', '.gml']);
    legacyName('/w/trempel.view.ts');
    legacyName('.trempel/macros');
    expect(warned).toEqual([]);
    legacyName('/w/gameml.view.ts');
    legacyName('.gml/macros');
    expect(codesOf(warned)).toEqual(['W_COMPAT_VIEW_MODULE', 'W_COMPAT_PROJECT_DIR']);
    expect(warned[0]).toMatch(/gameml\.view\.ts.*trempel\.view\.ts/);
    expect(warned[1]).toMatch(/\.gml\/.*\.trempel\//);
  });
});

describe('scripts/migrate-tml.mjs — a consumer folder to the new names', () => {
  it('renames heirs, the module, the editor folder; rewrites the namespace, imports, macros; idempotent; --dry-run writes nothing', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const script = new URL('../scripts/migrate-tml.mjs', import.meta.url).pathname;
    const dir = mkdtempSync(join(tmpdir(), 'tml-migrate-'));
    try {
      mkdirSync(join(dir, 'ui'), { recursive: true });
      mkdirSync(join(dir, '.gml/macros'), { recursive: true });
      mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
      writeFileSync(join(dir, 'game.svg'), BASE);
      writeFileSync(join(dir, 'game.gml.svg'), OLD_HEIR);
      writeFileSync(join(dir, 'ui/button.gml.svg'), '<svg xmlns:gml="http://gameml.dev/ns"><gml:ref id="a" gml:on-click="go()"/></svg>');
      writeFileSync(join(dir, 'gameml.view.ts'), "import { defineView } from 'gameml/view';\nimport type { SceneNode } from \"gameml/core\";\nimport { PixiBackend } from 'gameml';\n");
      writeFileSync(join(dir, '.gml/macros/a.js'), "// name: a\nconst s = gml.selection;\nwindow.gml.moveBy(s[0], 1, 0);\nconst ngml = 1;\n");
      writeFileSync(join(dir, 'node_modules/x/y.gml.svg'), 'gml:');
      const run = (...a: string[]): string => execFileSync('node', [script, dir, ...a], { encoding: 'utf8' });

      const dry = run('--dry-run');
      expect(dry).toMatch(/would move {2}game\.gml\.svg → game\.tml\.svg/);
      expect(existsSync(join(dir, 'game.gml.svg'))).toBe(true);

      run();
      expect(readdirSync(dir).sort()).toEqual(['.trempel', 'game.svg', 'game.tml.svg', 'node_modules', 'trempel.view.ts', 'ui']);
      expect(readFileSync(join(dir, 'game.tml.svg'), 'utf8')).toBe(upgradeDocument(OLD_HEIR));
      expect(readFileSync(join(dir, 'ui/button.tml.svg'), 'utf8')).toBe('<svg xmlns:tml="https://trempel.dev/ns/scene"><tml:ref id="a" tml:on-click="go()"/></svg>');
      expect(readFileSync(join(dir, 'trempel.view.ts'), 'utf8')).toBe("import { defineView } from '@trempel/scene/view';\nimport type { SceneNode } from \"@trempel/scene/core\";\nimport { PixiBackend } from '@trempel/scene';\n");
      expect(readFileSync(join(dir, '.trempel/macros/a.js'), 'utf8')).toBe('// name: a\nconst s = tml.selection;\nwindow.tml.moveBy(s[0], 1, 0);\nconst ngml = 1;\n');
      expect(readFileSync(join(dir, 'node_modules/x/y.gml.svg'), 'utf8')).toBe('gml:');

      expect(run()).toMatch(/^0 change\(s\)\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
