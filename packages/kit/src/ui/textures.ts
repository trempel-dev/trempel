// textures.ts — small generated textures the UI draws with.

import { Texture } from 'pixi.js';

let white: Texture | null = null;

/** A small white texture for procedural fills (Texture.WHITE is 1×1, which layout's stretch skips). */
export function whiteTexture(): Texture {
  if (!white) {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 4, 4);
    white = Texture.from(c);
  }
  return white;
}
