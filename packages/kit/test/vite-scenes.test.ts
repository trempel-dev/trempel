// The kit's Vite plugin, 2.0 (TRM-8b §1.1, §1.7): the scene table of a game (its scenes, a UI kit as
// a collection next to it, project heirs) injected before the game's code; md clips compiled and
// checked against their scene at build time — a bad clip fails the build with its code.
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'vite';
import { collectScenes, tableModule, trempelKit } from '../src/vite/index.js';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';

function project(files: Record<string, string>): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'kit-scenes-')));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, rel)), { recursive: true });
    writeFileSync(join(top, rel), text);
  }
  return top;
}

const FILES = {
  // The UI kit — a repository of its own next to the game.
  'ui-kit/level.svg': `<svg ${NS} viewBox="0 0 720 1280"><use id="ok" href="ui/button.svg" data-action="go"/><rect id="card" width="10" height="10"/></svg>`,
  'ui-kit/ui/button.svg': `<svg ${NS} viewBox="0 0 100 40" data-action=""><rect id="hit" width="100" height="40"/></svg>`,
  'ui-kit/ui/button.tml.svg': `<svg ${NS} tml:extends="button.svg"/>`,
  'ui-kit/mockups/unused.svg': `<svg ${NS} viewBox="0 0 1 1"><use id="x" href="../ui/button.svg"/></svg>`,
  // The game.
  'game/.trempel/project.mdz': '## collections\n$ui: ../ui-kit\n',
  'game/index.html': '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>',
  'game/scenes/level.tml.svg': `<svg ${NS} tml:extends="@ui/level.svg"/>`,
  'game/scenes/ui/button.tml.svg': `<svg ${NS} tml:extends="@ui/ui/button.svg"><tml:ref id="hit" tml:on-click="tap(self.action)"/></svg>`,
  'game/scenes/anim/win.md': '# $clip fly\n$duration: 1\n## $track card\n| t | x |\n|---|---|\n| 0 | 0 |\n| 1 | $toX |\n',
  'game/art/icon.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`,
  'game/node_modules/x/y.tml.svg': `<svg ${NS} tml:extends="@ui/ui/button.svg"/>`,
  'game/main.js': "import level from './scenes/level.tml.svg?raw';\nimport clips from './scenes/anim/win.md?clips=level';\nconsole.log(level.length, clips.fly.tracks.length, globalThis.TREMPEL_SCENE_TABLE);\n",
};

describe('the kit plugin: the scene table (§1.1)', () => {
  it('collects the game\'s scenes and what they reach in the collection; project heirs; not node_modules, art or unused collection files', () => {
    const top = project(FILES);
    const s = collectScenes(join(top, 'game'));
    expect(s.errors).toEqual([]);
    expect([...s.files.keys()].sort()).toEqual(['@ui/level.svg', '@ui/ui/button.svg', '@ui/ui/button.tml.svg', 'scenes/level.tml.svg', 'scenes/ui/button.tml.svg']);
    expect(s.heirs).toEqual({ '@ui/level.svg': 'scenes/level.svg', '@ui/ui/button.svg': 'scenes/ui/button.svg' });
    expect(s.collections).toEqual(['ui']);
    const mod = tableModule(s);
    expect(mod).toContain('?raw');
    expect(mod).toContain('globalThis["TREMPEL_SCENE_TABLE"]');
  });

  it('a real build: the table runs before the game; a scene the game imports too is in the bundle once; the clip compiled', async () => {
    const top = project(FILES);
    const root = join(top, 'game');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({ root, mode: 'web', logLevel: 'silent', configFile: false, plugins: [trempelKit()] });
    log.mockRestore();
    const html = readFileSync(join(root, 'dist-web', 'index.html'), 'utf8');
    const js = readdirSync(join(root, 'dist-web', 'assets')).filter((f) => f.endsWith('.js'));
    const code = js.map((f) => readFileSync(join(root, 'dist-web', 'assets', f), 'utf8')).join('\n');
    expect(html).toContain('<script type="module"');
    expect(code).toContain('TREMPEL_SCENE_TABLE');
    expect(code).toContain('tap(self.action)');
    // The game's own import of the level heir and the table's are one module.
    expect(code.match(/tml:extends=\\?"@ui\/level\.svg/g)).toHaveLength(1);
    // The table is set before the game reads it: its assignment comes first in the entry.
    expect(code.indexOf('TREMPEL_SCENE_TABLE')).toBeLessThan(code.indexOf('console.log'));
    // The clip: compiled, the parameter key kept.
    expect(code).toMatch(/"?param"?:"toX"/);
  }, 60_000);

  it('a bad clip fails the build with its code (a target the scene does not have)', async () => {
    const top = project({ ...FILES, 'game/scenes/anim/win.md': '# $clip fly\n## $track nope\n| t | x |\n|---|---|\n| 0 | 0 |\n| 1 | 5 |\n' });
    await expect(build({ root: join(top, 'game'), mode: 'web', logLevel: 'silent', configFile: false, plugins: [trempelKit()] })).rejects.toThrow(/E_ANIM_TARGET/);
  }, 60_000);
});
