// 2.3: clip commands (ClipsDocument) — the md diff (untouched lines byte for byte), undo, a command
// adding compile errors rolls back; the scene's history over base + heir + clips; node.setId
// rewrites the clips; heir.setAttr / heir.insertFx.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf, compileClipsResult, parse } from '@trempel/scene/core';
import { openClips, openDocument, clipCommands, type ClipsDocument } from './index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const codes = (r: { errors?: string[] }): (string | null | undefined)[] => (r.errors ?? []).map(codeOf);

/** Lines of `b` that are not lines of `a` at the same place, and the other way round (a tiny diff). */
function diff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split('\n');
  const y = b.split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  return { removed: x.slice(s, x.length - e), added: y.slice(s, y.length - e) };
}

// A compact table (the hand-written style of the consumers) and an aligned one (the spec's).
const MD = `Clips of the card. Prose stays as written.
$tex: art/{}.png

# $clip collect
$duration: 1.35
$loop: false

## $track card
| t | x | y | scale | ease |
|---|---|---|---|---|
| 0 | 0 | 0 | 1 | out |
| 0.25 | 0 | -20 | 1.02 | inOut |
| 1.15 | $toX | $toY | 0.5 | linear |
| 1.35 | $toX | $toY | 0.5 | |

## $track shade
| t    | alpha | ease  |
|------|-------|-------|
| 0    | 0     | inOut |
| 0.5  | 1     |       |

## $events
| t | event |
|---|---|
| 0.25 | sfx:stamp |
| 1.35 | overlay:close |

# $clip idle
$duration: 2
$loop: true

## $track card
| t | rotation | ease |
| --- | --- | --- |
| 0 | 0 | inOut |
| 1 | 3 | inOut |
| 2 | 0 |  |
`;

const SCENE = parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="card"><rect width="10" height="10"/></g>
  <rect id="shade" width="100" height="100"/>
  <g id="spot"/>
</svg>`);

const open = (md = MD): ClipsDocument => openClips(md, 'anim/card.md', { scene: () => SCENE });

describe('ClipsDocument: reading', () => {
  it('opens and saves byte for byte; compiles clean', () => {
    const d = open();
    expect(d.toString()).toBe(MD);
    expect(d.errors).toEqual([]);
    expect(d.clips().map((c) => c.name)).toEqual(['collect', 'idle']);
    const c = d.clip('collect')!;
    expect(c.duration).toBe(1.35);
    expect(c.tracks.map((t) => [t.target, t.columns])).toEqual([
      ['card', ['x', 'y', 'scale']],
      ['shade', ['alpha']],
    ]);
    expect(c.tracks[0].keys.x.map((k) => [k.t, k.value, k.ease, k.param ?? null])).toEqual([
      [0, '0', 'out', null],
      [0.25, '0', 'inOut', null],
      [1.15, '$toX', 'linear', 'toX'],
      [1.35, '$toX', '', 'toX'],
    ]);
    expect(c.events).toEqual([
      { t: 0.25, event: 'sfx:stamp' },
      { t: 1.35, event: 'overlay:close' },
    ]);
  });

  it('keeps a BOM and CRLF', () => {
    const md = `﻿${MD.replace(/\n/g, '\r\n')}`;
    const d = open(md);
    expect(d.toString()).toBe(md);
    d.exec('key.set', { clip: 'collect', target: 'card', column: 'x', t: 0.25, value: 4 });
    expect(d.toString().startsWith('﻿')).toBe(true);
    expect(d.toString().split('\r\n').length).toBe(md.split('\r\n').length);
  });

  it('the repository clips open and save unchanged; a key set to its own value changes nothing', () => {
    for (const f of ['examples/motion/anim/motion.md', 'examples/finddiff/anim/found.md', 'examples/prefabs/anim/popup-pause.md', 'test/fixtures/v091/clipjson/anim/m.md']) {
      const md = read(f);
      const d = openClips(md, f);
      expect(d.toString()).toBe(md);
      expect(d.clips().length).toBeGreaterThan(0);
      // every key set to its own value: not a byte changes (hand-made spacing included)
      for (const c of d.clips()) for (const t of c.tracks) for (const col of t.columns) for (const k of t.keys[col]) {
        expect(d.exec('key.set', { clip: c.name, target: t.target, column: col, t: k.t, value: k.value }).ok).toBe(true);
        expect(d.toString(), `${f} ${c.name} ${t.target}.${col}@${k.t}`).toBe(md);
      }
    }
  });

  it('every command has a schema and a description', () => {
    for (const [name, c] of Object.entries(clipCommands)) {
      expect(c.describe.length, name).toBeGreaterThan(10);
      expect(c.schema.type, name).toBe('object');
    }
  });
});

describe('key commands', () => {
  it('key.set on an existing key changes one cell of one row (compact table)', () => {
    const d = open();
    const r = d.exec('key.set', { clip: 'collect', target: 'card', column: 'y', t: 0.25, value: -24 });
    expect(r.ok).toBe(true);
    expect(diff(MD, d.toString())).toEqual({ removed: ['| 0.25 | 0 | -20 | 1.02 | inOut |'], added: ['| 0.25 | 0 | -24 | 1.02 | inOut |'] });
    expect(d.undo()).toBe(true);
    expect(d.toString()).toBe(MD);
    expect(d.redo()).toBe(true);
    expect(d.clip('collect')!.tracks[0].keys.y[1].value).toBe('-24');
  });

  it('key.set on an aligned table: its widths never narrow — a value that fits changes one row; a wider one re-aligns that table only', () => {
    const d = open();
    d.exec('key.set', { clip: 'collect', target: 'shade', column: 'alpha', t: 0.5, value: 0.875 });
    expect(diff(MD, d.toString())).toEqual({ removed: ['| 0.5  | 1     |       |'], added: ['| 0.5  | 0.875 |       |'] });
    d.exec('key.set', { clip: 'collect', target: 'shade', column: 'alpha', t: 0, value: 0.123456 });
    expect(diff(MD, d.toString())).toEqual({
      removed: ['| t    | alpha | ease  |', '|------|-------|-------|', '| 0    | 0     | inOut |', '| 0.5  | 1     |       |'],
      added: ['| t    | alpha  | ease  |', '|------|--------|-------|', '| 0    | 0.1235 | inOut |', '| 0.5  | 0.875  |       |'],
    });
    // a number as written stays as written
    d.exec('key.set', { clip: 'collect', target: 'card', column: 'x', t: 0, value: '0.50' });
    expect(d.clip('collect')!.tracks[0].keys.x[0].value).toBe('0.50');
  });

  it('key.set at a new time inserts a row in order (the row before lends its ease)', () => {
    const d = open();
    d.exec('key.set', { clip: 'collect', target: 'card', column: 'x', t: 0.6, value: 12 });
    expect(diff(MD, d.toString()).added).toEqual(['| 0.6 | 12 |  |  | inOut |']);
    expect(d.errors).toEqual([]);
  });

  it('key.set of a new column adds it before ease; of a new target adds a track after the last one', () => {
    const d = open();
    d.exec('key.set', { clip: 'collect', target: 'card', column: 'rotation', t: 0, value: 5 });
    expect(d.clip('collect')!.tracks[0].columns).toEqual(['x', 'y', 'scale', 'rotation']);
    expect(d.toString()).toContain('| t | x | y | scale | rotation | ease |');
    d.exec('key.set', { clip: 'collect', target: 'spot', column: 'alpha', t: 0.5, value: 1 });
    const text = d.toString();
    expect(text).toContain('## $track spot\n| t | alpha | ease |\n|---|---|---|\n| 0.5 | 1 |  |\n\n## $events');
    expect(d.errors).toEqual([]);
    expect(d.history.length).toBe(2);
  });

  it('key.set rejects a string in a number column; a missing target is a compile error and rolls back', () => {
    const d = open();
    expect(codes(d.exec('key.set', { clip: 'collect', target: 'card', column: 'x', t: 0, value: 'abc' }))).toEqual(['E_EDITOR_CLIP_VALUE']);
    const r = d.exec('key.set', { clip: 'collect', target: 'ghost', column: 'x', t: 0, value: 1 });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['E_ANIM_TARGET']);
    expect(d.toString()).toBe(MD);
    expect(d.history.length).toBe(0);
    expect(codes(d.exec('key.set', { clip: 'nope', target: 'card', column: 'x', t: 0, value: 1 }))).toEqual(['E_EDITOR_CLIP_NONE']);
    expect(codes(d.exec('key.set', { clip: 'collect', target: 'card', column: 'speed', t: 0, value: 1 }))).toEqual(['E_EDITOR_ARGS']);
  });

  it('key.set past $duration is a compile error: rolled back', () => {
    const d = open();
    const r = d.exec('key.set', { clip: 'collect', target: 'card', column: 'x', t: 2, value: 1 });
    expect(codes(r)).toEqual(['E_ANIM_TIME']);
    expect(d.toString()).toBe(MD);
  });

  it('key.remove empties a cell; an empty row goes; an empty track goes', () => {
    const d = open();
    d.exec('key.remove', { clip: 'collect', keys: [{ target: 'shade', column: 'alpha', t: 0.5 }] });
    expect(d.clip('collect')!.tracks[1].keys.alpha.length).toBe(1);
    d.exec('key.remove', { clip: 'collect', keys: [{ target: 'shade', column: 'alpha', t: 0 }] });
    expect(d.clip('collect')!.tracks.map((t) => t.target)).toEqual(['card']);
    expect(d.toString()).not.toContain('$track shade');
    expect(d.toString()).not.toMatch(/\n\n\n/);
    expect(codes(d.exec('key.remove', { clip: 'collect', keys: [{ target: 'card', column: 'x', t: 0.9 }] }))).toEqual(['E_EDITOR_CLIP_KEY']);
  });

  it('key.move — a selection in one step, snapped to frames; a row moves whole with its ease', () => {
    const d = open();
    const keys = (['x', 'y', 'scale'] as const).map((column) => ({ target: 'card', column, t: 0.25 }));
    const r = d.exec('key.move', { clip: 'collect', keys, dt: 0.2 });
    expect(r.ok).toBe(true);
    expect(diff(MD, d.toString())).toEqual({ removed: ['| 0.25 | 0 | -20 | 1.02 | inOut |'], added: ['| 0.45 | 0 | -20 | 1.02 | inOut |'] });
    expect(d.history.length).toBe(1);
    d.undo();
    expect(d.toString()).toBe(MD);
  });

  it('key.move of one cell of a row splits the row; onto an existing key is an error', () => {
    const d = open();
    d.exec('key.move', { clip: 'collect', keys: [{ target: 'card', column: 'scale', t: 0.25 }], dt: 0.1 });
    const card = d.clip('collect')!.tracks[0];
    expect(card.keys.scale.map((k) => k.t)).toEqual([0, 0.35, 1.15, 1.35]);
    expect(card.keys.x.map((k) => k.t)).toEqual([0, 0.25, 1.15, 1.35]);
    expect(card.keys.scale[1].ease).toBe('inOut');
    const r = d.exec('key.move', { clip: 'collect', keys: [{ target: 'card', column: 'x', t: 0 }], dt: 0.25 });
    expect(codes(r)).toEqual(['E_EDITOR_CLIP_KEY']);
  });

  it('key.move snaps: to a key within 2 frames, else to the frame', () => {
    const d = open();
    d.exec('key.move', { clip: 'collect', keys: [{ target: 'shade', column: 'alpha', t: 0.5 }], dt: -0.26 });
    expect(d.clip('collect')!.tracks[1].keys.alpha.map((k) => k.t)).toEqual([0, 0.25]); // 0.24 → the card's key at 0.25
    d.exec('key.move', { clip: 'collect', keys: [{ target: 'shade', column: 'alpha', t: 0.25 }], dt: 0.3071 });
    expect(d.clip('collect')!.tracks[1].keys.alpha[1].t).toBeCloseTo(Math.round(0.5571 * 60) / 60, 3);
    const e = open();
    e.exec('key.move', { clip: 'collect', keys: [{ target: 'shade', column: 'alpha', t: 0.5 }], dt: 0.0123, snap: false });
    expect(e.clip('collect')!.tracks[1].keys.alpha[1].t).toBe(0.5123);
  });

  it('key.setEase sets the row ease (named, Bézier, none); key.setParam swaps number ↔ $name', () => {
    const d = open();
    d.exec('key.setEase', { clip: 'collect', keys: [{ target: 'card', column: 'x', t: 0 }], ease: 'outBack' });
    expect(diff(MD, d.toString()).added).toEqual(['| 0 | 0 | 0 | 1 | outBack |']);
    d.exec('key.setEase', { clip: 'collect', keys: [{ target: 'card', column: 'x', t: 0 }], ease: [0.2, 0, 0.1, 1] });
    expect(d.clip('collect')!.tracks[0].keys.x[0].ease).toBe('[0.2, 0, 0.1, 1]');
    expect(d.errors).toEqual([]);
    d.exec('key.setEase', { clip: 'collect', keys: [{ target: 'card', column: 'x', t: 0 }], ease: null });
    expect(d.clip('collect')!.tracks[0].keys.x[0].ease).toBe('');
    expect(codes(d.exec('key.setEase', { clip: 'collect', keys: [{ target: 'card', column: 'x', t: 0 }], ease: 'wobble' }))).toEqual(['E_EDITOR_ARGS']);

    d.exec('key.setParam', { clip: 'collect', target: 'card', column: 'y', t: 0.25, param: 'lift' });
    expect(d.clip('collect')!.tracks[0].keys.y[1].param).toBe('lift');
    d.exec('key.setParam', { clip: 'collect', target: 'card', column: 'x', t: 1.15, param: null, value: 40 });
    expect(d.clip('collect')!.tracks[0].keys.x[2].value).toBe('40');
    expect(compileClipsResult(d.toString()).errors).toEqual([]);
  });
});

describe('clip, track and event commands', () => {
  it('clip.create / rename / duplicate / remove / setAttr', () => {
    const d = open();
    d.exec('clip.create', { name: 'pop', duration: 0.5 });
    expect(d.toString().endsWith('| 2 | 0 |  |\n\n# $clip pop\n$duration: 0.5\n')).toBe(true);
    expect(codes(d.exec('clip.create', { name: 'pop' }))).toEqual(['E_EDITOR_CLIP_TAKEN']);
    d.exec('clip.rename', { clip: 'pop', name: 'pulse' });
    expect(d.clips().map((c) => c.name)).toEqual(['collect', 'idle', 'pulse']);
    d.exec('clip.duplicate', { clip: 'idle', name: 'idle2' });
    expect(d.clips().map((c) => c.name)).toEqual(['collect', 'idle', 'idle2', 'pulse']);
    expect(d.clip('idle2')!.tracks[0].keys.rotation.length).toBe(3);
    d.exec('clip.remove', { clip: 'idle2' });
    d.exec('clip.remove', { clip: 'pulse' });
    expect(d.toString()).toBe(MD);
    d.exec('clip.setAttr', { clip: 'collect', name: 'duration', value: 1.5 });
    d.exec('clip.setAttr', { clip: 'collect', name: 'loop', value: null });
    expect(diff(MD, d.toString())).toEqual({ removed: ['$duration: 1.35', '$loop: false'], added: ['$duration: 1.5'] });
    expect(codes(d.exec('clip.setAttr', { clip: 'collect', name: 'duration', value: -1 }))).toEqual(['E_EDITOR_CLIP_VALUE']);
  });

  it('clip.create in an empty file', () => {
    const d = openClips('', 'anim/new.md');
    d.exec('clip.create', { name: 'a', loop: true });
    expect(d.toString()).toBe('# $clip a\n$loop: true\n');
    d.exec('key.set', { clip: 'a', target: 'card', column: 'alpha', t: 0, value: 1 });
    expect(d.toString()).toBe('# $clip a\n$loop: true\n\n## $track card\n| t | alpha | ease |\n|---|---|---|\n| 0 | 1 |  |\n');
  });

  it('track.add / retarget / setAttr / remove', () => {
    const d = open();
    d.exec('track.add', { clip: 'idle', target: 'spot', columns: ['alpha'] });
    expect(d.clip('idle')!.tracks.map((t) => t.target)).toEqual(['card', 'spot']);
    expect(codes(d.exec('track.add', { clip: 'idle', target: 'card', columns: ['rotation'] }))).toEqual(['E_EDITOR_CLIP_TRACK']);
    d.exec('track.retarget', { clip: 'idle', target: 'spot', to: 'shade' });
    expect(d.clip('idle')!.tracks[1].target).toBe('shade');
    const bad = d.exec('track.setAttr', { clip: 'idle', target: 'shade', name: 'path', value: 'spot' });
    expect(codes(bad)).toContain('E_ANIM_MOTION'); // $path without motion — the compile refuses it
    d.exec('track.remove', { clip: 'idle', target: 'shade' });
    expect(d.toString()).toBe(MD);
  });

  it('event.add / move / set / remove (fx: markers too)', () => {
    const d = open();
    d.exec('event.add', { clip: 'collect', t: 0.8, event: 'fx:burst@spot' });
    expect(diff(MD, d.toString()).added).toEqual(['| 0.8 | fx:burst@spot |']);
    expect(d.clip('collect')!.events.map((e) => e.event)).toEqual(['sfx:stamp', 'fx:burst@spot', 'overlay:close']);
    d.exec('event.move', { clip: 'collect', events: [{ t: 0.8, event: 'fx:burst@spot' }], dt: 0.1 });
    expect(d.clip('collect')!.events[1].t).toBe(0.9);
    d.exec('event.set', { clip: 'collect', event: { t: 0.9, event: 'fx:burst@spot' }, name: 'fx:sparkle@spot', t: 0.3 });
    expect(d.clip('collect')!.events.map((e) => [e.t, e.event])).toEqual([
      [0.25, 'sfx:stamp'],
      [0.3, 'fx:sparkle@spot'],
      [1.35, 'overlay:close'],
    ]);
    d.exec('event.remove', { clip: 'collect', events: [{ t: 0.3, event: 'fx:sparkle@spot' }] });
    expect(d.toString()).toBe(MD);
    d.exec('event.add', { clip: 'idle', t: 1, event: 'blink' });
    expect(d.toString().endsWith('| 2 | 0 |  |\n\n## $events\n| t | event |\n| --- | --- |\n| 1 | blink |\n')).toBe(false); // the file's style: |---|
    expect(d.toString().endsWith('| 2 | 0 |  |\n\n## $events\n| t | event |\n|---|---|\n| 1 | blink |\n')).toBe(true);
    d.exec('event.remove', { clip: 'idle', events: [{ t: 1, event: 'blink' }] });
    expect(d.toString()).toBe(MD);
    expect(codes(d.exec('event.remove', { clip: 'idle', events: [{ t: 1, event: 'blink' }] }))).toEqual(['E_EDITOR_CLIP_EVENT']);
  });

  it('a batch is one undo step; a failing call rolls the batch back', () => {
    const d = open();
    const ok = d.batch('two', [
      { name: 'key.set', args: { clip: 'collect', target: 'card', column: 'x', t: 0.25, value: 3 } },
      { name: 'event.add', args: { clip: 'collect', t: 0.5, event: 'sfx:pop' } },
    ]);
    expect(ok.ok).toBe(true);
    expect(d.history.length).toBe(1);
    d.undo();
    expect(d.toString()).toBe(MD);
    const bad = d.batch('bad', [
      { name: 'key.set', args: { clip: 'collect', target: 'card', column: 'x', t: 0.25, value: 3 } },
      { name: 'key.set', args: { clip: 'nope', target: 'card', column: 'x', t: 0, value: 1 } },
    ]);
    expect(codes(bad)).toEqual(['E_EDITOR_CLIP_NONE']);
    expect(d.toString()).toBe(MD);
  });
});

describe('the scene document: clips, heir, one history', () => {
  const BASE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="card"><rect width="10" height="10"/></g>
  <rect id="shade" width="100" height="100"/>
  <g id="spot" transform="translate(50 50)"/>
</svg>
`;
  const HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">
  <!-- logic -->
  <tml:ref id="spot" tml:type="fx"/>
</svg>
`;

  it('clipsDoc edits record into the scene history; node.setId rewrites the clips', () => {
    const doc = openDocument(BASE, { heir: HEIR, clips: { 'anim/card.md': MD } });
    expect(doc.errors).toEqual([]);
    const clips = doc.clipsDoc('anim/card.md')!;
    expect(clips.exec('key.set', { clip: 'collect', target: 'card', column: 'x', t: 0, value: 7 }).ok).toBe(true);
    expect(doc.history.map((h) => h.label)).toEqual(['key.set']);
    expect(doc.dirty).toBe(true);
    expect(clips.dirty).toBe(true);
    // a compile error against the scene: the target is checked
    expect(codes(clips.exec('key.set', { clip: 'collect', target: 'nobody', column: 'x', t: 0, value: 1 }))).toEqual(['E_ANIM_TARGET']);
    const r = doc.exec('node.setId', { node: 'card', id: 'postcard' });
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
    expect(clips.toString()).toContain('## $track postcard');
    expect(clips.toString()).not.toContain('## $track card');
    expect(doc.errors).toEqual([]);
    doc.undo();
    expect(clips.toString()).toContain('## $track card');
    doc.undo();
    expect(clips.toString()).toBe(MD);
    expect(doc.dirty).toBe(false);
  });

  it('node.setId follows $path and fx:…@id events', () => {
    const md = `# $clip fly
$duration: 1

## $track card
$path: spot
| t | motion |
|---|---|
| 0 | 0 |
| 1 | 1 |

## $events
| t | event |
|---|---|
| 0.5 | fx:burst@spot |
`;
    const base = BASE.replace('<g id="spot" transform="translate(50 50)"/>', '<circle id="spot" cx="50" cy="50" r="20"/>');
    const doc = openDocument(base, { clips: { 'anim/fly.md': md } });
    doc.exec('node.setId', { node: 'spot', id: 'ring' });
    const text = doc.clipsDoc('anim/fly.md')!.toString();
    expect(text).toContain('$path: ring');
    expect(text).toContain('| 0.5 | fx:burst@ring |');
    const a = md.split('\n');
    const b = text.split('\n');
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual(['$path: spot', '| 0.5 | fx:burst@spot |']);
  });

  it('a script group covers base and clips; tml.run-style begin/end is one undo', () => {
    const doc = openDocument(BASE, { clips: { 'anim/card.md': MD } });
    const clips = doc.clipsDoc('anim/card.md')!;
    doc.begin('script');
    doc.exec('node.setAttr', { node: 'shade', name: 'fill', value: '#000' });
    clips.exec('event.add', { clip: 'idle', t: 1, event: 'blink' });
    doc.end();
    expect(doc.history.map((h) => h.label)).toEqual(['script']);
    doc.undo();
    expect(clips.toString()).toBe(MD);
    expect(doc.serialize()).toBe(BASE);
  });

  it('heir.setAttr: a ref takes tml:* only; a new ref for a base node; minimal diff', () => {
    const doc = openDocument(BASE, { heir: HEIR });
    expect(doc.exec('heir.setAttr', { node: 'spot', name: 'tml:effect', value: 'burst' }).ok).toBe(true);
    expect(diff(HEIR, doc.serializeHeir()!)).toEqual({ removed: ['  <tml:ref id="spot" tml:type="fx"/>'], added: ['  <tml:ref id="spot" tml:type="fx" tml:effect="burst"/>'] });
    expect(doc.heirDirty).toBe(true);
    expect(codes(doc.exec('heir.setAttr', { node: 'spot', name: 'data-effect', value: 'x' }))).toEqual(['E_REF_FOREIGN']);
    doc.exec('heir.setAttr', { node: 'card', name: 'tml:visible', value: 'state.on' });
    expect(doc.serializeHeir()).toContain('  <tml:ref id="card" tml:visible="state.on"/>\n</svg>');
    doc.undo();
    doc.undo();
    expect(doc.serializeHeir()).toBe(HEIR);
    expect(doc.heirDirty).toBe(false);
    expect(doc.serialize()).toBe(BASE);
  });

  it('heir.insertFx: a new fx node into a group; then its data-* through heir.setAttr', () => {
    const doc = openDocument(BASE, { heir: HEIR });
    const r = doc.exec('heir.insertFx', { into: 'spot', id: 'sparks', effect: 'sparkle', x: 4, y: -2.5 });
    expect(r.ok).toBe(true);
    expect(diff(HEIR, doc.serializeHeir()!).added).toEqual(['  <g id="sparks" tml:insert="into spot" tml:type="fx" transform="translate(4 -2.5)" data-effect="sparkle"/>']);
    expect(doc.errors).toEqual([]);
    doc.exec('heir.setAttr', { node: 'sparks', name: 'data-scale', value: 1.5 });
    expect(doc.serializeHeir()).toContain('data-effect="sparkle" data-scale="1.5"/>');
    expect(codes(doc.exec('heir.insertFx', { into: 'spot', id: 'card', effect: 'x' }))).toEqual(['E_EDITOR_ID_TAKEN']);
    expect(codes(doc.exec('heir.insertFx', { into: 'shade', id: 'z', effect: 'x' }))).toEqual(['E_EDITOR_TAG']);
    expect(codes(openDocument(BASE).exec('heir.insertFx', { into: 'spot', id: 'z', effect: 'x' }))).toEqual(['E_EDITOR_NO_HEIR']);
  });

  it('heirOnly: the base is read-only, the heir and the clips are edited', () => {
    const heir = HEIR.replace('tml:extends="scene.svg"', 'tml:extends="parent.svg"');
    const loadScene = (rel: string) => (rel === 'parent.svg' ? { base: BASE } : null);
    const doc = openDocument(BASE, { heir, heirOnly: true, loadScene, clips: { 'anim/card.md': MD } });
    expect(doc.errors).toEqual([]);
    expect(codes(doc.exec('node.move', { node: 'card', dx: 1, dy: 0 }))).toEqual(['E_EDITOR_READONLY']);
    expect(doc.exec('heir.insertFx', { into: 'spot', id: 'sparks', effect: 'sparkle' }).ok).toBe(true);
    expect(doc.clipsDoc('anim/card.md')!.exec('event.add', { clip: 'collect', t: 0.5, event: 'fx:sparkle@sparks' }).ok).toBe(true);
    expect(doc.history.length).toBe(2);
  });
});
