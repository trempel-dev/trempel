// 2.3.1: md clip files bound to scenes by name (`anim/<scene>.md`, `<scene>.anim.md`); the rest
// shared by the folder's scenes, as before — the viewer, the editor page and the editor core.

import { describe, expect, it } from 'vitest';
import { clipFileName, clipFileScene, isSharedClipFile, sceneClipFiles, sharedClipHint } from '../src/anim/clip-files';
import { compileSceneClips } from '../view/clips';
import { clipFiles } from '../view/discover';
import { openDocument } from '../editor/index';
import { parse } from '../src/core';
import { codesOf } from './helpers/codes';

const FILES = [
  'popup-victory.svg',
  'popup-victory.tml.svg',
  'world.svg',
  'world.anim.md',
  'anim/popup-victory.md',
  'anim/world-complete.md', // no scene world-complete: shared
  'anim/common.md',
  'menu.svg',
  'menu.anim.md',
  'popups/win.svg',
  'popups/anim/win.md',
  'popups/anim/sparkle.md',
  'popups/lose.svg',
  'popups/lose.anim.md',
  'art/bg.png',
  'notes.md',
];

describe('clip files bound to scenes (2.3.1)', () => {
  it('the file name gives the scene name and folder', () => {
    expect(clipFileName('anim/win.md')).toEqual({ folder: '', name: 'win' });
    expect(clipFileName('popups/anim/win.md')).toEqual({ folder: 'popups/', name: 'win' });
    expect(clipFileName('popups/win.anim.md')).toEqual({ folder: 'popups/', name: 'win' });
    expect(clipFileName('popups\\anim\\win.md')).toEqual({ folder: 'popups/', name: 'win' });
    expect(clipFileName('notes.md')).toBeNull();
    expect(clipFileName('anim/x.json')).toBeNull();
    expect(clipFileScene('anim/world-complete.md', ['world', 'popup-victory'])).toBeNull();
    expect(clipFileScene('popups/lose.anim.md', ['popups/lose'])).toBe('popups/lose');
  });

  it('a scene gets its own files and the shared ones, never another scene\'s', () => {
    expect(clipFiles(FILES, 'popup-victory').sort()).toEqual(['anim/common.md', 'anim/popup-victory.md', 'anim/world-complete.md']);
    expect(clipFiles(FILES, 'world').sort()).toEqual(['anim/common.md', 'anim/world-complete.md', 'world.anim.md']);
    expect(clipFiles(FILES, 'menu').sort()).toEqual(['anim/common.md', 'anim/world-complete.md', 'menu.anim.md']);
    expect(clipFiles(FILES, 'popups/win').sort()).toEqual(['popups/anim/sparkle.md', 'popups/anim/win.md']);
    expect(clipFiles(FILES, 'popups/lose').sort()).toEqual(['popups/anim/sparkle.md', 'popups/lose.anim.md']);
  });

  it('no file named after a scene: every file is shared, as before 2.3.1', () => {
    const files = ['a.svg', 'b.svg', 'anim/intro.md', 'anim/outro.md', 'fx.anim.md'];
    expect(clipFiles(files, 'a')).toEqual(['anim/intro.md', 'anim/outro.md', 'fx.anim.md']);
    expect(clipFiles(files, 'b')).toEqual(['anim/intro.md', 'anim/outro.md', 'fx.anim.md']);
    expect(sceneClipFiles(files, 'a', [])).toEqual(clipFiles(files, 'a'));
  });

  it('a scene that is only a heir (extends another scene) binds its files too', () => {
    const files = ['base.svg', 'skin.tml.svg', 'anim/skin.md', 'anim/base.md'];
    expect(clipFiles(files, 'skin')).toEqual(['anim/skin.md']);
    expect(clipFiles(files, 'base')).toEqual(['anim/base.md']);
  });

  it('the error panel: a target error of a shared file says how to bind it; a bound file\'s does not', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="panel" width="10" height="10"/></svg>';
    const md = (target: string): string => `# $clip pop\n\n## $track ${target}\n| t | alpha |\n|---|---|\n| 0 | 0 |\n| 1 | 1 |\n`;
    const r = compileSceneClips({ 'anim/world-complete.md': md('map'), 'anim/popup-victory.md': md('ghost') }, parse(SVG), 'popup-victory');
    expect(codesOf(r.errors)).toEqual(['E_ANIM_TARGET', 'E_ANIM_TARGET']);
    expect(r.errors[0]).toMatch(/^E_ANIM_TARGET: anim\/world-complete\.md: .*shared clip file.*anim\/<scene>\.md or <scene>\.anim\.md/);
    expect(r.errors[1]).not.toMatch(/shared clip file/);
    // without a scene id — as before
    expect(compileSceneClips({ 'anim/world-complete.md': md('map') }, parse(SVG)).errors[0]).not.toMatch(/shared/);
    expect(isSharedClipFile('anim/world-complete.md', 'popup-victory')).toBe(true);
    expect(isSharedClipFile('popup-victory.anim.md', 'popup-victory')).toBe(false);
    expect(sharedClipHint('anim/x.md', 'a', 'E_ANIM_PARSE: x')).toBe('E_ANIM_PARSE: x');
  });

  it('the editor core: the same hint in the document\'s errors (path = the scene\'s base or heir)', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="panel" width="10" height="10"/></svg>';
    const md = '# $clip pop\n\n## $track map\n| t | alpha |\n|---|---|\n| 0 | 0 |\n| 1 | 1 |\n';
    const doc = openDocument(SVG, { path: 'popups/popup-victory.svg', clips: { 'popups/anim/world-complete.md': md, 'popups/popup-victory.anim.md': md } });
    const errs = doc.errors.filter((e) => e.startsWith('E_ANIM_TARGET'));
    expect(errs).toHaveLength(2);
    expect(errs.find((e) => e.includes('world-complete'))).toMatch(/shared clip file/);
    expect(errs.find((e) => e.includes('popup-victory.anim.md'))).not.toMatch(/shared clip file/);
  });
});
