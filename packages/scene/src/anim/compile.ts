// compile.ts — clips as clip tables (the canon people and agents write) → anim.json (the runtime form).
//
//   # $clip idle                ← one block per clip
//   $duration: 2.4              ← optional; default — the last key / event
//   $loop: true
//
//   ## $track mascotHead        ← one table per part (several tables per id are fine, different columns)
//   $path: fly1                 ← motion only: geometry id; $orient: auto, $orient-offset: deg, $offset: dx, dy
//   | t | rotation | tex | ease |
//   |---|----------|-----|------|
//   | 0 | 0        | a   | inOut|
//
//   ## $events                  ← markers
//   | t | event |
//
// Columns: t; x, y, rotation (degrees) — offsets from the node's rest pose; scale | scaleX | scaleY —
// multipliers of it; alpha — absolute; tex → href (held until the next one); motion — fraction 0..1
// of $path's length; ease — how to go FROM this key TO the next one (the player keeps ease on the
// segment's destination key, so it is moved one key forward). An empty cell is no key.
//
// JSON produced: rotation in radians, `relative: true` on x/y/rotation/scale.* tracks, `scale` split
// into scale.x + scale.y, motion as { property: 'motion', path, orient?, orientOffset? (rad), offset? }.
// v0.8 columns: tint (#rrggbb, absolute, interpolated per RGB channel → numbers 0xRRGGBB), z (integer
// order among siblings, absolute, always `step` — the row's ease does not apply), skewX / skewY (degrees,
// relative like rotation → skew.x / skew.y in radians), view (a data-views variant name of the
// target image → an href track; needs the scene).
// v0.9.1 columns: dash (stroke-dashoffset, absolute → property 'stroke-dashoffset'), strokeWidth
// (absolute, ≥ 0 → 'stroke-width'), strokeAlpha (stroke-opacity, absolute 0..1 → 'stroke-opacity') —
// on geometry; with the scene a dash target must have a stroke-dasharray.
// v1.0 columns: width / height (absolute, > 0) — the size of an <image data-slices> (9-slice panel) or of
// an instance of a resizable prefab (along its data-resizable axes); with the scene any other target
// is an error.
// v0.9.1 `$tex` — how a `tex` cell becomes an href, written next to the clips (the CLI's --tex, when
// given, overrides it):
//
//   $tex: art/{}.png            ← a template ({} — the cell) on the file (before the first clip),
//                                 a clip or a track
//   ## $tex                     ← a table in a clip: names it maps one by one
//   | name | href |
//
// Order: the track's template → the clip's table → the clip's template → the file's template.
// Without any of them the cell is the href as written (v0.7).
// Every problem is collected; compileClips throws one TrempelError with the list.

import { parse as parseMd, type Block } from '../md/index.js';
import { TrempelError } from '../errors.js';
import { coded, within } from '../codes.js';
import { GEOMETRY_TAGS } from '../geom/pathdata.js';
import type { SceneNode } from '../parser.js';
import { parseTint, parseViews, singleImage } from '../props.js';
import { walk } from '../tree.js';
import { NAMED } from './easing.js';
import type { AnimClip, Ease, Keyframe, Marker, Track } from './types.js';

export interface CompileClipsOptions {
  /**
   * `tex` cell → href (e.g. `(n) => \`art/${n}.png\``) — overrides the file's `$tex`. Default: the
   * clips' own `$tex`, else the cell as written.
   */
  tex?: (name: string) => string;
}

/** Outcome without throwing: clips compiled so far and every problem found. */
export interface CompileClipsResult {
  clips: Record<string, AnimClip>;
  errors: string[];
}

const COLUMNS = new Set([
  't', 'x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY', 'alpha', 'tint', 'z', 'tex', 'view', 'motion',
  'dash', 'strokeWidth', 'strokeAlpha', 'width', 'height', 'ease',
]);
const TRACK_ATTRS = new Set(['path', 'orient', 'orient-offset', 'offset', 'tex']);
const CLIP_ATTRS = new Set(['duration', 'loop', 'tex']);
/** v0.9.1 stroke columns → the setProp path (an SVG attribute name). */
const STROKE_COLUMNS: Record<string, string> = { dash: 'stroke-dashoffset', strokeWidth: 'stroke-width', strokeAlpha: 'stroke-opacity' };
const RAD = Math.PI / 180;

interface Table {
  columns: string[];
  rows: { cells: Record<string, string>; line: number }[];
}

/** A markdown pipe table (header, |---| separator, rows) → raw trimmed cells. */
function parseTable(body: string, where: string, errors: string[]): Table | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const rowsAt = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith('|'));
  if (!rowsAt.length) {
    errors.push(coded('E_ANIM_SYNTAX', `${where}: no key table (| t | … |).`));
    return null;
  }
  const split = (l: string): string[] => {
    const inner = l.replace(/^\|/, '').replace(/\|$/, '');
    return inner.split('|').map((c) => c.trim());
  };
  const columns = split(rowsAt[0].l);
  const sep = rowsAt[1];
  if (!sep || !split(sep.l).every((c) => /^:?-{1,}:?$/.test(c))) {
    errors.push(coded('E_ANIM_SYNTAX', `${where}: the table header needs a |---|---| row under it.`));
    return null;
  }
  const rows: Table['rows'] = [];
  for (const { l, i } of rowsAt.slice(2)) {
    const cells = split(l);
    const rec: Record<string, string> = {};
    columns.forEach((c, j) => (rec[c] = cells[j] ?? ''));
    rows.push({ cells: rec, line: i + 1 });
  }
  return { columns, rows };
}

function parseEase(raw: string): Ease | null {
  const v = raw.trim();
  if (Object.prototype.hasOwnProperty.call(NAMED, v)) return v as Ease;
  const m = /^\[\s*([^\]]+)\]$/.exec(v);
  if (m) {
    const parts = m[1].split(',').map((p) => Number(p.trim()));
    if (parts.length === 4 && parts.every(Number.isFinite)) return parts as [number, number, number, number];
  }
  return null;
}

const attrText = (b: Block, key: string): string | undefined => {
  let out: string | undefined;
  for (const a of b.attrs) {
    if (a.key.length === 1 && a.key[0] === key) {
      const v = a.value;
      out = typeof v === 'object' && v !== null && 'raw' in v ? String((v as { raw: string }).raw) : Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return out;
};

const bodyText = (b: Block): string => (b.body == null ? '' : typeof b.body === 'string' ? b.body : b.body.raw);

/** A `$tex` template → name → href. Pushes an error (and returns null) when it has no `{}`. */
function texTemplate(raw: string | undefined, where: string, errors: string[]): ((name: string) => string) | null {
  if (raw === undefined) return null;
  const tpl = raw.trim();
  if (!tpl.includes('{}')) {
    errors.push(coded('E_ANIM_TEX', `${where}: $tex: "${raw}" — a template without {} (e.g. art/{}.png; one name at a time — a ## $tex | name | href | table).`));
    return null;
  }
  return (name) => tpl.replaceAll('{}', name);
}

/** A clip's `## $tex` table → name → href. */
function texTable(block: Block, where: string, errors: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const table = parseTable(bodyText(block), where, errors);
  if (!table) return out;
  if (!table.columns.includes('name') || !table.columns.includes('href')) {
    errors.push(coded('E_ANIM_TEX', `${where}: the table needs the columns name and href.`));
    return out;
  }
  for (const row of table.rows) {
    const { name, href } = row.cells;
    if (!name || !href) {
      errors.push(coded('E_ANIM_TEX', `${where}, row ${row.line}: empty ${!name ? 'name' : 'href'}.`));
      continue;
    }
    if (out.has(name)) errors.push(coded('E_ANIM_TEX', `${where}, row ${row.line}: the name "${name}" twice.`));
    out.set(name, href);
  }
  return out;
}

/** Ids of the scene (first wins), with the info the checks need. */
function sceneInfo(scene: SceneNode): Map<string, { node: SceneNode; inDefs: boolean }> {
  const out = new Map<string, { node: SceneNode; inDefs: boolean }>();
  const visit = (n: SceneNode, inDefs: boolean): void => {
    if (n.attrs.id && !out.has(n.attrs.id)) out.set(n.attrs.id, { node: n, inDefs });
    for (const c of n.children) visit(c, inDefs || n.tag === 'defs');
  };
  visit(scene, false);
  return out;
}

const countImages = (n: SceneNode): number => {
  let k = 0;
  walk(n, (x) => {
    if (x.tag === 'image') k++;
  });
  return k;
};

/**
 * Compile md clips without throwing: `{ clips, errors }`. With `scene` (a parsed / merged tree),
 * track targets, motion paths and tex targets are checked against it.
 */
export function compileClipsResult(md: string, scene?: SceneNode, opts: CompileClipsOptions = {}): CompileClipsResult {
  const errors: string[] = [];
  const clips: Record<string, AnimClip> = {};
  const ids = scene ? sceneInfo(scene) : null;

  let doc;
  try {
    doc = parseMd(md);
  } catch (e) {
    return { clips, errors: [coded('E_ANIM_SYNTAX', `cannot read the md clips: ${(e as Error).message}`)] };
  }

  // File-level $tex (an attribute before the first clip).
  const fileTex = texTemplate(attrText(doc.root, 'tex'), 'file', errors);

  for (const block of doc.root.children) {
    if (block.name !== 'clip') {
      errors.push(coded('E_ANIM_SYNTAX', `block $${block.name}${block.id ? ` ${block.id}` : ''} at the top level — expected # $clip <name>.`));
      continue;
    }
    const name = block.id;
    if (!name) {
      errors.push(coded('E_ANIM_SYNTAX', '# $clip without a name — write # $clip <name>.'));
      continue;
    }
    if (clips[name]) errors.push(coded('E_ANIM_TWICE', `$clip ${name}: the name occurs twice.`));
    const cw = `$clip ${name}`;
    for (const a of block.attrs) {
      const k = a.key.join('.');
      if (!CLIP_ATTRS.has(k)) errors.push(coded('E_ANIM_SYNTAX', `${cw}: unknown attribute $${k} (attributes: $duration, $loop, $tex).`));
    }
    const clipTex = texTemplate(attrText(block, 'tex'), cw, errors);
    const texNames = new Map<string, string>();
    for (const sub of block.children) {
      if (sub.name !== 'tex') continue;
      for (const [k, v] of texTable(sub, `${cw} / $tex`, errors)) {
        if (texNames.has(k)) errors.push(coded('E_ANIM_TEX', `${cw} / $tex: the name "${k}" twice.`));
        texNames.set(k, v);
      }
    }
    const clip: AnimClip = { tracks: [] };
    const durRaw = attrText(block, 'duration');
    let duration: number | undefined;
    if (durRaw !== undefined) {
      duration = Number(durRaw);
      if (!(duration > 0)) errors.push(coded('E_ANIM_VALUE', `${cw}: $duration="${durRaw}" — expected a positive number of seconds.`));
      else clip.duration = duration;
    }
    const loopRaw = attrText(block, 'loop');
    if (loopRaw !== undefined) {
      if (loopRaw !== 'true' && loopRaw !== 'false') errors.push(coded('E_ANIM_VALUE', `${cw}: $loop="${loopRaw}" — expected true or false.`));
      else if (loopRaw === 'true') clip.loop = true;
    }

    const seen = new Set<string>(); // target.property
    for (const sub of block.children) {
      if (sub.name === 'tex') continue;
      if (sub.name === 'events') {
        const tw = `${cw} / $events`;
        const table = parseTable(bodyText(sub), tw, errors);
        if (!table) continue;
        if (!table.columns.includes('t') || !table.columns.includes('event')) {
          errors.push(coded('E_ANIM_COLUMN', `${tw}: the table needs the columns t and event.`));
          continue;
        }
        const markers: Marker[] = clip.markers ?? [];
        for (const row of table.rows) {
          const t = Number(row.cells.t);
          if (row.cells.t === '' || !Number.isFinite(t) || t < 0) {
            errors.push(coded('E_ANIM_TIME', `${tw}, row ${row.line}: t="${row.cells.t}" — expected seconds ≥ 0.`));
            continue;
          }
          if (!row.cells.event) {
            errors.push(coded('E_ANIM_VALUE', `${tw}, row ${row.line}: an empty event name.`));
            continue;
          }
          if (duration !== undefined && t > duration + 1e-9) errors.push(coded('E_ANIM_TIME', `${tw}: an event at ${t} s — past $duration ${duration}.`));
          markers.push({ t, name: row.cells.event });
        }
        clip.markers = markers.sort((a, b) => a.t - b.t);
        continue;
      }
      if (sub.name !== 'track') {
        errors.push(coded('E_ANIM_SYNTAX', `${cw}: a clip has no block $${sub.name} (blocks: $track <id>, $events, $tex).`));
        continue;
      }
      const target = sub.id;
      if (!target) {
        errors.push(coded('E_ANIM_SYNTAX', `${cw}: ## $track without a target id.`));
        continue;
      }
      const tw = `${cw} / $track ${target}`;
      for (const a of sub.attrs) {
        const k = a.key.join('.');
        if (!TRACK_ATTRS.has(k)) errors.push(coded('E_ANIM_SYNTAX', `${tw}: unknown attribute $${k} (attributes: $path, $orient, $orient-offset, $offset, $tex).`));
      }
      const table = parseTable(bodyText(sub), tw, errors);
      if (!table) continue;
      const unknown = table.columns.filter((c) => !COLUMNS.has(c));
      if (unknown.length) errors.push(coded('E_ANIM_COLUMN', `${tw}: unknown column(s) ${unknown.join(', ')} (columns: ${[...COLUMNS].join(', ')}).`));
      if (!table.columns.includes('t')) {
        errors.push(coded('E_ANIM_COLUMN', `${tw}: no t column.`));
        continue;
      }
      const cols = new Set(table.columns);
      if (cols.has('scale') && (cols.has('scaleX') || cols.has('scaleY'))) {
        errors.push(coded('E_ANIM_COLUMN', `${tw}: scale and scaleX/scaleY in one table — choose one.`));
      }

      // Scene target checks ($param targets are bound at play time).
      const sceneTarget = ids && !target.startsWith('$') ? ids.get(target) : undefined;
      if (ids && !target.startsWith('$')) {
        if (!sceneTarget) errors.push(coded('E_ANIM_TARGET', `${tw}: the scene has no node #${target}.`));
        else if (sceneTarget.inDefs) errors.push(coded('E_ANIM_TARGET', `${tw}: #${target} is in <defs> — service geometry is not animated.`));
      }

      // Times: numbers, ascending.
      const times: number[] = [];
      let timesOk = true;
      table.rows.forEach((row, i) => {
        const t = Number(row.cells.t);
        if (row.cells.t === '' || !Number.isFinite(t) || t < 0) {
          errors.push(coded('E_ANIM_TIME', `${tw}, row ${row.line}: t="${row.cells.t}" — expected seconds ≥ 0.`));
          timesOk = false;
        } else if (i > 0 && t <= times[i - 1]) {
          errors.push(coded('E_ANIM_TIME', `${tw}, row ${row.line}: t=${t} — times must ascend.`));
          timesOk = false;
        } else if (duration !== undefined && t > duration + 1e-9) {
          errors.push(coded('E_ANIM_TIME', `${tw}, row ${row.line}: t=${t} is past $duration ${duration}.`));
        }
        times.push(t);
      });
      if (!timesOk) continue;

      // Eases: per row; validated once.
      const eases: (Ease | undefined)[] = table.rows.map((row) => {
        const raw = row.cells.ease ?? '';
        if (!raw) return undefined;
        const e = parseEase(raw);
        if (!e) {
          errors.push(coded('E_ANIM_EASE', `${tw}, row ${row.line}: unknown ease "${raw}" (eases: ${Object.keys(NAMED).join(', ')} or [x1,y1,x2,y2]).`));
          return undefined;
        }
        return e;
      });

      /**
       * Keys of one column: ease of a key moves to the next key of the same column (`only` — this ease
       * whatever the row says, e.g. step for z: an order is never in between).
       */
      const keysOf = (col: string, value: (raw: string, line: number) => number | string | null, only?: Ease): Keyframe[] => {
        const keys: Keyframe[] = [];
        let pending: Ease | undefined;
        table.rows.forEach((row, i) => {
          const raw = row.cells[col] ?? '';
          if (raw === '') return;
          const v = value(raw, row.line);
          if (v === null) return;
          const k: Keyframe = { t: times[i], v };
          if (pending !== undefined) k.ease = pending;
          keys.push(k);
          pending = only ?? eases[i];
        });
        return keys;
      };
      const numeric = (col: string, scale = 1) => (raw: string, line: number): number | null => {
        const v = Number(raw);
        if (!Number.isFinite(v)) {
          errors.push(coded('E_ANIM_VALUE', `${tw}, row ${line}: ${col}="${raw}" — not a number.`));
          return null;
        }
        return v * scale;
      };

      const push = (tr: Track): void => {
        const key = `${tr.target}.${tr.property}`;
        if (seen.has(key)) errors.push(coded('E_ANIM_TWICE', `${tw}: the property ${tr.property} of #${target} is keyed twice in one clip.`));
        seen.add(key);
        // Stable field order for a readable anim.json: what, how, then keys.
        const { keys, ...head } = tr;
        if (keys.length) clip.tracks.push({ ...head, keys });
      };

      const pathId = attrText(sub, 'path');
      const orient = attrText(sub, 'orient');
      const orientOffset = attrText(sub, 'orient-offset');
      const offset = attrText(sub, 'offset');
      const hasMotion = cols.has('motion');
      if (pathId !== undefined && !hasMotion) errors.push(coded('E_ANIM_MOTION', `${tw}: $path without a motion column — nothing drives the motion.`));
      if (hasMotion && pathId === undefined) errors.push(coded('E_ANIM_MOTION', `${tw}: a motion column without $path.`));
      const trackTexRaw = attrText(sub, 'tex');
      if (trackTexRaw !== undefined && !cols.has('tex')) errors.push(coded('E_ANIM_TEX', `${tw}: $tex without a tex column — nothing to swap.`));
      const trackTex = texTemplate(trackTexRaw, tw, errors);
      /** tex cell → href: --tex (override) → the track's template → the clip's table → clip → file template → as is. */
      const tex = (name: string): string =>
        opts.tex ? opts.tex(name) : trackTex ? trackTex(name) : texNames.get(name) ?? (clipTex ?? fileTex ?? ((n: string) => n))(name);
      if (!hasMotion && (orient !== undefined || orientOffset !== undefined || offset !== undefined)) {
        errors.push(coded('E_ANIM_MOTION', `${tw}: $orient/$orient-offset/$offset — only on a track with motion.`));
      }
      if (hasMotion && (cols.has('x') || cols.has('y'))) errors.push(coded('E_ANIM_MOTION', `${tw}: motion and x/y in one track — the path sets x and y itself.`));
      if (hasMotion && orient === 'auto' && cols.has('rotation')) {
        errors.push(coded('E_ANIM_MOTION', `${tw}: motion with $orient: auto and a rotation column — the path sets the rotation.`));
      }

      for (const col of table.columns) {
        switch (col) {
          case 't':
          case 'ease':
            break;
          case 'x':
          case 'y':
            push({ target, property: col, relative: true, keys: keysOf(col, numeric(col)) });
            break;
          case 'rotation':
            push({ target, property: 'rotation', relative: true, keys: keysOf(col, numeric(col, RAD)) });
            break;
          case 'scale': {
            const keys = keysOf(col, numeric(col));
            push({ target, property: 'scale.x', relative: true, keys });
            push({ target, property: 'scale.y', relative: true, keys: keys.map((k) => ({ ...k })) });
            break;
          }
          case 'scaleX':
          case 'scaleY':
            push({ target, property: col === 'scaleX' ? 'scale.x' : 'scale.y', relative: true, keys: keysOf(col, numeric(col)) });
            break;
          case 'skewX':
          case 'skewY':
            push({ target, property: col === 'skewX' ? 'skew.x' : 'skew.y', relative: true, keys: keysOf(col, numeric(col, RAD)) });
            break;
          case 'alpha':
            push({ target, property: 'alpha', keys: keysOf(col, numeric(col)) });
            break;
          case 'dash':
          case 'strokeWidth':
          case 'strokeAlpha': {
            const value = (raw: string, line: number): number | null => {
              const v = numeric(col)(raw, line);
              if (v === null) return null;
              if (col === 'strokeWidth' && v < 0) {
                errors.push(coded('E_ANIM_VALUE', `${tw}, row ${line}: strokeWidth="${raw}" — a width cannot be negative.`));
                return null;
              }
              if (col === 'strokeAlpha' && (v < 0 || v > 1)) {
                errors.push(coded('E_ANIM_VALUE', `${tw}, row ${line}: strokeAlpha="${raw}" — expected 0 to 1.`));
                return null;
              }
              return v;
            };
            if (sceneTarget && !sceneTarget.inDefs) {
              const n = sceneTarget.node;
              if (!GEOMETRY_TAGS.has(n.tag)) {
                errors.push(coded('E_ANIM_TARGET', `${tw}: ${col} — #${target} is <${n.tag}>; strokes animate on ${[...GEOMETRY_TAGS].join(', ')}.`));
              } else if (col === 'dash' && (n.attrs['stroke-dasharray'] == null || n.attrs['stroke-dasharray'].trim() === 'none')) {
                errors.push(coded('E_ANIM_TARGET', `${tw}: dash — #${target} has no stroke-dasharray, nothing to shift.`));
              }
            }
            push({ target, property: STROKE_COLUMNS[col], keys: keysOf(col, value) });
            break;
          }
          case 'width':
          case 'height': {
            if (sceneTarget && !sceneTarget.inDefs) {
              const n = sceneTarget.node;
              const axis = col === 'width' ? 'x' : 'y';
              if (n.instance) {
                if (!n.instance.resizable?.includes(axis)) {
                  errors.push(
                    coded('E_ANIM_TARGET', `${tw}: ${col} — ${n.instance.href} ${n.instance.resizable ? `resizes only along ${n.instance.resizable}` : 'is not resizable (no data-resizable)'}.`),
                  );
                }
              } else if (n.tag !== 'image' || n.attrs['data-slices'] == null) {
                errors.push(coded('E_ANIM_TARGET', `${tw}: ${col} — width/height animate only on data-slices (and instances of resizable prefabs), #${target} is <${n.tag}>${n.tag === 'image' ? ' without data-slices' : ''}.`));
              }
            }
            const size = (raw: string, line: number): number | null => {
              const v = numeric(col)(raw, line);
              if (v !== null && v < 0) {
                errors.push(coded('E_ANIM_VALUE', `${tw}, row ${line}: ${col}="${raw}" — a size cannot be negative.`));
                return null;
              }
              return v;
            };
            push({ target, property: col, keys: keysOf(col, size) });
            break;
          }
          case 'tint': {
            const color = (raw: string, line: number): number | null => {
              try {
                return parseTint(raw);
              } catch {
                errors.push(coded('E_ANIM_VALUE', `${tw}, row ${line}: tint="${raw}" — expected a colour #rrggbb.`));
                return null;
              }
            };
            push({ target, property: 'tint', keys: keysOf(col, color) });
            break;
          }
          case 'z': {
            const int = (raw: string, line: number): number | null => {
              const v = Number(raw);
              if (!Number.isInteger(v)) {
                errors.push(coded('E_ANIM_VALUE', `${tw}, row ${line}: z="${raw}" — expected an integer.`));
                return null;
              }
              return v;
            };
            push({ target, property: 'z', keys: keysOf(col, int, 'step') });
            break;
          }
          case 'view': {
            // name → href by the data-views of the target's image (the scene is required).
            let views: Map<string, string> | null = null;
            if (!ids) errors.push(coded('E_ANIM_TARGET', `${tw}: the view column takes variants from the scene's data-views; compile with the scene.`));
            else if (sceneTarget && !sceneTarget.inDefs) {
              const img = singleImage(sceneTarget.node);
              const raw = img?.attrs['data-views'];
              if (!img) errors.push(coded('E_ANIM_TARGET', `${tw}: view — #${target} has no single <image> (a picture can be swapped only when there is one).`));
              else if (raw == null) errors.push(coded('E_ANIM_TARGET', `${tw}: view — the picture #${target} has no data-views.`));
              else {
                try {
                  views = parseViews(raw);
                } catch (e) {
                  errors.push(within(tw, (e as Error).message));
                }
              }
            }
            const href = (raw: string, line: number): string | null => {
              if (!views) return raw;
              const h = views.get(raw);
              if (h === undefined) {
                errors.push(coded('E_ANIM_TARGET', `${tw}, row ${line}: view "${raw}" — not in the data-views of #${target} (views: ${[...views.keys()].join(', ')}).`));
                return null;
              }
              return h;
            };
            push({ target, property: 'href', keys: keysOf(col, href).map(({ t, v }) => ({ t, v })) });
            break;
          }
          case 'tex': {
            const keys = keysOf(col, (raw) => tex(raw)).map(({ t, v }) => ({ t, v }));
            if (sceneTarget && !sceneTarget.inDefs) {
              const n = sceneTarget.node;
              const images = n.tag === 'image' ? 1 : countImages(n);
              if (images !== 1) {
                errors.push(coded('E_ANIM_TARGET', `${tw}: tex — #${target} holds ${images} <image>; a picture can be swapped only when there is one.`));
              }
            }
            push({ target, property: 'href', keys });
            break;
          }
          case 'motion': {
            if (pathId === undefined) break;
            const tr: Track = { target, property: 'motion', path: pathId, keys: keysOf(col, numeric(col)) };
            if (orient !== undefined) {
              if (orient !== 'auto') errors.push(coded('E_ANIM_MOTION', `${tw}: $orient="${orient}" — only auto.`));
              else tr.orient = 'auto';
            }
            if (orientOffset !== undefined) {
              const d = Number(orientOffset);
              if (!Number.isFinite(d)) errors.push(coded('E_ANIM_MOTION', `${tw}: $orient-offset="${orientOffset}" — expected degrees as a number.`));
              else if (d !== 0) tr.orientOffset = d * RAD;
            }
            if (offset !== undefined) {
              const parts = offset.split(/[\s,]+/).filter(Boolean).map(Number);
              if (parts.length !== 2 || !parts.every(Number.isFinite)) errors.push(coded('E_ANIM_MOTION', `${tw}: $offset="${offset}" — expected "dx, dy".`));
              else tr.offset = [parts[0], parts[1]];
            }
            if (ids) {
              const p = ids.get(pathId);
              if (!p) errors.push(coded('E_ANIM_MOTION', `${tw}: $path ${pathId} — the scene has no such node.`));
              else if (!GEOMETRY_TAGS.has(p.node.tag)) {
                errors.push(coded('E_ANIM_MOTION', `${tw}: $path ${pathId} — this is <${p.node.tag}>; a path is one of ${[...GEOMETRY_TAGS].join(', ')}.`));
              }
            }
            push(tr);
            break;
          }
        }
      }
    }
    clips[name] = clip;
  }
  return { clips, errors };
}

/**
 * Compile md clips into anim.json clips. @throws TrempelError listing every problem (syntax,
 * columns, times, eases; with `scene` — missing targets and paths).
 */
export function compileClips(md: string, scene?: SceneNode, opts?: CompileClipsOptions): Record<string, AnimClip> {
  const { clips, errors } = compileClipsResult(md, scene, opts);
  if (errors.length) throw new TrempelError(errors);
  return clips;
}
