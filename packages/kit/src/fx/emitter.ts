// emitter.ts — a ParticleSim drawn into a Pixi v8 ParticleContainer (one batch). The view only
// copies sim output into pooled `Particle`s each update; time comes from the game loop. 2.1: a config
// with `trails` gets a Graphics under its particles, stroked along each particle's path (trails.ts).
// Note: v8 ParticleContainer generates code with new Function unless 'pixi.js/unsafe-eval' is
// imported — the kit imports it in game.ts (CSP of Playables).

import { Container, Graphics, Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import { ParticleSim, type Rng } from './sim.js';
import { TrailSim } from './trails.js';
import type { ParticleConfig } from './types.js';

const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export class ParticleEmitter {
  readonly view = new Container();
  readonly sim: ParticleSim;
  /** 2.1: the trails of the particles (null without `trails`), and their stroke under the particles. */
  readonly trails: TrailSim | null;
  readonly trailView: Graphics | null;
  private readonly container: ParticleContainer;
  private readonly frames: Texture[];
  private readonly sprites: Particle[] = [];

  constructor(config: ParticleConfig, texture: Texture, rng?: Rng) {
    this.sim = new ParticleSim(config, rng);
    this.trails = config.trails ? new TrailSim(config, rng) : null;
    if (this.trails) {
      const g = new Graphics();
      g.blendMode = this.trails.trail.blend;
      g.scale.set(config.unit[0], config.unit[1]);
      g.eventMode = 'none';
      this.view.addChild(g);
      this.trailView = g;
    } else this.trailView = null;
    this.frames = config.sheet ? sheetFrames(texture, config.sheet.tilesX, config.sheet.tilesY) : [texture];
    this.container = new ParticleContainer({
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: !!config.sheet },
      texture,
    });
    this.container.blendMode = config.blend;
    this.container.scale.set(config.unit[0], config.unit[1]);
    this.view.addChild(this.container);
    this.view.eventMode = 'none';
  }

  get alive(): boolean {
    return this.sim.alive;
  }

  play(): this {
    this.sim.play();
    this.sync();
    return this;
  }

  stop(): void {
    this.sim.stop();
  }

  clear(): void {
    this.sim.clear();
    this.sync();
  }

  emit(n: number): void {
    this.sim.emit(n);
    this.sync();
  }

  update(dt: number): void {
    this.sim.update(dt);
    this.trails?.update(this.sim.particles, dt);
    this.sync();
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private sync(): void {
    const ps = this.sim.particles;
    const g = this.trailView;
    if (g && !g.destroyed) {
      g.clear();
      this.trails!.segments(ps, (s) => void g.moveTo(s.x0, s.y0).lineTo(s.x1, s.y1).stroke({ width: s.width, color: s.color, alpha: s.alpha, cap: 'round' }));
    }
    while (this.sprites.length < ps.length) {
      const sp = new Particle({ texture: this.frames[0], anchorX: 0.5, anchorY: 0.5 });
      this.sprites.push(sp);
      this.container.addParticle(sp);
    }
    while (this.sprites.length > ps.length) this.container.removeParticle(this.sprites.pop()!);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const sp = this.sprites[i];
      const tex = this.frames[p.frame] ?? this.frames[0];
      sp.texture = tex;
      sp.x = p.x;
      sp.y = p.y;
      sp.rotation = p.rotation;
      const tw = tex.frame.width || 1;
      const th = tex.frame.height || 1;
      sp.scaleX = p.outSize / tw;
      sp.scaleY = (p.outSize * p.stretch) / th;
      const [r, g, b, a] = p.outColor;
      sp.tint = (to255(r) << 16) | (to255(g) << 8) | to255(b);
      sp.alpha = a;
    }
  }
}

const sheetCache = new WeakMap<Texture, Texture[]>();
function sheetFrames(tex: Texture, tilesX: number, tilesY: number): Texture[] {
  const hit = sheetCache.get(tex);
  if (hit) return hit;
  const fw = tex.frame.width / tilesX;
  const fh = tex.frame.height / tilesY;
  const frames: Texture[] = [];
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) frames.push(new Texture({ source: tex.source, frame: new Rectangle(tex.frame.x + x * fw, tex.frame.y + y * fh, fw, fh) }));
  sheetCache.set(tex, frames);
  return frames;
}
