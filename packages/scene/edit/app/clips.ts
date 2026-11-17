// clips.ts — clips in the editor (batch 2): the scene's clips compiled after each render, one of them
// played on the drawn scene by the runtime's Animator with the player's own clock (view/clips.ts —
// pause and scrub are exact), the onion skin, and `tml.anim` underneath.
//
// While a clip poses the scene the stage is read-only (handles, hit-test and stage keys are off —
// the header says why); ⏹ reopens the scene, which is the rest pose. A command (from the tree, the
// inspector, a script) reopens the scene too — the clip is then dropped the same way.
//
// Onion: paused, `t − Δ` and `t + Δ` are posed, captured (the renderer, scene layer only) into
// textures and drawn semi-transparent over the scene, tinted (before — red, after — green); the
// pose at `t` is restored. Display only.

import { Rectangle, Sprite, type Texture } from 'pixi.js';
import { coded, codeOf, within, type MountedScene } from '../../src/core.js';
import { ClipPlayer, compileSceneClips, type SceneClip } from '../../view/clips';
import type { Editor } from './editor';

export type ClipsEvent = 'list' | 'state' | 'tick';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Clips {
  list: SceneClip[] = [];
  /** Compile errors, each prefixed with its file (the issues panel shows them as `clips`). */
  errors: string[] = [];
  /** The clip in the panel (null — none chosen). */
  selected: string | null = null;
  /** A clip poses the scene (the stage is read-only until stop()). */
  active = false;
  loop = true;
  speed = 1;
  onion = { on: false, delta: 1 / 12 };
  /** Onion layers drawn now (0 or 2) — for tests. */
  onionLayers = 0;
  /**
   * 2.3: recording — while a clip poses the scene the stage stays editable, and an edit of a node
   * becomes keys of the clip at the playhead (rec.ts), not a change of the base.
   */
  rec = false;
  /** 2.3: values of the clip parameters for the preview (play(clip, { params })); a missing one is 0. */
  params: Record<string, number> = {};

  private player: ClipPlayer | null = null;
  private scene: MountedScene | null = null;
  private raf = 0;
  private last = 0;
  private onionSprites: Sprite[] = [];
  private listeners = new Map<ClipsEvent, Set<() => void>>();

  constructor(private readonly ed: Editor) {
    ed.on('render', () => this.refresh());
  }

  on(e: ClipsEvent, fn: () => void): () => void {
    let set = this.listeners.get(e);
    if (!set) this.listeners.set(e, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(...events: ClipsEvent[]): void {
    for (const e of events) for (const fn of this.listeners.get(e) ?? []) fn();
  }

  get playing(): boolean {
    return !!this.player?.playing;
  }

  /** Seconds into the selected clip. */
  get time(): number {
    return this.player?.time ?? 0;
  }

  get current(): SceneClip | null {
    return this.list.find((c) => c.name === this.selected) ?? null;
  }

  /** After a render: recompile, and drop a pose the new scene no longer has. */
  private refresh(): void {
    const scene = this.ed.session?.scene ?? null;
    const compiled = compileSceneClips(this.ed.clipSources.md, this.ed.session?.tree ?? null, this.ed.entry?.id);
    this.list = compiled.clips;
    this.errors = compiled.errors;
    if (this.selected && !this.current) this.selected = null;
    let resume: { name: string; t: number; playing: boolean } | null = null;
    if (scene !== this.scene) {
      // the scene was rebuilt: it is in the rest pose again
      if (this.active && this.selected && this.current && scene) resume = { name: this.selected, t: this.time, playing: this.playing };
      this.halt();
      this.scene = scene;
      this.player = null;
      if (this.active) {
        this.active = false;
        this.ed.setReadOnly(null);
      }
    }
    this.emit('list', 'state');
    // 2.3: an edit of the clip (the timeline) or of the scene while posed: the pose comes back at the same time
    if (resume) {
      try {
        this.select(resume.name);
        this.seek(resume.t);
        if (resume.playing) this.play();
      } catch (e) {
        this.ed.log('error', msg(e));
      }
    }
  }

  private ensurePlayer(): ClipPlayer {
    const session = this.ed.session;
    if (!session?.scene || !session.animBackend) throw new Error(coded('E_EDIT_NO_SCENE', 'the scene is not drawn — nothing to play the clip on'));
    if (!this.player || this.scene !== session.scene) {
      this.scene = session.scene;
      const scene = session.scene;
      const onClipTime = this.ed.runtime.config.onClipTime;
      // 2.2: the module's onClipTime — effects fired by markers catch up to the frame shown
      this.player = new ClipPlayer(scene, session.animBackend, {
        onTime: onClipTime
          ? (time) => {
              try {
                onClipTime({ id: this.ed.entry?.id ?? '', scene, ...time });
              } catch (e) {
                this.ed.log('error', coded('E_VIEW_MODULE', `view module onClipTime(): ${msg(e)}`));
              }
            }
          : undefined,
      });
    }
    this.player.loop = this.loop;
    this.player.speed = this.speed;
    this.player.params = this.paramValues();
    return this.player;
  }

  /** Choose a clip: its frame 0 is shown (paused), the stage goes read-only. */
  select(name: string | null): void {
    if (name === this.selected && this.active) return;
    if (name == null) {
      void this.stop();
      this.selected = null;
      this.emit('state');
      return;
    }
    const clip = this.list.find((c) => c.name === name);
    if (!clip) throw new Error(coded('E_EDIT_CLIP', `no clip "${name}" (clips: ${this.list.map((c) => c.name).join(', ') || '—'})`));
    this.selected = name;
    const p = this.ensurePlayer();
    try {
      p.select(clip);
    } catch (e) {
      this.ed.log('error', within(`clip ${name}`, codeOf(msg(e)) ? msg(e) : coded('E_ANIM_PLAY', msg(e))));
      this.emit('state');
      return;
    }
    this.pose();
    this.drawOnion();
    this.remeasure();
    this.emit('state', 'tick');
  }

  /** Recording: the handles follow the posed nodes (the gizmo works on the pose). */
  private remeasure(): void {
    if (!this.rec || !this.active) return;
    this.ed.measure();
    this.ed.emit('selection');
  }

  play(name?: string): void {
    if (name != null && name !== this.selected) this.select(name);
    if (!this.selected) {
      const first = this.list[0];
      if (!first) throw new Error(coded('E_EDIT_CLIP', 'the scene has no clips (anim/*.md, *.anim.md next to it)'));
      this.select(first.name);
    }
    const p = this.ensurePlayer();
    if (!p.current) p.select(this.current!);
    this.pose();
    this.clearOnion();
    p.play();
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const frame = (now: number): void => {
      const pl = this.player;
      if (!pl?.playing) return;
      pl.advance(now - this.last);
      this.last = now;
      this.emit('tick');
      if (pl.playing) this.raf = requestAnimationFrame(frame);
      else {
        this.drawOnion();
        this.emit('state');
      }
    };
    this.raf = requestAnimationFrame(frame);
    this.emit('state');
  }

  pause(): void {
    this.halt();
    this.drawOnion();
    this.emit('state', 'tick');
  }

  /** Show time t of the selected clip (paused). */
  seek(t: number): void {
    if (!this.selected) throw new Error(coded('E_EDIT_CLIP', 'no clip selected — tml.anim.play(name) or pick one in the Clips panel'));
    const p = this.ensurePlayer();
    if (!p.current) p.select(this.current!);
    this.halt();
    p.seek(t);
    this.pose();
    this.drawOnion();
    this.remeasure();
    this.emit('state', 'tick');
  }

  /** Back to the rest pose: the scene is reopened; the stage is editable again. */
  async stop(): Promise<void> {
    this.halt();
    this.clearOnion();
    this.player?.stop();
    const was = this.active;
    this.active = false;
    this.ed.setReadOnly(null);
    this.emit('state', 'tick');
    if (was) await this.ed.render();
  }

  setLoop(on: boolean): void {
    this.loop = on;
    if (this.player) this.player.loop = on;
    this.emit('state');
  }

  setSpeed(k: number): void {
    this.speed = Math.max(0.25, Math.min(2, k));
    if (this.player) this.player.speed = this.speed;
    this.emit('state');
  }

  /** Parameter names of the selected clip ($name cells). */
  paramNames(): string[] {
    const out = new Set<string>();
    for (const tr of this.current?.clip.tracks ?? []) for (const k of tr.keys) if (k.param) out.add(k.param);
    return [...out];
  }

  private paramValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.paramNames()) out[n] = this.params[n] ?? 0;
    return out;
  }

  /** 2.3: a parameter's preview value — the pose at the playhead is redrawn. */
  setParam(name: string, value: number): void {
    this.params[name] = value;
    if (this.player) this.player.params = this.paramValues();
    if (this.active && this.selected && !this.playing) this.seek(this.time);
    this.emit('state');
  }

  /** 2.3: recording on / off (the stage is editable while a clip poses it when on). */
  setRec(on: boolean): void {
    this.rec = on;
    if (this.active) this.ed.setReadOnly(on ? null : `▶ ${this.selected} · view only (⏹ — rest pose, ● Rec — record keys)`);
    this.emit('state');
  }

  setOnion(on: boolean, delta = this.onion.delta): void {
    this.onion = { on, delta: delta > 0 ? delta : 1 / 12 };
    this.drawOnion();
    this.emit('state');
  }

  private pose(): void {
    if (this.active) return;
    this.active = true;
    if (!this.rec) this.ed.setReadOnly(`▶ ${this.selected} · view only (⏹ — rest pose, ● Rec — record keys)`);
  }

  private halt(): void {
    cancelAnimationFrame(this.raf);
    this.player?.pause();
  }

  private clearOnion(): void {
    for (const s of this.onionSprites) {
      s.destroy({ texture: true, textureSource: true });
    }
    this.onionSprites = [];
    this.onionLayers = 0;
  }

  /** Paused with onion on: the neighbour frames as two tinted, semi-transparent layers over the scene. */
  private drawOnion(): void {
    this.clearOnion();
    const p = this.player;
    const clip = this.current;
    if (!this.onion.on || !p || !clip || !this.active || p.playing) return;
    const t = p.time;
    const d = clip.duration;
    const at = (dt: number): number => (this.loop && d > 0 ? (((t + dt) % d) + d) % d : Math.max(0, Math.min(d, t + dt)));
    const shots: [number, number][] = [
      [at(-this.onion.delta), 0xff5a5a],
      [at(this.onion.delta), 0x5aff8c],
    ];
    const ed = this.ed;
    try {
      for (const [time, tint] of shots) {
        p.seek(time);
        const tex = this.capture();
        const s = new Sprite(tex);
        // the capture is in canvas px; `over` is in scene units
        s.scale.set(1 / ed.world.scale.x, 1 / ed.world.scale.y);
        s.position.set(-ed.world.position.x / ed.world.scale.x, -ed.world.position.y / ed.world.scale.y);
        s.alpha = 0.4;
        s.tint = tint;
        s.label = 'onion';
        ed.over.addChildAt(s, 0);
        this.onionSprites.push(s);
      }
    } catch (e) {
      ed.log('error', `onion: ${msg(e)}`);
    } finally {
      p.seek(t);
    }
    this.onionLayers = this.onionSprites.length;
  }

  /** The scene layer alone (no background, reference or onion) as a texture of the canvas. */
  private capture(): Texture {
    const ed = this.ed;
    const hidden = ed.holder.children.filter((c) => c !== ed.world && c.visible);
    for (const c of hidden) c.visible = false;
    try {
      return ed.app.renderer.generateTexture({ target: ed.holder, frame: new Rectangle(0, 0, ed.fit.width, ed.fit.height) });
    } finally {
      for (const c of hidden) c.visible = true;
    }
  }
}
