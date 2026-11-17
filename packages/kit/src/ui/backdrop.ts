// backdrop.ts — what is seen beside the column and wherever the world is dragged off the canvas:
// the clear colour, or a BLURRED COPY of a texture / container cover-fit to the whole window, a
// little darker. `game.backdrop.set(level.background)` — a texture follows it as is; a container
// is snapshotted (call set() again after it changes).

import { BlurFilter, ColorMatrixFilter, Container, Sprite, Texture, type Renderer } from 'pixi.js';
import { coverScale } from './layout.js';

export interface BackdropOptions {
  /** Blur strength, screen px (default 24). */
  blur?: number;
  /** Brightness multiplier (default 0.72). */
  brightness?: number;
  /** Cover-fit overscan: the blur fades the edges, so the copy goes past the window (default 1.08). */
  overscan?: number;
}

export class Backdrop {
  /** Bottom-most node of the stage. */
  readonly view = new Container();
  private readonly sprite = new Sprite(Texture.EMPTY);
  private owned: Texture | null = null;
  private W = 0;
  private H = 0;
  readonly options: Required<BackdropOptions>;

  constructor(
    private readonly renderer: Renderer | null,
    opts: BackdropOptions = {},
  ) {
    this.options = { blur: opts.blur ?? 24, brightness: opts.brightness ?? 0.72, overscan: opts.overscan ?? 1.08 };
    this.view.label = 'kit:backdrop';
    this.view.eventMode = 'none';
    this.sprite.anchor.set(0.5);
    this.sprite.visible = false;
    const blur = new BlurFilter({ strength: this.options.blur, quality: 4 });
    const dim = new ColorMatrixFilter();
    dim.brightness(this.options.brightness, false);
    this.sprite.filters = [blur, dim];
    this.view.addChild(this.sprite);
  }

  /** The texture shown (EMPTY when none). */
  get texture(): Texture {
    return this.sprite.texture;
  }

  /** Show a blurred copy of a texture or of a container (snapshot), or nothing (null). */
  set(source: Texture | Container | null): void {
    this.owned?.destroy(true);
    this.owned = null;
    let tex: Texture = Texture.EMPTY;
    if (source instanceof Texture) tex = source;
    else if (source) {
      if (!this.renderer) throw new Error('kit backdrop: a container snapshot needs the renderer');
      tex = this.owned = this.renderer.generateTexture(source);
    }
    this.sprite.texture = tex;
    this.sprite.visible = tex.width > 1;
    this.layout(this.W, this.H);
  }

  /** Cover the window W×H (px). */
  layout(W: number, H: number): void {
    this.W = W;
    this.H = H;
    this.sprite.position.set(W / 2, H / 2);
    const t = this.sprite.texture;
    if (t.width > 1 && W > 0 && H > 0) this.sprite.scale.set(coverScale(W, H, t.width, t.height) * this.options.overscan);
  }
}
