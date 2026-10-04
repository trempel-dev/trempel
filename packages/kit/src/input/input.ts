// input.ts — game input from keyboard and touch/mouse as directions and actions, so games don't
// hand-roll listeners (Playables: touch AND mouse MUST work for every interaction).
//   keys: arrows/WASD → 'up'|'down'|'left'|'right', Space/Enter → 'action', Escape/P → 'pause'.
//   swipe on the canvas → a direction; a tap (short, small move) → 'tap' with the point.
// Pure core (`swipeDirection`) is unit-tested; the DOM wiring is attach().

export type Dir = 'up' | 'down' | 'left' | 'right';
export type InputAction = Dir | 'action' | 'pause';

export interface TapEvent {
  x: number;
  y: number;
}

const KEYS: Record<string, InputAction> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Space: 'action', Enter: 'action', NumpadEnter: 'action', Escape: 'pause', KeyP: 'pause',
};

/** Direction of a swipe (dx, dy px), or null when shorter than `min`. */
export function swipeDirection(dx: number, dy: number, min = 24): Dir | null {
  if (Math.hypot(dx, dy) < min) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

export function keyAction(code: string): InputAction | null {
  return KEYS[code] ?? null;
}

export class Input {
  private handlers: ((a: InputAction) => void)[] = [];
  private tapHandlers: ((t: TapEvent) => void)[] = [];
  /** Actions are ignored while false (popups, transitions). */
  enabled = true;

  /** Subscribe to actions; returns the unsubscribe function. */
  on(fn: (a: InputAction) => void): () => void {
    this.handlers.push(fn);
    return () => (this.handlers = this.handlers.filter((h) => h !== fn));
  }

  /** Taps on the canvas (screen px). */
  onTap(fn: (t: TapEvent) => void): () => void {
    this.tapHandlers.push(fn);
    return () => (this.tapHandlers = this.tapHandlers.filter((h) => h !== fn));
  }

  /** Feed an action (tests, on-screen buttons). */
  fire(a: InputAction): void {
    if (!this.enabled && a !== 'pause') return;
    for (const h of [...this.handlers]) h(a);
  }

  /** Wire keyboard (window) and swipes/taps (canvas). Called by createGame. */
  attach(canvas: HTMLElement, onGesture?: () => void): void {
    window.addEventListener('keydown', (e) => {
      onGesture?.();
      const a = keyAction(e.code);
      if (!a) return;
      e.preventDefault();
      if (!e.repeat || a !== 'pause') this.fire(a);
    });
    let start: { x: number; y: number; t: number; id: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      onGesture?.();
      start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const dir = swipeDirection(dx, dy);
      if (dir) this.fire(dir);
      else if (performance.now() - start.t < 500 && this.enabled) for (const h of [...this.tapHandlers]) h({ x: e.clientX, y: e.clientY });
      start = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => (start = null));
  }
}
