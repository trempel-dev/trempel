// sound.ts — the kit's sound: a thin wrapper over zvuk (taken as is: buses, voice limits, music,
// unlock).
//
// Buses: `sfx` and `music`, levels = the game's settings (0..1, saved by the game); the platform
// audio switch (Playables isAudioEnabled) mutes the master on top; platform pause suspends the
// AudioContext (zvuk's own Page Visibility pause is OFF — Playables forbids that API).
// Sounds load after the first user gesture (autoplay policy; not part of the initial bundle).
// A sound is a URL (or codec ladder ['x.webm','x.m4a']) or a procedural SynthSpec/preset name —
// placeholders without audio files.

import { createEngine, type Engine } from '@schmooky/zvuk';
import { renderSynth, SYNTH_PRESETS, type SynthPreset, type SynthSpec } from './synth.js';

export type SoundSource = string | readonly string[] | SynthSpec | { synth: SynthPreset };

export interface SoundOptions {
  /** One-shot effects by name. */
  sounds?: Record<string, SoundSource>;
  /** Music tracks by name (looped on the music bus). */
  music?: Record<string, string | readonly string[]>;
  /** Href → URL (bundler table). */
  resolve?: (href: string) => string;
  /** Max simultaneous sfx voices. */
  maxVoices?: number;
}

const isUrl = (s: SoundSource): s is string | readonly string[] => typeof s === 'string' || Array.isArray(s);

export class Sound {
  private engine: Engine<'sfx' | 'music'> | null = null;
  private loading: Promise<void> | null = null;
  private platformOn = true;
  private paused = false;
  private sfx = 1;
  private mus = 1;
  private wantedMusic: string | null = null;
  private musicVoice: { stop(): unknown } | null = null;
  private readonly known: Set<string>;
  /** Names played so far (tests, QA probe). */
  readonly log: string[] = [];
  private destroyed = false;

  constructor(private readonly opts: SoundOptions = {}) {
    this.known = new Set([...Object.keys(opts.sounds ?? {}), ...Object.keys(SYNTH_PRESETS)]);
  }

  /** Audio is live (unlocked and loaded). */
  get ready(): boolean {
    return !!this.engine && !this.loading;
  }

  /** Call from a user gesture (the kit wires the first pointerdown/keydown). Idempotent. */
  unlock(): void {
    if (this.destroyed) return;
    if (typeof AudioContext === 'undefined' && typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext === 'undefined') return;
    if (!this.engine) {
      this.engine = createEngine({
        buses: { sfx: { level: 1, concurrency: { max: this.opts.maxVoices ?? 12, steal: 'oldest' } }, music: { level: 1 } },
        autoPauseOnHidden: false,
      });
      this.apply();
      this.loading = this.load().finally(() => {
        this.loading = null;
        if (this.wantedMusic) this.playMusic(this.wantedMusic);
      });
    }
    if (!this.paused) void this.engine.unlock().catch(() => {});
  }

  /** Play a one-shot by name (or a synth preset name). Silently nothing before unlock. */
  play(name: string, opts: { volume?: number; pitch?: number } = {}): void {
    if (!this.known.has(name)) throw new Error(`sound "${name}" is not declared (known: ${[...this.known].join(', ')})`);
    this.log.push(name);
    const e = this.engine;
    if (!e || this.loading || this.paused || !e.hasSound(name)) return;
    e.sound(name).play({ volume: opts.volume ?? 1, pitch: opts.pitch ?? 1, bus: 'sfx' });
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
    void this.engine?.unlock().catch(() => {});
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

  private async load(): Promise<void> {
    const e = this.engine!;
    const res = this.opts.resolve ?? ((h: string) => h);
    const urls = (u: string | readonly string[]) => (typeof u === 'string' ? [res(u)] : u.map(res));
    const jobs: Promise<unknown>[] = [];
    const synth = (name: string, spec: SynthSpec) => {
      const rate = e.context.sampleRate;
      const pcm = renderSynth(spec, rate);
      const buf = e.context.createBuffer(1, pcm.length, rate);
      buf.getChannelData(0).set(pcm);
      e.createSound(name, buf, { bus: 'sfx' });
    };
    for (const [name, spec] of Object.entries(SYNTH_PRESETS)) if (!(this.opts.sounds && name in this.opts.sounds)) synth(name, spec);
    for (const [name, src] of Object.entries(this.opts.sounds ?? {})) {
      if (isUrl(src)) jobs.push(e.loadSound(name, urls(src), { bus: 'sfx' }).catch((err) => console.warn(`kit sound "${name}" failed to load`, err)));
      else synth(name, 'synth' in src ? SYNTH_PRESETS[src.synth] : src);
    }
    for (const [name, src] of Object.entries(this.opts.music ?? {})) {
      jobs.push(e.loadSound(`music:${name}`, urls(src), { bus: 'music' }).catch((err) => console.warn(`kit music "${name}" failed to load`, err)));
    }
    await Promise.all(jobs);
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
