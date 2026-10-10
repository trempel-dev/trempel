// actions.test.ts — the mdz form of actions, `${…}`, `when`.

import { describe, expect, it } from 'vitest';
import { parseActions } from '../src/actions.js';
import { interpolate, shellQuote, whenHolds, type VarContext } from '../src/vars.js';
import { makeProject, tmp } from './helpers.js';

const opts = { layer: 'project' as const, source: '.trempel/project.mdz', base: '/p' };

describe('parseActions', () => {
  it('reads the example of the spec (fields, inputs, a js service)', () => {
    const src = `# My game

Notes for people.

## collections
$skin: skins/default

## actions

### levels
$title: Сгенерировать уровни
$icon: sparkles
$group: content
$input.world: { type: "select", options: [1, 2, 3, 4, 5, 6, 7] }
$input.count: { type: "text", default: 5 }
$shell: node tools/gen-levels.js --world \${input.world} --count \${input.count}
$confirm: Тратит API (Flux)

### agent-port
$title: Агент: порт по скиллу
$icon: robot
$group: agents
$kind: service
$input.task: text
$js: tools/hub/agent.js

## notes
### not-an-action
$title: ignored
`;
    const { actions, errors } = parseActions(src, opts);
    expect(errors).toEqual([]);
    expect(actions.map((a) => a.id)).toEqual(['levels', 'agent-port']);
    const [levels, agent] = actions;
    expect(levels).toMatchObject({
      title: 'Сгенерировать уровни',
      icon: 'sparkles',
      group: 'content',
      kind: 'once',
      confirm: 'Тратит API (Flux)',
      shell: ['node tools/gen-levels.js --world ${input.world} --count ${input.count}'],
      layer: 'project',
    });
    expect(levels.inputs).toEqual([
      { name: 'world', type: 'select', options: [1, 2, 3, 4, 5, 6, 7], required: true },
      { name: 'count', type: 'text', default: 5, required: false },
    ]);
    expect(agent).toMatchObject({ kind: 'service', port: 'auto', js: 'tools/hub/agent.js', inputs: [{ name: 'task', type: 'text', required: true }] });
  });

  it('shell as a list, as a ```sh block; pin, port, when, env, cwd, url, description', () => {
    const src = [
      '## actions',
      '### a',
      '$shell: $[npm ci, npm test]',
      '$pin: true',
      '$when: $[git.dirty, file:package.json]',
      '### b',
      'Builds the thing.',
      '',
      '```sh',
      '# a comment',
      'npm run one',
      'npm run two',
      '```',
      '### c',
      '$kind: service',
      '$port: 4000',
      '$url: http://localhost:${port}/game/',
      '$cwd: web',
      '$env: { MODE: "dev", LEVEL: 3 }',
      '$shell: npx vite --port ${port}',
    ].join('\n');
    const { actions, errors } = parseActions(src, opts);
    expect(errors).toEqual([]);
    expect(actions[0]).toMatchObject({ id: 'a', shell: ['npm ci', 'npm test'], pin: true, when: ['git.dirty', 'file:package.json'] });
    expect(actions[1]).toMatchObject({ id: 'b', shell: ['npm run one', 'npm run two'], description: 'Builds the thing.' });
    expect(actions[2]).toMatchObject({ id: 'c', kind: 'service', port: 4000, url: 'http://localhost:${port}/game/', cwd: 'web', env: { MODE: 'dev', LEVEL: '3' } });
  });

  it('a broken action is left out with a coded error; the rest stay', () => {
    const src = [
      '## actions',
      '### ok',
      '$shell: echo ok',
      '### both',
      '$shell: echo',
      '$js: x.js',
      '### none',
      '$title: nothing to run',
      '### typo',
      '$shel: echo',
      '### bad id!',
      '$shell: echo',
      '### ok',
      '$shell: echo again',
      '### sel',
      '$input.x: { type: "select" }',
      '$shell: echo',
      '### kind',
      '$kind: daemon',
      '$shell: echo',
      '### json',
      '$input.x: { type: select }',
      '$shell: echo',
    ].join('\n');
    const { actions, errors } = parseActions(src, opts);
    expect(actions.map((a) => a.id)).toEqual(['ok']);
    expect(errors).toHaveLength(8);
    expect(errors.every((e) => e.startsWith('E_HUB_ACTION: .trempel/project.mdz:'))).toBe(true);
  });
});

describe('${…} and when', () => {
  const ctx: VarContext = {
    project: { root: '/work/game', name: 'game', kit: '2.4.0', scene: '2.3.0' },
    input: { msg: "it's done; rm -rf /", n: 3 },
    port: 5555,
    url: 'http://localhost:5555/',
    services: { editor: { port: 6000, url: 'http://localhost:6000/' } },
    here: '/kit/hub',
  };

  it('substitutes the known namespaces and quotes for the shell; leaves the shell its own ${…}', () => {
    expect(interpolate('git commit -m ${input.msg}', ctx, true)).toBe(`git commit -m 'it'\\''s done; rm -rf /'`);
    expect(interpolate('--count ${input.n} --port ${port} ${url}', ctx, true)).toBe('--count 3 --port 5555 http://localhost:5555/');
    expect(interpolate('edit --port ${services.editor.port} in ${project.name}@${project.kit} ${here}', ctx)).toBe('edit --port 6000 in game@2.4.0 /kit/hub');
    expect(interpolate('echo ${HOME} ${1:-x}', ctx, true)).toBe('echo ${HOME} ${1:-x}');
    expect(() => interpolate('${input.nope}', ctx)).toThrow(/E_HUB_VAR/);
    expect(() => interpolate('${services.dev.url}', ctx)).toThrow(/not running/);
    expect(shellQuote('')).toBe("''");
  });

  it('when: git, git.dirty, file:, dep:, script:, running:, negation', () => {
    const root = makeProject(tmp(), { name: 'w', dependencies: { '@trempel/kit': '^2.4.0' }, scripts: { dev: 'vite' } }, { 'levels/a.json': '{}' });
    const base = { root, git: { branch: 'main', dirty: true, changes: 1, ahead: 0, behind: 0, upstream: null }, running: new Set(['editor']), vars: { ...ctx, project: { ...ctx.project, root } } };
    const holds = (...when: string[]): boolean => whenHolds({ when }, base);
    expect(holds('git', 'git.dirty', 'file:levels/a.json', 'dep:@trempel/kit', 'script:dev', 'running:editor')).toBe(true);
    expect(holds('!git.dirty')).toBe(false);
    expect(holds('file:nope.txt')).toBe(false);
    expect(holds('dep:@trempel/slot')).toBe(false);
    expect(holds('running:dev')).toBe(false);
    expect(holds('git.upstream')).toBe(false);
    expect(holds('mystery')).toBe(false);
    expect(whenHolds({ when: ['git'] }, { ...base, git: null })).toBe(false);
  });
});
