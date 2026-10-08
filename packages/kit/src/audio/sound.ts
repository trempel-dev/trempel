// sound.ts — the kit's sound: a thin wrapper over zvuk (taken as is: buses, voice limits, music,
// unlock).
//
// Buses: `sfx` and `music`, levels = the game's settings (0..1, saved by the game); the platform
// audio switch (Playables isAudioEnabled) mutes the master on top; platform pause suspends the
// AudioContext (zvuk's own Page Visibility pause is OFF — Playables forbids that API).
// Sounds load after the first user gesture (autoplay policy; not part of the initial bundle).
// A sound is a URL (or codec ladder ['x.webm','x.m4a']) or a procedural SynthSpec/preset name —
// placeholders without audio files. 2.1: or an entry { src, volume, pitch } — the level and the tone
// of the sound in the table (play() options multiply them).
//
// 2.1, no lag on the first gesture: the AudioContext is made at boot (warm(): the browser's audio
// start — ~150 ms the first time — happens under the loading screen, the context waits suspended);
// the gesture only resumes it. Synthesizing the presets and starting the loads run after that frame,
// one preset per task; a synth sound played before its turn is synthesized right then.
//
// 2.1, quiet clicks: click(name) — a button's sound, played after the current event unless that
// event opened or closed a popup (the popup's own sound plays instead); `quietClicks: false` — always.

import { createEngine, type Engine } from '@schmooky/zvuk';
import { renderSynth, SYNTH_PRESETS, type SynthPreset, type SynthSpec } from './synth.js';

/** A sound of the table: URL(s), a synth spec or preset — or (2.1) an entry with its own level and tone. */
export type SoundSource = string | readonly string[] | SynthSpec | { synth: SynthPreset } | SoundEntry;

/** 2.1: a sound with its volume (0..1) and pitch (playback rate) in the table. */
export interface SoundEntry {
  src: string | readonly string[] | SynthSpec | { synth: SynthPreset };
  volume?: number;
  pitch?: number;
}

export interface SoundOptions {
  /** One-shot effects by name. */
  sounds?: Record<string, SoundSource>;
  /** Music tracks by name (looped on the music bus). */
  music?: Record<string, string | readonly string[]>;
  /** Href → URL (bundler table). */
  resolve?: (href: string) => string;
  /** Max simultaneous sfx voices. */
  maxVoices?: number;
  /** 2.1: click() is silent when the same event opened / closed a popup (default true). */
  quietClicks?: boolean;
  /** 2.1: runs `fn` after the current frame (default: requestAnimationFrame, then a task). */
  later?: (fn: () => void) => void;
}

type Raw = Exclude<SoundSource, SoundEntry>;
const isEntry = (s: SoundSource): s is SoundEntry => typeof s === 'object' && !Array.isArray(s) && 'src' in s;
const isUrl = (s: Raw): s is string | readonly string[] => typeof s === 'string' || Array.isArray(s);

const hasAudio = () => typeof AudioContext !== 'undefined' || typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined';

/** After this frame: the next animation frame, then a task (so the frame paints first). */
function afterFrame(fn: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (f: () => void) => number }).requestAnimationFrame;
  if (raf) raf(() => setTimeout(fn, 0));
  else setTimeout(fn, 0);
}

export class Sound {
  private engine: Engine<'sfx' | 'music'> | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  /** A gesture unlocked the audio (before it, warm()'s suspended context plays nothing). */
  private unlocked = false;
  private platformOn = true;
  private paused = false;
  private sfx = 1;
  private mus = 1;
  private wantedMusic: string | null = null;
  private musicVoice: { stop(): unknown } | null = null;
  private readonly known: Set<string>;
  private readonly levels = new Map<string, { volume: number; pitch: number }>();
  /** Popups opened / closed so far (click() compares it across the event). */
  private popupMarks = 0;
  /** Names played so far (tests, QA probe). */
  readonly log: string[] = [];
  private destroyed = false;

  constructor(private readonly opts: SoundOptions = {}) {
    this.known = new Set([...Object.keys(opts.sounds ?? {}), ...Object.keys(SYNTH_PRESETS)]);
    for (const [name, s] of Object.entries(opts.sounds ?? {})) if (isEntry(s)) this.levels.set(name, { volume: s.volume ?? 1, pitch: s.pitch ?? 1 });
  }

  /** Audio is live (unlocked and every sound loaded). */
  get ready(): boolean {
    return !!this.engine && this.loaded;
  }

  /** 2.1: the table's volume and pitch of a sound (1 / 1 when it has none). */
  level(name: string): { volume: number; pitch: number } {
    return this.levels.get(name) ?? { volume: 1, pitch: 1 };
  }

  /**
   * 2.1: make the AudioContext now (suspended — no gesture needed): the browser's audio start is
   * paid here (createGame calls it after boot), not on the first tap. Idempotent.
   */
  warm(): void {
    if (this.destroyed || !hasAudio()) return;
    try {
      void this.ensureEngine().context;
    } catch {
      // No audio device: the gesture tries again.
    }
  }

  /**
   * Call from a user gesture (the kit wires every pointerdown/keydown). Idempotent. 2.1: only resumes
   * the context in the gesture; synthesis and loading start after the frame.
   */
  unlock(): void {
    if (this.destroyed || !hasAudio()) return;
    const e = this.ensureEngine();
    this.unlocked = true;
    if (!this.loading && !this.loaded) {
      const later = this.opts.later ?? afterFrame;
      this.loading = new Promise<void>((done) => later(() => void this.load().finally(done)))
        .then(() => {
          this.loaded = true;
          if (this.wantedMusic && !this.destroyed) this.playMusic(this.wantedMusic);
        })
        .finally(() => (this.loading = null));
    }
    if (!this.paused) void e.unlock().catch(() => {});
  }

  /**
   * Play a one-shot by name (or a synth preset name). Silently nothing before unlock. 2.1: `volume`
   * and `pitch` multiply the table's; a sound plays as soon as it is in (not after all of them).
   */
  play(name: string, opts: { volume?: number; pitch?: number } = {}): void {
    if (!this.known.has(name)) throw new Error(`sound "${name}" is not declared (known: ${[...this.known].join(', ')})`);
    this.log.push(name);
    const e = this.engine;
    if (!e || !this.unlocked || this.paused) return;
    if (!e.hasSound(name)) {
      // A synth sound before its turn in the load: synthesized right now (one short buffer).
      const spec = this.synthSpec(name);
      if (spec) this.synth(name, spec);
      else return;
    }
    const l = this.level(name);
    e.sound(name).play({ volume: (opts.volume ?? 1) * l.volume, pitch: (opts.pitch ?? 1) * l.pitch, bus: 'sfx' });
  }

  /**
   * 2.1: a button's click sound — after the current event, and only when no popup opened or closed
   * from `since` (default: now — call it before the action that may open one; the kit's `data-sound`
   * passes the mark of the pointerdown) to the end of the event. `quietClicks: false` — it plays at once.
   */
  click(name: string, opts: { volume?: number; pitch?: number } = {}, since = this.popupMarks): void {
    if (this.opts.quietClicks === false) return this.play(name, opts);
    if (!this.known.has(name)) throw new Error(`sound "${name}" is not declared (known: ${[...this.known].join(', ')})`);
    queueMicrotask(() => {
      if (!this.destroyed && this.popupMarks === since) this.play(name, opts);
    });
  }

  /** 2.1: a popup opened or closed (the kit's popups call it) — a click() of this event stays silent. */
  popupMark(): void {
    this.popupMarks++;
  }

  /** 2.1: how many times popups opened / closed so far (click()'s `since`). */
  get marks(): number {
    return this.popupMarks;
  }

  /** Switch the music track (null — stop). Remembered until audio is unlocked. */
  music(name: string | null): void {
    if (name && !(name in (this.opts.music ?? {}))) throw new Error(`music "${name}" is not declared (known: ${Object.keys(this.opts.music ?? {}).join(', ') || 'none'})`);
    if (this.wantedMusic === name) return;
    this.wantedMusic = name;
    this.musicVoice?.stop();
    this.musicVoice = null;
    if (name && this.ready) this.playMusic(name);
  }

  /** Game settings 0..1. */
  setVolumes(sfx: number, music: number): void {
    this.sfx = clamp01(sfx);
    this.mus = clamp01(music);
    this.apply();
  }

  get volumes(): { sfx: number; music: number } {
    return { sfx: this.sfx, music: this.mus };
  }

  /** Platform audio switch (Playables isAudioEnabled). */
  setPlatformAudio(on: boolean): void {
    this.platformOn = on;
    this.apply();
  }

  /** Platform pause: suspend the AudioContext. */
  suspend(): void {
    this.paused = true;
    void this.engine?.context.suspend().catch(() => {});
  }

  resume(): void {
    this.paused = false;
    if (this.unlocked) void this.engine?.unlock().catch(() => {});
  }

  /** 2.0: stop everything and close the audio context (game.destroy()); unlock() does nothing after. */
  destroy(): void {
    this.destroyed = true;
    this.musicVoice?.stop();
    this.musicVoice = null;
    const e = this.engine;
    this.engine = null;
    void e?.context.close().catch(() => {});
  }

  private ensureEngine(): Engine<'sfx' | 'music'> {
    if (!this.engine) {
      this.engine = createEngine({
        buses: { sfx: { level: 1, concurrency: { max: this.opts.maxVoices ?? 12, steal: 'oldest' } }, music: { level: 1 } },
        autoPauseOnHidden: false,
      });
      this.apply();
    }
    return this.engine;
  }

  private apply(): void {
    const e = this.engine;
    if (!e) return;
    e.bus('sfx').level = this.sfx;
    e.bus('music').level = this.mus;
    e.bus('sfx').muted = !this.platformOn;
    e.bus('music').muted = !this.platformOn;
  }

  private playMusic(name: string): void {
    const e = this.engine;
    if (!e || !e.hasSound(`music:${name}`)) return;
    this.musicVoice = e.sound(`music:${name}`).play({ loop: true, fadeIn: 1, bus: 'music' });
  }

  /** The synth spec of a sound of the table or a preset (null — a file). */
  private synthSpec(name: string): SynthSpec | null {
    const s = this.opts.sounds?.[name];
    if (s === undefined) return name in SYNTH_PRESETS ? SYNTH_PRESETS[name as SynthPreset] : null;
    const src: Raw = isEntry(s) ? s.src : s;
    if (isUrl(src)) return null;
    return 'synth' in src ? SYNTH_PRESETS[src.synth] : src;
  }

  private synth(name: string, spec: SynthSpec): void {
    const e = this.engine;
    if (!e || this.destroyed || e.hasSound(name)) return;
    const rate = e.context.sampleRate;
    const pcm = renderSynth(spec, rate);
    const buf = e.context.createBuffer(1, pcm.length, rate);
    buf.getChannelData(0).set(pcm);
    e.createSound(name, buf, { bus: 'sfx' });
  }

  private async load(): Promise<void> {
    const e = this.engine;
    if (!e || this.destroyed) return;
    const res = this.opts.resolve ?? ((h: string) => h);
    const urls = (u: string | readonly string[]) => (typeof u === 'string' ? [res(u)] : u.map(res));
    const jobs: Promise<unknown>[] = [];
    for (const [name, s] of Object.entries(this.opts.sounds ?? {})) {
      const src: Raw = isEntry(s) ? s.src : s;
      if (isUrl(src)) jobs.push(e.loadSound(name, urls(src), { bus: 'sfx' }).catch((err) => console.warn(`kit sound "${name}" failed to load`, err)));
    }
    for (const [name, src] of Object.entries(this.opts.music ?? {})) {
      jobs.push(e.loadSound(`music:${name}`, urls(src), { bus: 'music' }).catch((err) => console.warn(`kit music "${name}" failed to load`, err)));
    }
    // One synth sound per task: none of them lands in one long frame (a played one is in already).
    for (const name of new Set([...Object.keys(this.opts.sounds ?? {}), ...Object.keys(SYNTH_PRESETS)])) {
      const spec = this.synthSpec(name);
      if (!spec || e.hasSound(name)) continue;
      if (this.destroyed) return;
      this.synth(name, spec);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await Promise.all(jobs);
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
