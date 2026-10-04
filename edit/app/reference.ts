// reference.ts — the reference layer (batch 2): a picture (a mockup, a frame of a video, a render)
// drawn under the scene — or over it — fitted to the scene's viewBox, with an opacity. Never written
// to the scene file: the choice lives in localStorage per scene (folder + scene id). Without a
// stored choice `<scene>.mockup.png` or `mockup.png` next to the scene is picked up by itself.
//
// pixels(box) — the picture at the viewBox's 1:1 size (as the similarity macro compares it with the
// render), cropped to a box in scene units.

import { Assets, Sprite, type Texture } from 'pixi.js';
import type { SceneIO } from '../io';
import type { Editor } from './editor';
import { viewBoxOf, type Pixels, type SceneBox } from './snapshot';

export interface ReferenceState {
  /** Picture path relative to the folder (null — off). */
  file: string | null;
  /** 0–100 %. */
  opacity: number;
  /** Over the scene instead of under it. */
  over: boolean;
}

const KEY = 'tml-edit:reference:';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Reference {
  state: ReferenceState = { file: null, opacity: 50, over: false };
  private sprite: Sprite | null = null;
  private loaded: { file: string; texture: Texture } | null = null;
  private scene: string | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly ed: Editor,
    private readonly io: SceneIO,
  ) {
    ed.on('scenes', () => {
      const id = ed.entry ? `${ed.listing.name}/${ed.entry.id}` : null;
      if (id === this.scene) return;
      this.scene = id;
      this.state = this.restore();
      void this.apply();
    });
    ed.on('layout', () => this.place());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Stored choice, else the mockup next to the scene. */
  private restore(): ReferenceState {
    const base: ReferenceState = { file: null, opacity: 50, over: false };
    try {
      const raw = this.scene ? localStorage.getItem(KEY + this.scene) : null;
      if (raw) return { ...base, ...(JSON.parse(raw) as Partial<ReferenceState>) };
    } catch {
      /* no storage — defaults */
    }
    const entry = this.ed.entry;
    if (!entry) return base;
    const dir = entry.id.includes('/') ? entry.id.slice(0, entry.id.lastIndexOf('/') + 1) : '';
    const auto = [`${entry.id}.mockup.png`, `${dir}mockup.png`].find((f) => this.ed.listing.files.includes(f));
    return { ...base, file: auto ?? null };
  }

  private save(): void {
    try {
      if (this.scene) localStorage.setItem(KEY + this.scene, JSON.stringify(this.state));
    } catch {
      /* no storage — the choice lasts the session */
    }
  }

  /** Choose the picture (null — off), and/or its opacity and side. */
  async set(patch: Partial<ReferenceState>): Promise<void> {
    this.state = { ...this.state, ...patch, opacity: Math.max(0, Math.min(100, patch.opacity ?? this.state.opacity)) };
    this.save();
    await this.apply();
  }

  private url(file: string): string {
    const u = this.io.url(file);
    return this.io.assetUrl ? this.io.assetUrl(u) : u;
  }

  private async texture(file: string): Promise<Texture> {
    if (this.loaded?.file === file) return this.loaded.texture;
    const texture = await Assets.load<Texture>(this.url(file));
    this.loaded = { file, texture };
    return texture;
  }

  private async apply(): Promise<void> {
    const { file } = this.state;
    this.sprite?.removeFromParent();
    if (!file) {
      this.sprite = null;
      this.changed();
      return;
    }
    try {
      const texture = await this.texture(file);
      if (this.state.file !== file) return; // a newer choice won
      this.sprite ??= new Sprite();
      this.sprite.label = 'reference';
      this.sprite.texture = texture;
      this.place();
    } catch (e) {
      this.ed.log('error', `эталон ${file}: ${msg(e)}`);
      this.sprite = null;
    }
    this.changed();
  }

  /** Under or over the scene, fitted to the viewBox, with the opacity. */
  private place(): void {
    const s = this.sprite;
    if (!s) return;
    const vb = viewBoxOf(this.ed);
    s.position.set(vb.x, vb.y);
    s.setSize(vb.width, vb.height);
    s.alpha = this.state.opacity / 100;
    const layer = this.state.over ? this.ed.over : this.ed.under;
    if (s.parent !== layer) {
      s.removeFromParent();
      layer.addChild(s);
    }
  }

  /** Is a picture drawn now. */
  get shown(): boolean {
    return !!this.sprite?.parent;
  }

  /**
   * The picture at the viewBox's 1:1 size, cropped to `box` (scene units; default — all of it):
   * RGBA, row by row. null — no reference.
   */
  async pixels(box?: SceneBox): Promise<Pixels | null> {
    const file = this.state.file;
    if (!file) return null;
    const vb = viewBoxOf(this.ed);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = this.url(file);
    await img.decode();
    const W = Math.round(vb.width);
    const H = Math.round(vb.height);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, W, H);
    const b = box ?? vb;
    const x = Math.max(0, Math.floor(b.x - vb.x));
    const y = Math.max(0, Math.floor(b.y - vb.y));
    const w = Math.max(0, Math.min(W, Math.ceil(b.x - vb.x + b.width)) - x);
    const h = Math.max(0, Math.min(H, Math.ceil(b.y - vb.y + b.height)) - y);
    if (!w || !h) return { width: 0, height: 0, data: new Uint8ClampedArray(0) };
    const d = g.getImageData(x, y, w, h);
    return { width: d.width, height: d.height, data: d.data };
  }
}
