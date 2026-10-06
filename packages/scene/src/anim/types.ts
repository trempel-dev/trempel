// types.ts — animation clip schema (anim.json), see spec §anim.json.
// v0.7: anim.json is the compiled form of md clips (anim/compile.ts) — relative tracks, motion
// along a path, string keys (href), clip duration/loop. v0.5 files mean exactly what they meant.

/** Named easing curves. v0.7 adds the clip-table names (in, out, inOut, outBack, inBack, outBounce, step). */
export type EaseName =
  | 'linear'
  | 'quadIn'
  | 'quadOut'
  | 'quadInOut'
  | 'cubicInOut'
  | 'backOut'
  | 'elasticOut'
  | 'in'
  | 'out'
  | 'inOut'
  | 'outBack'
  | 'inBack'
  | 'outBounce'
  | 'step';

/** Easing: a named curve or a raw cubic-bezier [x1, y1, x2, y2]. */
export type Ease = EaseName | [number, number, number, number];

export interface Keyframe {
  /** Time in seconds. */
  t: number;
  /** Value at this key. A string (v0.7, e.g. an href) is held until the next key — no interpolation. */
  v: number | string;
  /** Easing applied to the SEGMENT ending at this key (from the previous key to this one). */
  ease?: Ease;
  /**
   * 2.0: a clip parameter (`$name` in an md cell) — the key's value is `params[param] × v` given at
   * play time (`play(clip, { params })`); `v` is then the column's unit (1, or π/180 for degrees).
   */
  param?: string;
}

export interface Track {
  /** Scene node id, or `$<param>` for late binding (resolved at play time). */
  target: string;
  /**
   * Property path: 'scale.y', 'x', 'y', 'alpha', 'rotation' (radians), 'tint', 'href'; v0.7:
   * 'motion' — keys are fractions 0..1 of `path`'s length; v0.8: 'z', 'skew.x' / 'skew.y'; v0.9.1:
   * 'stroke-dashoffset', 'stroke-width', 'stroke-opacity' (geometry, absolute). Dots = nesting.
   */
  property: string;
  keys: Keyframe[];
  /**
   * v0.7: values are relative to the node's rest pose — x / y / rotation are added to it, scale.x /
   * scale.y multiply it. Absent ⇒ absolute (v0.5).
   */
  relative?: boolean;
  /** v0.7, motion: id of the geometry node to move along (path, line, circle, ellipse, rect). */
  path?: string;
  /** v0.7, motion: 'auto' — rotation follows the path's tangent; absent — rotation untouched. */
  orient?: 'auto';
  /** v0.7, motion with orient: added to the tangent angle, radians. */
  orientOffset?: number;
  /** v0.7, motion: [dx, dy] shift from the path point — in the node's rotated axes when orient is auto. */
  offset?: [number, number];
}

export interface Marker {
  /** Time in seconds at which the player emits `name`. */
  t: number;
  name: string;
}

export interface AnimClip {
  tracks: Track[];
  markers?: Marker[];
  /** v0.7: clip length in seconds (default — the last key or marker). */
  duration?: number;
  /** v0.7: repeat until aborted (`done` resolves on abort); markers fire every cycle. */
  loop?: boolean;
}
