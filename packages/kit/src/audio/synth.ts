// synth.ts — procedural placeholder sounds (no audio files needed for a prototype). A SynthSpec is
// rendered into PCM samples by pure math (testable without Web Audio), then wrapped into an
// AudioBuffer by the sound module. Presets cover the usual UI/game beeps.

export interface SynthSpec {
  /** Waveform. */
  wave?: 'sine' | 'square' | 'triangle' | 'saw' | 'noise';
  /** Start frequency, Hz. */
  freq?: number;
  /** End frequency (slide), Hz. */
  to?: number;
  /** Duration, seconds. */
  dur?: number;
  /** Peak volume 0..1. */
  volume?: number;
  /** Attack, seconds. */
  attack?: number;
  /** Several notes in a row (arpeggio): frequencies, each `dur` long. */
  notes?: number[];
}

export const SYNTH_PRESETS = {
  click: { wave: 'square', freq: 900, to: 600, dur: 0.05, volume: 0.25 },
  pop: { wave: 'sine', freq: 520, to: 1100, dur: 0.09, volume: 0.45 },
  coin: { wave: 'square', notes: [988, 1319], dur: 0.08, volume: 0.25 },
  eat: { wave: 'triangle', freq: 440, to: 880, dur: 0.1, volume: 0.5 },
  hit: { wave: 'noise', dur: 0.18, volume: 0.45 },
  lose: { wave: 'saw', freq: 440, to: 110, dur: 0.6, volume: 0.3 },
  win: { wave: 'square', notes: [523, 659, 784, 1047], dur: 0.11, volume: 0.25 },
  whoosh: { wave: 'noise', dur: 0.3, volume: 0.25, attack: 0.12 },
  rise: { wave: 'triangle', freq: 220, to: 330, dur: 0.15, volume: 0.3 },
  stop: { wave: 'square', freq: 180, to: 120, dur: 0.06, volume: 0.3 },
} as const satisfies Record<string, SynthSpec>;

export type SynthPreset = keyof typeof SYNTH_PRESETS;

/** Render a spec to mono samples in -1..1. `rand` — noise source (inject for determinism). */
export function renderSynth(spec: SynthSpec, sampleRate: number, rand: () => number = Math.random): Float32Array {
  const notes = spec.notes ?? [spec.freq ?? 440];
  const dur = spec.dur ?? 0.15;
  const per = Math.max(1, Math.round(dur * sampleRate));
  const out = new Float32Array(per * notes.length);
  const vol = spec.volume ?? 0.4;
  const attack = Math.max(1, Math.round((spec.attack ?? 0.005) * sampleRate));
  const wave = spec.wave ?? 'sine';
  for (let n = 0; n < notes.length; n++) {
    const f0 = notes[n];
    const f1 = spec.notes ? f0 : (spec.to ?? f0);
    let phase = 0;
    for (let i = 0; i < per; i++) {
      const k = i / per;
      const f = f0 + (f1 - f0) * k;
      phase += f / sampleRate;
      const p = phase % 1;
      let s: number;
      switch (wave) {
        case 'square':
          s = p < 0.5 ? 1 : -1;
          break;
        case 'triangle':
          s = 1 - 4 * Math.abs(p - 0.5);
          break;
        case 'saw':
          s = 2 * p - 1;
          break;
        case 'noise':
          s = rand() * 2 - 1;
          break;
        default:
          s = Math.sin(2 * Math.PI * p);
      }
      const env = Math.min(1, i / attack) * (1 - k) ** 2;
      out[n * per + i] = s * vol * env;
    }
  }
  return out;
}
