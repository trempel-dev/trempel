// A fake Pixi Application for createGame tests without WebGL (TRM-8b; the same as game.test.ts has
// inline): a stage, a manual ticker (with remove), a renderer that resizes, destroy().
import { vi } from 'vitest';

export const size = { w: 720, h: 1280 };
export const apps: FakeApp[] = [];

export class FakeCanvas {
  style: Record<string, string> = {};
  parentNode: { removeChild(c: unknown): void } | null = null;
  readonly handlers = new Map<string, ((e: unknown) => void)[]>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatch(type: string, e: unknown = {}): void {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
}

export class FakeApp {
  stage!: import('pixi.js').Container;
  readonly canvas = new FakeCanvas();
  readonly screen = { x: 0, y: 0, width: 0, height: 0 };
  renders = 0;
  destroyed = false;
  readonly tickers: ((t: { deltaMS: number }) => void)[] = [];
  readonly ticker = {
    add: (fn: (t: { deltaMS: number }) => void) => void this.tickers.push(fn),
    remove: (fn: (t: { deltaMS: number }) => void) => void this.tickers.splice(this.tickers.indexOf(fn) >>> 0, 1),
  };
  private readonly resizers: (() => void)[] = [];
  readonly renderer = {
    on: (ev: string, fn: () => void) => void (ev === 'resize' && this.resizers.push(fn)),
    resize: (w: number, h: number) => {
      this.screen.width = w;
      this.screen.height = h;
      this.resizers.forEach((f) => f());
    },
    generateTexture: () => null,
    resolution: 1,
    /** 2.1: snapshots of the transitions render into textures. */
    snapshots: 0,
    render: () => void this.renderer.snapshots++,
  };
  async init(): Promise<void> {
    const { Container } = await vi.importActual<typeof import('pixi.js')>('pixi.js');
    this.stage = new Container();
    this.screen.width = size.w;
    this.screen.height = size.h;
    apps.push(this);
  }
  render(): void {
    this.renders++;
  }
  destroy(): void {
    this.destroyed = true;
    this.tickers.length = 0;
    this.stage.destroy({ children: true });
  }
  tick(ms = 1000 / 60): void {
    for (const f of [...this.tickers]) f({ deltaMS: ms });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Run frames until `p` settles. */
export async function drive<T>(app: FakeApp, p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 600 && !done; i++) {
    app.tick();
    await flush();
  }
  return p;
}

/** n frames. */
export async function frames(app: FakeApp, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    app.tick();
    await flush();
  }
}

/** The minimal DOM createGame reads; returns the window listeners (keydown…) for checks. */
export function stubDom(search = ''): { windowListeners: Map<string, unknown[]>; parent: { children: unknown[]; appendChild(c: unknown): void } } {
  const windowListeners = new Map<string, unknown[]>();
  const parent = {
    children: [] as unknown[],
    appendChild(c: unknown) {
      parent.children.push(c);
      (c as FakeCanvas).parentNode = { removeChild: (x: unknown) => void parent.children.splice(parent.children.indexOf(x), 1) };
    },
  };
  vi.stubGlobal('document', { body: { children: [] }, getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {}, getContext: () => null }) });
  vi.stubGlobal('window', {
    addEventListener: (t: string, f: unknown) => windowListeners.set(t, [...(windowListeners.get(t) ?? []), f]),
    removeEventListener: (t: string, f: unknown) => windowListeners.set(t, (windowListeners.get(t) ?? []).filter((x) => x !== f)),
    devicePixelRatio: 1,
  });
  vi.stubGlobal('location', { search });
  vi.stubGlobal('devicePixelRatio', 1);
  return { windowListeners, parent };
}
