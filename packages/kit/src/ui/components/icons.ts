// icons.ts — procedural icon glyphs of the default skin (a skin replaces any of them with art:
// role `icon.<name>`). Drawn into a Graphics centred at (0, 0), `s` = the icon box side.

import type { Graphics } from 'pixi.js';

export const ICONS = [
  'close', 'pause', 'play', 'settings', 'back', 'home', 'restart', 'sound-on', 'sound-off', 'music-on', 'music-off',
  'hint', 'video', 'plus', 'check', 'lock', 'star', 'menu',
] as const;
export type IconName = (typeof ICONS)[number];

/** Points of a 5-point star (outer radius r, inner ri), top point up. */
export function starPoints(r: number, ri = r * 0.45): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? ri : r;
    pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return pts;
}

function speaker(g: Graphics, s: number, color: number): void {
  const u = s / 10;
  g.poly([-4 * u, -1.6 * u, -2 * u, -1.6 * u, 1 * u, -4.2 * u, 1 * u, 4.2 * u, -2 * u, 1.6 * u, -4 * u, 1.6 * u]).fill(color);
}

function note(g: Graphics, s: number, color: number): void {
  const u = s / 10;
  g.circle(-2.2 * u, 2.8 * u, 1.8 * u).fill(color);
  g.circle(2.8 * u, 1.8 * u, 1.8 * u).fill(color);
  g.rect(-0.9 * u, -4 * u, 1.1 * u, 6.8 * u).fill(color);
  g.rect(4.1 * u, -5 * u, 1.1 * u, 6.8 * u).fill(color);
  g.poly([-0.9 * u, -4 * u, 5.2 * u, -5.2 * u, 5.2 * u, -3.4 * u, -0.9 * u, -2.2 * u]).fill(color);
}

function slash(g: Graphics, s: number, color: number): void {
  const u = s / 10;
  g.moveTo(-4.5 * u, -4.5 * u).lineTo(4.5 * u, 4.5 * u).stroke({ width: 1.4 * u, color, cap: 'round' });
}

/** Draw a named icon; unknown names fail loud with the list. */
export function drawIcon(g: Graphics, name: string, s: number, color: number): void {
  const u = s / 10;
  const line = { width: 1.4 * u, color, cap: 'round' as const, join: 'round' as const };
  switch (name as IconName) {
    case 'close':
      g.moveTo(-3.5 * u, -3.5 * u).lineTo(3.5 * u, 3.5 * u).moveTo(3.5 * u, -3.5 * u).lineTo(-3.5 * u, 3.5 * u).stroke(line);
      return;
    case 'pause':
      g.roundRect(-3.4 * u, -4 * u, 2.4 * u, 8 * u, 0.6 * u).fill(color);
      g.roundRect(1 * u, -4 * u, 2.4 * u, 8 * u, 0.6 * u).fill(color);
      return;
    case 'play':
      g.poly([-2.8 * u, -4.2 * u, 4.4 * u, 0, -2.8 * u, 4.2 * u]).fill(color);
      return;
    case 'settings': {
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        g.circle(Math.cos(a) * 3.6 * u, Math.sin(a) * 3.6 * u, 1.3 * u).fill(color);
      }
      g.circle(0, 0, 3.6 * u).fill(color);
      g.circle(0, 0, 1.5 * u).cut();
      return;
    }
    case 'back':
      g.moveTo(1.5 * u, -4 * u).lineTo(-2.5 * u, 0).lineTo(1.5 * u, 4 * u).stroke({ ...line, width: 1.8 * u });
      return;
    case 'home':
      g.poly([0, -4.6 * u, 4.6 * u, -0.4 * u, 3.2 * u, -0.4 * u, 3.2 * u, 4 * u, -3.2 * u, 4 * u, -3.2 * u, -0.4 * u, -4.6 * u, -0.4 * u]).fill(color);
      g.rect(-1 * u, 1.2 * u, 2 * u, 2.8 * u).cut();
      return;
    case 'restart':
      g.arc(0, 0, 3.6 * u, -Math.PI * 0.35, Math.PI * 1.45).stroke(line);
      g.poly([1.2 * u, -5.6 * u, 4.6 * u, -3.6 * u, 1.4 * u, -1.6 * u]).fill(color);
      return;
    case 'sound-on':
      speaker(g, s, color);
      g.arc(1.2 * u, 0, 2.2 * u, -Math.PI / 3.2, Math.PI / 3.2).stroke(line);
      g.arc(1.2 * u, 0, 4 * u, -Math.PI / 3.2, Math.PI / 3.2).stroke(line);
      return;
    case 'sound-off':
      speaker(g, s, color);
      g.moveTo(2.4 * u, -1.8 * u).lineTo(5.2 * u, 1.8 * u).moveTo(5.2 * u, -1.8 * u).lineTo(2.4 * u, 1.8 * u).stroke(line);
      return;
    case 'music-on':
      note(g, s, color);
      return;
    case 'music-off':
      note(g, s, color);
      slash(g, s, color);
      return;
    case 'hint':
      g.circle(-0.8 * u, -0.8 * u, 3 * u).stroke(line);
      g.moveTo(1.4 * u, 1.4 * u).lineTo(4.2 * u, 4.2 * u).stroke({ ...line, width: 1.9 * u });
      return;
    case 'video':
      g.roundRect(-4.6 * u, -3 * u, 6.6 * u, 6 * u, 1 * u).fill(color);
      g.poly([2.6 * u, -0.6 * u, 4.8 * u, -2.6 * u, 4.8 * u, 2.6 * u, 2.6 * u, 0.6 * u]).fill(color);
      return;
    case 'plus':
      g.moveTo(-4 * u, 0).lineTo(4 * u, 0).moveTo(0, -4 * u).lineTo(0, 4 * u).stroke({ ...line, width: 1.8 * u });
      return;
    case 'check':
      g.moveTo(-3.8 * u, 0.2 * u).lineTo(-1 * u, 3 * u).lineTo(4 * u, -2.8 * u).stroke({ ...line, width: 1.8 * u });
      return;
    case 'lock':
      g.roundRect(-3.6 * u, -0.6 * u, 7.2 * u, 5.2 * u, 1 * u).fill(color);
      g.arc(0, -0.8 * u, 2.4 * u, Math.PI, 0).stroke(line);
      return;
    case 'star':
      g.poly(starPoints(4.6 * u)).fill(color);
      return;
    case 'menu':
      for (const y of [-3, 0, 3]) g.roundRect(-4 * u, (y - 0.7) * u, 8 * u, 1.4 * u, 0.7 * u).fill(color);
      return;
    default:
      throw new Error(`kit icon: unknown "${name}" (known: ${ICONS.join(', ')}; or map the role icon.${name} in the skin)`);
  }
}
