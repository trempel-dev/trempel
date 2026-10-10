// symbol.ts — the kit's reel symbol (pixi-reels ReelSymbol): a texture when the look names one,
// otherwise a procedural placeholder (rounded tile + label) — a slot runs before the art exists.
// pixi-reels pools symbols per id; this class only draws. The win animation runs on the kit's tweens
// (the game loop: a platform pause freezes it with the rest of the game).

import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { ReelSymbol } from 'pixi-reels';
import type { Tweens } from '@trempel/kit';

/** How a symbol id looks. */
export interface SymbolLook {
  /** Texture href (preloaded; resolved through the game's asset table). */
  texture?: string;
  /** Placeholder tile colour. */
  color?: number;
  /** Placeholder label (default: the id). */
  label?: string;
  labelColor?: number;
}

export interface GameSymbolOptions {
  looks: Record<string, SymbolLook>;
  resolve?: (href: string) => string;
  /** The game's tweens (win animation); without them the symbol does not animate. */
  tweens?: Tweens;
}

export class GameSymbol extends ReelSymbol {
  private readonly holder = new Container();
  private readonly tile = new Graphics();
  private readonly sprite = new Sprite(Texture.EMPTY);
  private readonly text = new Text({ text: '', style: { fill: 0xffffff, fontSize: 40, fontWeight: 'bold', fontFamily: 'sans-serif' } });
  private id = '';
  private winRun = 0;
  private w = 100;
  private h = 100;

  constructor(private readonly opts: GameSymbolOptions) {
    super();
    this.text.anchor.set(0.5);
    this.sprite.anchor.set(0.5);
    this.holder.addChild(this.tile, this.sprite, this.text);
    this.view.addChild(this.holder);
  }

  protected onActivate(symbolId: string): void {
    this.id = symbolId;
    this.draw();
  }

  protected onDeactivate(): void {
    this.stopAnimation();
  }

  async playWin(): Promise<void> {
    const tw = this.opts.tweens;
    if (!tw) return;
    const scale = this.holder.scale;
    tw.kill(scale);
    const run = ++this.winRun;
    await tw.to(scale, { x: 1.15, y: 1.15 }, 0.15, 'outBack');
    if (run !== this.winRun) return;
    await tw.to(scale, { x: 1, y: 1 }, 0.25, 'outQuad');
  }

  stopAnimation(): void {
    this.winRun++;
    this.opts.tweens?.kill(this.holder.scale);
    this.holder.scale.set(1);
  }

  resize(width: number, height: number): void {
    this.w = width;
    this.h = height;
    this.draw();
  }

  private draw(): void {
    const look = this.opts.looks[this.id] ?? {};
    const { w, h } = this;
    this.holder.position.set(w / 2, h / 2);
    const tex = look.texture ? Assets.get<Texture>((this.opts.resolve ?? ((x: string) => x))(look.texture)) : undefined;
    this.tile.clear();
    if (tex) {
      this.sprite.texture = tex;
      this.sprite.visible = true;
      const k = Math.min(w / tex.width, h / tex.height);
      this.sprite.scale.set(k);
      this.text.visible = false;
    } else {
      this.sprite.visible = false;
      this.tile.roundRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, Math.min(w, h) * 0.18).fill(look.color ?? colorOf(this.id)).stroke({ color: 0x000000, width: 3, alpha: 0.3 });
      this.text.visible = true;
      this.text.text = look.label ?? this.id;
      this.text.style.fill = look.labelColor ?? 0xffffff;
      this.text.style.fontSize = Math.max(10, Math.floor(Math.min(h * 0.42, (w * 0.8) / Math.max(1, this.text.text.length * 0.6))));
    }
  }
}

const PALETTE = [0xff004d, 0xffa300, 0xffec27, 0x00e436, 0x29adff, 0x83769c, 0xff77a8, 0xab5236, 0x7e2553];
function colorOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
