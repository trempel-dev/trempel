// safe-area.ts — the device's safe-area insets (notches, rounded corners, the gesture bar) in CSS px
// = Pixi screen units (autoDensity). Read from CSS env(safe-area-inset-*) through a hidden probe
// element; `--trempel-safe-top|right|bottom|left` on :root override them (tests, a host that knows
// better). env() is non-zero only with `<meta name="viewport" content="…, viewport-fit=cover">`
// (the kit's templates have it). Re-read on every layout: rotation changes the insets.

import { NO_INSETS, type Insets } from './layout.js';

let probe: HTMLElement | null = null;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** Current safe-area insets of the page (zeros outside a browser). */
export function readSafeArea(): Insets {
  if (typeof document === 'undefined' || !document.body) return { ...NO_INSETS };
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.dataset.trempel = 'safe-area';
    const pad = SIDES.map((s) => `var(--trempel-safe-${s}, env(safe-area-inset-${s}, 0px))`).join(' ');
    probe.style.cssText = `position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:${pad}`;
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}
