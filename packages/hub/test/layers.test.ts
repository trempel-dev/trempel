// layers.test.ts — the four layers, override by id, the legacy stand-in for an old kit, two
// projects on two kit versions each getting the `editor` of its own kit.

import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectActions } from '../src/engine.js';
import { resolveActions } from '../src/layers.js';
import { describeProject, isProject, scanProjects } from '../src/project.js';
import { REPO, fakeKit, freshHome, linkRealKit, makeProject, tmp, write } from './helpers.js';

const KIT_A = `## actions

### dev
$title: Dev (kit A)
$kind: service
$shell: node server.js

### test
$title: Tests (kit A)
$group: gates
$shell: echo kit-a-tests

### editor
$title: Editor of kit 2.2
$kind: service
$shell: echo editor 2.2
`;

let home: string;
beforeEach(() => {
  home = freshHome();
});

describe('layers', () => {
  it('hub < user < kit < project, by id; every declaration stays listed', async () => {
    write(join(home, 'actions.mdz'), '## actions\n\n### open:ide\n$title: Open in my IDE\n$shell: myide .\n\n### claude\n$title: Claude Code here\n$group: agents\n$shell: claude\n');
    const root = makeProject(tmp(), { name: 'four', dependencies: { '@trempel/kit': '^2.2.0' } }, {
      '.trempel/project.mdz': '# four\n\n## collections\n$skin: skins\n\n## actions\n\n### test\n$title: Tests (project)\n$group: gates\n$shell: echo project-tests\n\n### git:status\n$title: Status, short\n$shell: git status -s\n\n### levels\n$title: Levels\n$group: content\n$shell: echo levels\n',
    });
    fakeKit(root, '2.2.0', KIT_A);
    const r = resolveActions(describeProject(root));
    expect(r.errors).toEqual([]);
    expect(r.sources.map((s) => s.layer)).toEqual(['hub', 'user', 'kit', 'project']);
    const win = (id: string): string => `${r.actions.get(id)?.layer}:${r.actions.get(id)?.title}`;
    expect(win('open:folder')).toBe('hub:Open folder');
    expect(win('open:ide')).toBe('user:Open in my IDE');
    expect(win('claude')).toBe('user:Claude Code here');
    expect(win('dev')).toBe('kit:Dev (kit A)');
    expect(win('test')).toBe('project:Tests (project)');
    expect(win('git:status')).toBe('project:Status, short');
    expect(win('levels')).toBe('project:Levels');
    // the overridden ones are still there for `--list`
    expect(r.all.filter((a) => a.id === 'test').map((a) => a.layer)).toEqual(['kit', 'project']);
    expect(r.all.filter((a) => a.id === 'open:ide').map((a) => a.layer)).toEqual(['hub', 'user']);
  });

  it('.trempel/actions.mdz beside project.mdz: the later file wins, with a note', () => {
    const root = makeProject(tmp(), { name: 'two-files' }, {
      '.trempel/project.mdz': '## actions\n### x\n$shell: echo one\n',
      '.trempel/actions.mdz': '## actions\n### x\n$shell: echo two\n### y\n$shell: echo y\n',
    });
    const r = resolveActions(describeProject(root));
    expect(r.actions.get('x')?.shell).toEqual(['echo two']);
    expect(r.actions.get('y')?.source).toMatch(/actions\.mdz$/);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^E_HUB_ACTION: .*declared in/);
  });

  it('a kit without hub/actions.mdz: the hub stands in with the npm scripts', async () => {
    const root = makeProject(tmp(), { name: 'old', dependencies: { '@trempel/kit': '^2.1.0' }, scripts: { dev: 'vite', test: 'vitest run' } });
    fakeKit(root, '2.1.0', null);
    const pa = await projectActions(root);
    const kit = pa.sources.find((s) => s.layer === 'kit')!;
    expect(kit.legacy).toBe(true);
    expect(pa.actions.get('dev')?.shell).toEqual(['npm run dev -- --port ${port} --strictPort']);
    expect(pa.visible.has('dev')).toBe(true);
    expect(pa.visible.has('test')).toBe(true);
    expect(pa.visible.has('build:yt')).toBe(false); // no such script
  });

  it('two projects on two kit versions: each its own editor', async () => {
    const old = makeProject(tmp(), { name: 'old-game', dependencies: { '@trempel/kit': '2.2.0' } });
    fakeKit(old, '2.2.0', KIT_A);
    const cur = makeProject(tmp(), { name: 'new-game', dependencies: { '@trempel/kit': '^2.4.0', '@trempel/scene': '^2.3.0' } }, { 'scenes/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    linkRealKit(cur);
    const a = await projectActions(old);
    const b = await projectActions(cur);
    expect(a.project.kit).toBe('2.2.0');
    expect(b.project.kit).toBe('2.4.1');
    const ea = a.actions.get('editor')!;
    const eb = b.actions.get('editor')!;
    expect(ea.title).toBe('Editor of kit 2.2');
    expect(ea.source).toBe(join(old, 'node_modules', '@trempel', 'kit', 'hub', 'actions.mdz'));
    expect(eb.source).toBe(join(cur, 'node_modules', '@trempel', 'kit', 'hub', 'actions.mdz'));
    expect(eb.shell![0]).toMatch(/^node \$\{pkg:@trempel\/scene\}\/edit\/cli\.mjs/);
    expect(b.visible.has('editor')).toBe(true); // the monorepo's scene has edit/cli.mjs
    // the bridge actions show only while the editor runs
    expect(b.visible.has('editor:eval')).toBe(false);
  });
});

describe('projects', () => {
  it('scan: kit/scene dependency or .trempel/project.mdz; depth; manual ones; no node_modules', () => {
    const root = tmp();
    makeProject(join(root, 'game-a'), { name: 'game-a', dependencies: { '@trempel/kit': '^2.0.0' } });
    makeProject(join(root, 'group', 'game-b'), { name: 'game-b', devDependencies: { '@trempel/scene': '^2.0.0' } });
    makeProject(join(root, 'group', 'deep', 'game-c'), { name: 'game-c', dependencies: { '@trempel/kit': '^2.0.0' } });
    makeProject(join(root, 'not-a-game'), { name: 'web', dependencies: { react: '^18' } });
    write(join(root, 'plain', '.trempel', 'project.mdz'), '# plain\n');
    makeProject(join(root, 'game-a', 'node_modules', 'x'), { name: 'x', dependencies: { '@trempel/kit': '*' } });
    const elsewhere = makeProject(tmp(), { name: 'by-hand', dependencies: { '@trempel/scene': '^2.3.0' } });
    const found = scanProjects([root], [elsewhere], 2);
    expect(found.map((p) => p.name).sort()).toEqual(['by-hand', 'game-a', 'game-b', 'plain']);
    expect(found.find((p) => p.name === 'by-hand')!.manual).toBe(true);
    expect(scanProjects([root], [], 3).map((p) => p.name)).toContain('game-c');
  });

  it('2.4.1: projects sharing a name are labelled with their folder; ids stay', () => {
    const root = tmp();
    const a = makeProject(join(root, 'garden'), { name: 'garden-client', dependencies: { '@trempel/kit': '^2.4.0' } });
    const b = makeProject(join(root, 'garden-live'), { name: 'garden-client', dependencies: { '@trempel/kit': '^2.4.0' } });
    makeProject(join(root, 'puzzle'), { name: 'puzzle', dependencies: { '@trempel/kit': '^2.4.0' } });
    // the same name and the same folder name in two places: the path tells them apart
    const c = makeProject(join(root, 'x', 'garden'), { name: 'garden-client', dependencies: { '@trempel/kit': '^2.4.0' } });
    const found = scanProjects([root], [c], 2);
    const label = (dir: string): string => found.find((p) => p.root === dir)!.label;
    expect(found.find((p) => p.name === 'puzzle')!.label).toBe('puzzle');
    expect(label(b)).toBe('garden-client · garden-live');
    expect(label(a)).toBe(`garden-client · ${a}`);
    expect(label(c)).toBe(`garden-client · ${c}`);
    expect(new Set(found.map((p) => p.id)).size).toBe(found.length);
    expect(found.find((p) => p.root === a)!.id).toBe(describeProject(a).id);
    expect(found.find((p) => p.root === a)!.name).toBe('garden-client');
    // two of them only: the folder is enough
    const two = scanProjects([], [a, b], 2);
    expect(two.map((p) => p.label).sort()).toEqual(['garden-client · garden', 'garden-client · garden-live']);
  });

  it('the monorepo templates are projects; versions are the installed ones', () => {
    expect(isProject(join(REPO, 'templates', 'casual'))).toBe(true);
    const p = describeProject(join(REPO, 'templates', 'slot'));
    expect(p.kit).toBe('2.4.1');
    expect(p.scene).toMatch(/^2\./);
    expect(p.hasProjectFile).toBe(true);
  });
});
