// v1.1 collections: `@name/…` hrefs — resolveHref (a root of its own), expandCollection, the project
// file (.trempel/project.mdz, npm:), mount with `collections` (scene images, a prefab inside a
// collection, a collection → another collection, an unknown name), the contract's sameHref, the
// checker's collection errors, the dev server's files (a collection file served, a foreign path 403).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeScene, expandCollection, mount, parseProject, TrempelError, type SceneSource } from '../src/core';
import { collectionErrors, usedCollections } from '../src/project';
import { resolveHref } from '../src/href';
import { collectionPath, findProjectRoot, loadProject } from '../src/node/project';
import { projectInfo, servedFile, serverProject } from '../view/plugin';
import { createMockBackend, isMockNode, type MockNode } from './helpers/mockBackend';
import { codesOf, thrown, withCode } from './helpers/codes';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
const svg = (body: string, root = ''): string => `<svg ${NS} viewBox="0 0 400 300"${root}>${body}</svg>`;

/** Every built node with an href, depth-first. */
function hrefs(n: MockNode, out: string[] = []): string[] {
  const h = (n.props.href as string | undefined) ?? n.attrs.href;
  if (h != null) out.push(h);
  n.children.forEach((c) => hrefs(c, out));
  return out;
}

describe('resolveHref / expandCollection', () => {
  it('a collection href is a root of its own: normalized, never resolved against the base', () => {
    expect(resolveHref('@skin/panel.svg', 'game/scene.svg')).toBe('@skin/panel.svg');
    expect(resolveHref('@skin/./art/../panel.svg', 'x/y.svg')).toBe('@skin/panel.svg');
    expect(resolveHref('@skin/../../x.png', undefined)).toBe('@skin/x.png');
  });

  it('relative hrefs written in a collection document stay inside it', () => {
    expect(resolveHref('art/btn.png', '@skin/button.svg')).toBe('@skin/art/btn.png');
    expect(resolveHref('../art/btn.png', '@skin/ui/button.svg')).toBe('@skin/art/btn.png');
    expect(resolveHref('../../../x.png', '@skin/ui/button.svg')).toBe('@skin/x.png');
    expect(resolveHref('@icons/play.png', '@skin/button.svg')).toBe('@icons/play.png');
  });

  it('not a collection: `@` that is not `@name/` stays a relative path; plain paths as before', () => {
    expect(resolveHref('@2x/a.png', 'ui/s.svg')).toBe('ui/@2x/a.png');
    expect(resolveHref('art/a.png', 'ui/s.svg')).toBe('ui/art/a.png');
    expect(resolveHref('../a.png', '/root/s.svg')).toBe('/a.png');
  });

  it('expandCollection: the folder URL + path; unknown name — a clear error with the known ones', () => {
    const c = { skin: '/proj/skins/ui', kit: 'https://cdn.example/kit/' };
    expect(expandCollection('@skin/art/a.png', c)).toBe('/proj/skins/ui/art/a.png');
    expect(expandCollection('@kit/b.svg', c)).toBe('https://cdn.example/kit/b.svg');
    expect(expandCollection('art/a.png', c)).toBe('art/a.png');
    const unknown = thrown(() => expandCollection('@ui/a.png', c));
    expect(unknown).toMatchObject({ code: 'E_COLLECTION_UNKNOWN' });
    expect(unknown.message).toContain('@ui');
    expect(unknown.message).toContain('@kit, @skin');
    const none = thrown(() => expandCollection('@ui/a.png', undefined));
    expect(none).toMatchObject({ code: 'E_COLLECTION_UNKNOWN' });
    expect(none.message).toContain('—');
  });
});

describe('.trempel/project.mdz', () => {
  it('parses the collections section (md attributes), other sections are notes', () => {
    const p = parseProject('# Trempel project\n\nNotes.\n\n## collections\n$skin: skins/default/ui\n$kit: npm:@trempel/kit/ui\n\n## notes\n$ignored: x\n');
    expect(p.errors).toEqual([]);
    expect(p.collections).toEqual([
      { name: 'skin', value: 'skins/default/ui' },
      { name: 'kit', value: 'npm:@trempel/kit/ui', npm: { pkg: '@trempel/kit', sub: 'ui' } },
    ]);
  });

  it('bad names, empty values, absolute paths, repeats — errors', () => {
    const p = parseProject('## collections\n$Skin: a\n$ok:\n$abs: /x\n$a: one\n$a: two\n');
    expect(p.collections.map((c) => c.name)).toEqual(['a']);
    expect(codesOf(p.errors)).toEqual(['E_PROJECT', 'E_PROJECT', 'E_PROJECT', 'E_PROJECT']);
    for (const named of ['$Skin', '$ok', '$abs: "/x"', '$a']) expect(p.errors.some((e) => e.includes(named))).toBe(true);
  });
});

describe('project on disk (node/project.ts)', () => {
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tml-proj-'));
    mkdirSync(join(root, '.trempel'));
    mkdirSync(join(root, 'skins/default/ui/art'), { recursive: true });
    mkdirSync(join(root, 'games/one'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@acme/kit/ui'), { recursive: true });
    writeFileSync(join(root, '.trempel/project.mdz'), '# p\n\n## collections\n$skin: skins/default/ui\n$kit: npm:@acme/kit/ui\n$gone: nope\n$nopkg: npm:missing-pkg/x\n');
  });
  afterAll(() => root && rmSync(root, { recursive: true, force: true }));

  it('the nearest ancestor with .trempel/project.mdz; folders resolved; npm: — node_modules up the tree', () => {
    expect(findProjectRoot(join(root, 'games/one'))).toBe(root);
    const p = loadProject(join(root, 'games/one'));
    expect(p.root).toBe(root);
    expect(p.collections).toEqual({ skin: join(root, 'skins/default/ui'), kit: join(root, 'node_modules/@acme/kit/ui') });
    const errs = withCode(p.errors, 'E_PROJECT');
    expect(errs).toHaveLength(2);
    expect(errs.some((e) => e.includes('$gone') && e.includes('nope'))).toBe(true);
    expect(errs.some((e) => e.includes('$nopkg') && e.includes('missing-pkg'))).toBe(true);
  });

  it('collectionPath: a file inside a collection → @name/…', () => {
    const { collections } = loadProject(root);
    expect(collectionPath(join(root, 'skins/default/ui/art/a.png'), collections)).toBe('@skin/art/a.png');
    expect(collectionPath(join(root, 'games/one/a.png'), collections)).toBeNull();
  });

  it('dev server: collection and project-root files are served, anything else is 403', () => {
    const dir = join(root, 'games/one');
    const { root: served, dirRel, project } = serverProject(dir);
    expect(served).toBe(root);
    expect(dirRel).toBe('games/one/');
    expect(projectInfo(dir).collections).toEqual({ skin: '/__tml/c/skin/', kit: '/__tml/c/kit/' });
    expect(projectInfo(dir).folderUrl).toBe('/__tml/root/games/one/');
    expect(servedFile('/__tml/c/skin/art/a.png', served, project.collections)).toEqual({ file: join(root, 'skins/default/ui/art/a.png') });
    expect(servedFile('/__tml/root/skins/default/ui/art/a.png', served, project.collections)).toEqual({ file: join(root, 'skins/default/ui/art/a.png') });
    expect(servedFile('/__tml/c/skin/%2E%2E/%2E%2E/secret.txt', served, project.collections)).toMatchObject({ status: 403 });
    expect(servedFile('/__tml/root/%2E%2E/etc/passwd', served, project.collections)).toMatchObject({ status: 403 });
    expect(servedFile('/__tml/c/nope/a.png', served, project.collections)).toMatchObject({ status: 404 });
    expect(servedFile('/__tml/root/.git/config', served, project.collections)).toMatchObject({ status: 403 });
    expect(servedFile('/__tml/root/node_modules/@acme/kit/ui/x.svg', served, project.collections)).toMatchObject({ status: 403 });
    expect(servedFile('/__tml/c/kit/x.svg', served, project.collections)).toEqual({ file: join(root, 'node_modules/@acme/kit/ui/x.svg') });
    expect(servedFile('/other', served, project.collections)).toBeNull();
  });
});

describe('mount with collections', () => {
  const SKIN = '/proj/skins/ui';
  const docs: Record<string, SceneSource> = {
    [`${SKIN}/panel.svg`]: { base: svg(`<image id="bg" href="art/panel.png" width="400" height="300"/><use id="icon" href="@icons/star.svg"/>`) },
    '/proj/icons/star.svg': { base: svg(`<image id="i" href="star.png" width="10" height="10"/>`) },
    '/proj/game/ui/local.svg': { base: svg(`<image id="l" href="../art/l.png" width="10" height="10"/>`) },
  };
  const loadScene = (url: string): SceneSource | null => docs[url] ?? null;
  const collections = { skin: SKIN, icons: '/proj/icons' };

  it('scene images, a prefab inside a collection (its relative art), a collection → another collection', () => {
    const scene = mount({
      base: svg(`<image id="a" href="@skin/art/a.png" width="1" height="1"/><use id="p" href="@skin/panel.svg"/><use id="q" href="ui/local.svg"/>`),
      backend: createMockBackend(),
      context: {},
      baseUrl: '/proj/game/scene.svg',
      collections,
      loadScene,
    });
    expect(hrefs(isMockNode(scene.root))).toEqual(['/proj/skins/ui/art/a.png', '/proj/skins/ui/art/panel.png', '/proj/icons/star.png', '/proj/game/art/l.png']);
  });

  it('the host resolveHref gets the expanded path (bundler tables keep working)', () => {
    const seen: string[] = [];
    mount({
      base: svg(`<image id="a" href="@skin/art/a.png" width="1" height="1"/>`),
      backend: createMockBackend(),
      context: {},
      collections: { skin: 'skin' },
      resolveHref: (h) => (seen.push(h), `hashed:${h}`),
    });
    expect(seen).toEqual(['skin/art/a.png']);
  });

  it('a bound href into a collection resolves like an attribute', () => {
    const scene = mount({
      base: svg(`<image id="a" href="@skin/art/a.png" width="1" height="1"/>`),
      heir: `<svg ${NS}><tml:ref id="a" tml:bind="state.pic"/></svg>`,
      backend: createMockBackend(),
      context: { state: { pic: '@skin/art/b.png' } },
      collections,
    });
    expect(isMockNode(scene.byId.get('a')!).props.href).toBe('/proj/skins/ui/art/b.png');
  });

  it('an unknown collection is a mount error naming the known ones (not a silent 404)', () => {
    let err: unknown;
    try {
      mount({ base: svg(`<image id="a" href="@ui/a.png" width="1" height="1"/>`), backend: createMockBackend(), context: {}, collections });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TrempelError);
    const [m] = withCode((err as TrempelError).errors, 'E_COLLECTION_UNKNOWN');
    expect(m).toContain('#a: @ui/a.png');
    expect(m).toContain('@icons, @skin');
  });

  it('an unknown collection on a prefab: the instance reports it', () => {
    const e = thrown(() =>
      mount({ base: svg(`<use id="p" href="@nope/panel.svg"/>`), backend: createMockBackend(), context: {}, collections, loadScene, baseUrl: '/proj/game/scene.svg' }),
    );
    const [m] = withCode(e.errors!, 'E_PREFAB_MISSING');
    expect(m).toContain('#p');
    expect(m).toContain('@nope/panel.svg');
    expect(m).toContain('E_COLLECTION_UNKNOWN');
  });

  it('collectionErrors / usedCollections over a composed tree', () => {
    const c = composeScene({ base: svg(`<image id="a" href="@skin/a.png"/><image id="b" href="@x/b.png" data-views="on:@y/c.png"/>`) });
    expect(usedCollections(c.tree!)).toEqual(['skin', 'x', 'y']);
    expect(collectionErrors(c.tree!, { skin: '/s' })).toHaveLength(2);
  });
});

describe('contract sameHref (v1.1): resolved paths', () => {
  it('@skin/panel.svg and the same file by its relative path are one prefab', () => {
    const contract = `<contract><use id="p" href="../skins/ui/panel.svg"/></contract>`;
    const loadScene = (url: string): SceneSource | null => (url.endsWith('skins/ui/panel.svg') ? { base: svg('<rect id="r" width="1" height="1"/>') } : null);
    const url = (rel: string): string => resolveHref(expandCollection(rel, { skin: '/proj/skins/ui' }), '/proj/game/scene.svg');
    const ok = composeScene({ base: svg(`<use id="p" href="@skin/panel.svg"/>`), contract, loadScene, url });
    expect(ok.errors.contract).toEqual([]);
    const other = composeScene({ base: svg(`<use id="p" href="@skin/other.svg"/>`), contract, loadScene: () => ({ base: svg('') }), url });
    const [m] = withCode(other.errors.contract, 'E_CONTRACT_TAG');
    expect(m).toContain('#p');
    expect(m).toContain('../skins/ui/panel.svg');
    expect(m).toContain('@skin/other.svg');
  });
});
