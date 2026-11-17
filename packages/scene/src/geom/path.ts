// path.ts — a geometry node as a measurable path: length, point and tangent at a distance.
//
// One implementation for the runtime (motion tracks, MountedScene.path, ComponentContext.path) and
// for Pixi-free tools (CLI, editor, exporters): `pathFromNode`. Lengths come from
// svg-path-properties (ISC, zero-dep); the length table is built once per node and cached.
//
// Coordinates: the node's own geometry with its own `transform` applied — i.e. the space of the
// node's parent (for a path in <defs>: the root). A transform must keep shapes similar (translate,
// rotate, uniform scale, mirror): distances along a skewed or stretched path are not the
// path's lengths scaled, so such a transform is a hard error.
//
// The tangent is the direction between two nearby points ON THE LENGTH (outgoing, backward at the
// open end), not the library's getTangentAtLength: that one is reversed on arcs (svg-path-properties
// 2.1.0 — a clockwise arc reports the counter-clockwise direction) and zero where control points
// coincide with an end point.
//
// @internal — `@trempel/scene/internal/geom/path`, for the kit and the editor: no stability promise.
// Stable (re-exported by @trempel/scene): ScenePath, PathPoint.

import { svgPathProperties } from 'svg-path-properties';
import type { SceneNode } from '../parser.js';
import { within } from '../codes.js';
import { TrempelError, trempelError } from '../errors.js';
import { parseTransform, type Matrix } from '../transform.js';
import { GEOMETRY_TAGS, shapeCommands, toPathData } from './pathdata.js';

export interface PathPoint {
  x: number;
  y: number;
}

/** A measurable path; `s` is a distance along it in scene units. */
export interface ScenePath {
  /** Total length in scene units (0 for an empty shape). */
  readonly length: number;
  /** True when the outline ends with Z (circle/ellipse/rect always). */
  readonly closed: boolean;
  /** The point at distance `s`: clamped to [0, length] on an open path, wrapped on a closed one. */
  pointAt(s: number): PathPoint;
  /** Unit tangent (direction of travel) at distance `s`, same clamping/wrapping as pointAt. */
  tangentAt(s: number): PathPoint;
}

const cache = new WeakMap<SceneNode, ScenePath>();

const where = (node: SceneNode): string => (node.attrs.id ? `#${node.attrs.id}` : `<${node.tag}>`);

/**
 * A ScenePath over a geometry node (path, line, circle, ellipse, rect). Cached per node.
 * @throws Error (human wording, with the node's id) for a non-geometry node, bad data, or a
 * transform that is not a similarity.
 */
export function pathFromNode(node: SceneNode): ScenePath {
  const hit = cache.get(node);
  if (hit) return hit;
  if (!GEOMETRY_TAGS.has(node.tag)) {
    throw trempelError('E_GEOMETRY', `${where(node)} — <${node.tag}> is not geometry: a path is one of ${[...GEOMETRY_TAGS].join(', ')}.`);
  }
  let cmds;
  try {
    cmds = shapeCommands(node.tag, node.attrs);
  } catch (e) {
    throw new TrempelError([within(where(node), (e as Error).message)]);
  }
  let m: Matrix;
  try {
    m = parseTransform(node.attrs.transform);
  } catch (e) {
    throw new TrempelError([within(where(node), (e as Error).message)]);
  }
  const [a, b, c, d, e, f] = m;
  // Similarity: columns orthogonal and of equal length (rotation/uniform scale, optionally mirrored).
  const k = Math.hypot(a, b);
  if (Math.abs(Math.hypot(c, d) - k) > 1e-9 * Math.max(1, k) || Math.abs(a * c + b * d) > 1e-9 * Math.max(1, k * k) || k === 0) {
    throw trempelError('E_PATH_SIMILARITY', `${where(node)}: transform="${node.attrs.transform}" stretches or skews the path — lengths along it are undefined; translate, rotate and uniform scale are allowed.`);
  }

  const closed = cmds.length > 0 && cmds[cmds.length - 1][0] === 'Z';
  const props = cmds.length > 1 ? new svgPathProperties(toPathData(cmds)) : null;
  const local = props ? props.getTotalLength() : 0;
  const length = local * k;
  const start = cmds.length ? { x: cmds[0][1] as number, y: cmds[0][2] as number } : { x: 0, y: 0 };

  const at = (s: number): number => {
    if (!(length > 0) || !Number.isFinite(s)) return 0;
    if (closed) {
      const r = s % length;
      return (r < 0 ? r + length : r) / k;
    }
    return Math.min(Math.max(s, 0), length) / k;
  };

  /** Local unit tangent at local distance `sl` from two points `h` apart along the length. */
  const h = Math.max(local * 1e-4, 1e-3);
  const localTangent = (sl: number): PathPoint => {
    if (!props || !(local > h)) return { x: 1, y: 0 };
    let a = sl;
    let b = sl + h;
    if (b > local) {
      if (closed) b -= local;
      else {
        a = local - h;
        b = local;
      }
    }
    const p = props.getPointAtLength(a);
    const q = props.getPointAtLength(b);
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    return len > 0 ? { x: (q.x - p.x) / len, y: (q.y - p.y) / len } : { x: 1, y: 0 };
  };

  const path: ScenePath = {
    length,
    closed,
    pointAt(s) {
      const p = props ? props.getPointAtLength(at(s)) : start;
      return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
    },
    tangentAt(s) {
      const t = localTangent(at(s));
      const x = a * t.x + c * t.y;
      const y = b * t.x + d * t.y;
      const len = Math.hypot(x, y);
      return len > 0 ? { x: x / len, y: y / len } : { x: 1, y: 0 };
    },
  };
  cache.set(node, path);
  return path;
}
