// clips.ts — clips of a scene for the viewer and the editor (browser half, Pixi-free):
//
//   - compileSceneClips: every clip file of the scene (anim/*.md, *.anim.md) compiled against the
//     mounted tree — errors as a list with the file. Playback is always from the md clip: the `tex`
//     mapping is written there ($tex, v0.9.1); a compiled .json next to it is the game's and is ignored;
//   - ClipPlayer: one clip at a time over the scene with its OWN clock — time moves only when the
//     host advances it (`advance(ms)` from a frame loop, ×speed) or seeks, so pause and scrub are
//     exact. A seek replays from 0 to t in one step (the Animator remembers the rest pose, so this
//     does not drift); `poseAt(t)` is the same without changing the player's time.
//
// Stop (back to the rest pose) is the host's business: it reopens the scene.
//
// 2.2: `onTime` — after every seek and played frame the host hears the clip time and the clip's
// markers ($events) already crossed in this cycle, with their times: what lives in time next to the
// clip (a particle effect fired by `fx:<name>@<node>`) catches up to the frame (the module's
// onClipTime).

import { sharedClipHint } from '../src/anim/clip-files.js';
import { Animator, compileClipsResult, within, type AnimClip, type Handle, type Marker, type MountedScene, type RendererBackend, type SceneNode } from '../src/core.js';

export interface SceneClip {
  name: string;
  /** The md clip file the clip is written in (relative to the folder). */
  file: string;
  clip: AnimClip;
  /** Seconds (clip.duration, else the last key / marker). */
  duration: number;
}

export interface CompiledClips {
  clips: SceneClip[];
  /** Compile errors, each prefixed with its file. */
  errors: string[];
}

/** Clip length the way the Animator sees it. */
export function clipDuration(clip: AnimClip): number {
  if (clip.duration != null && clip.duration > 0) return clip.duration;
  let d = 0;
  for (const tr of clip.tracks) d = Math.max(d, tr.keys.at(-1)?.t ?? 0);
  for (const m of clip.markers ?? []) d = Math.max(d, m.t);
  return d;
}

/**
 * Compile the scene's clip files. `md` — file → md clip text; `tree` — the mounted (merged) tree
 * targets are checked against. 2.3.1: `sceneId` — a target error of a shared clip file (not named
 * after the scene) tells how to bind the file.
 */
export function compileSceneClips(md: Record<string, string>, tree: SceneNode | null, sceneId?: string): CompiledClips {
  const clips: SceneClip[] = [];
  const errors: string[] = [];
  for (const [file, text] of Object.entries(md)) {
    const r = compileClipsResult(text, tree ?? undefined);
    errors.push(...r.errors.map((e) => (sceneId ? sharedClipHint(file, sceneId, within(file, e)) : within(file, e))));
    for (const [name, clip] of Object.entries(r.clips)) clips.push({ name, file, clip, duration: clipDuration(clip) });
  }
  return { clips, errors };
}

/** A manual clock: time is what the player says it is. */
class ManualClock {
  ms = 0;
  now(): number {
    return this.ms;
  }
}

/** 2.2: what the player reports after a seek / a played frame. */
export interface ClipTime {
  clip: string;
  /** Seconds into the clip as shown. */
  t: number;
  /** Markers at or before `t` in this cycle, by time. */
  markers: Marker[];
}

export interface ClipPlayerOptions {
  /** 2.2: called after every seek and played frame. */
  onTime?: (time: ClipTime) => void;
}

export class ClipPlayer {
  private readonly clock = new ManualClock();
  private readonly animator: Animator;
  private handle: Handle | null = null;
  private clip: SceneClip | null = null;
  /** Seconds since the clip started (unwrapped). */
  private elapsed = 0;
  playing = false;
  loop = true;
  speed = 1;
  /** 2.3: values of the clip's parameters ($name cells) for the preview (the editor's fields). */
  params: Record<string, number> = {};

  constructor(
    scene: MountedScene,
    backend: RendererBackend,
    private readonly opts: ClipPlayerOptions = {},
  ) {
    this.animator = new Animator(backend, this.clock, (id) => scene.byId.get(id), { path: (id) => scene.path(id) });
  }

  get current(): SceneClip | null {
    return this.clip;
  }

  /** Seconds into the clip as shown (wrapped when looping, clamped at the end otherwise). */
  get time(): number {
    const d = this.clip?.duration ?? 0;
    if (d <= 0) return 0;
    return this.loop ? this.elapsed % d : Math.min(this.elapsed, d);
  }

  /** Choose a clip and show its frame 0 (paused). @throws when the clip cannot start (path, rest pose). */
  select(clip: SceneClip): void {
    this.clip = clip;
    this.playing = false;
    this.seek(0);
  }

  play(): void {
    if (!this.clip) return;
    const d = this.clip.duration;
    if (!this.loop && this.elapsed >= d) this.seek(0);
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** Show time t (seconds; clamped to the clip). */
  seek(t: number): void {
    if (!this.clip) return;
    const d = this.clip.duration;
    const at = Math.max(0, d > 0 ? Math.min(t, d) : 0);
    this.handle?.abort();
    // The panel's loop switch decides (not the clip's $loop): off — the end holds the last frame.
    const clip: AnimClip = { ...this.clip.clip, loop: this.loop && d > 0 };
    this.handle = this.animator.play(clip, { params: this.params });
    this.elapsed = at;
    if (at > 0) {
      // A seek to the very end of a looping clip shows its last frame, not frame 0 of the next cycle.
      const step = clip.loop && at >= d ? d - 1e-6 : at;
      this.clock.ms += step * 1000;
      this.animator.tick();
    }
    this.report();
  }

  /** Tell the host the time shown and the markers crossed (2.2). */
  private report(): void {
    if (!this.clip || !this.opts.onTime) return;
    const t = this.time;
    const markers = (this.clip.clip.markers ?? []).filter((m) => m.t <= t + 1e-9);
    this.opts.onTime({ clip: this.clip.name, t, markers });
  }

  /** Move time by `ms` of wall time (×speed) — call once per frame while playing. */
  advance(ms: number): void {
    if (!this.clip || !this.playing || ms <= 0) return;
    const d = this.clip.duration;
    const dt = (ms / 1000) * this.speed;
    if (!this.loop && this.elapsed + dt >= d) {
      this.seek(d);
      this.playing = false;
      return;
    }
    this.elapsed += dt;
    this.clock.ms += dt * 1000;
    this.animator.tick();
    this.report();
  }

  /** Stop the playback (the nodes keep the last pose — the host reopens the scene for the rest pose). */
  stop(): void {
    this.handle?.abort();
    this.handle = null;
    this.playing = false;
    this.elapsed = 0;
  }
}
