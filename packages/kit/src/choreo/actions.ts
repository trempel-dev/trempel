// actions.ts — what the kit's choreography rows do (Director `actions`): a game passes its scene,
// clips, effects and sounds; it may add its own prefixes next to these.
//
//   clip:<name>   a clip of the game's (clipOf) on the row's scene; `value` `name = v` → clip params
//   tween:<prop>  the target's properties: `x: 0 → 120`, `alpha → 0`, `y += 30`, `scale.x = 2`
//                 over `dur` ms with `ease` (the kit's eases; unknown → linear); a row fired late by
//                 a frame starts that far in; skip (abort) jumps to the end values
//   fx:<name>     an effect at the target node (an effect node fires it, another node — a one-shot)
//   sound:<cue>   game.sound.play(cue)
//   call:<fn>     calls[fn](event, args) — args from `value` (`name = v`)
//   wait          nothing (a timer row)

import type { AnimClip } from '@trempel/scene';
import type { Clips, ClipPlayOptions } from '../anim/clips.js';
import { ease as EASES, type Ease, type Tweens } from '../anim/tweens.js';
import type { Fx } from '../fx/fx.js';
import { playFxMarker } from '../fx/node.js';
import type { Action, ChoreoEvent, EventProp } from './director.js';

type Scene = NonNullable<ClipPlayOptions['scene']>;

export interface KitActionDeps {
  /** The scene the rows' targets are ids in (a screen's mounted scene) — or by event. */
  scene?: Scene | ((e: ChoreoEvent) => Scene | undefined);
  /** A row target → the object a tween moves (default: the scene node of that id). */
  target?: (name: string, e: ChoreoEvent) => object | undefined;
  tweens?: Tweens;
  clips?: Pick<Clips, 'play'>;
  /** A clip by name (`clip:<name>`). */
  clipOf?: (name: string, e: ChoreoEvent) => AnimClip | undefined;
  fx?: Fx;
  sound?: { play(name: string): unknown };
  calls?: Record<string, (e: ChoreoEvent, args: Record<string, unknown>) => void>;
}

const sceneOf = (d: KitActionDeps, e: ChoreoEvent): Scene | undefined => (typeof d.scene === 'function' ? d.scene(e) : d.scene);

function need<T>(v: T | undefined, what: string, e: ChoreoEvent): T {
  if (v === undefined || v === null) throw new Error(`E_CHOREO_ACTION: ${e.seq}:${e.row}: ${e.action} — ${what}`);
  return v;
}

/** Read / write a property by a dotted path (`scale.x`). */
function prop(obj: object, path: string): { get(): number; set(v: number): void } {
  const parts = path.split('.');
  const last = parts.pop()!;
  const holder = () => parts.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, obj as Record<string, unknown>);
  return { get: () => Number(holder()[last]), set: (v) => void (holder()[last] = v) };
}

/** Event props → plain args (`name = v` items). */
const argsOf = (props: EventProp[]): Record<string, unknown> => Object.fromEntries(props.filter((p) => p.set !== undefined).map((p) => [p.name, p.set]));

export function kitActions(d: KitActionDeps): Record<string, Action> {
  const targetOf = (e: ChoreoEvent): object => {
    const name = e.target;
    const t = d.target ? d.target(name, e) : (sceneOf(d, e)?.byId.get(name) as object | undefined);
    return need(t, `no target "${name}"`, e);
  };
  const actions: Record<string, Action> = {
    tween(e, ctl, arg) {
      const obj = targetOf(e);
      const items = e.props.length ? e.props : [];
      if (!items.length && arg) throw new Error(`E_CHOREO_ACTION: ${e.seq}:${e.row}: ${e.action} — no value (\`${arg}: a → b\`)`);
      const tracks = items.map((p) => {
        const pr = prop(obj, p.name);
        if (p.set !== undefined) return { pr, from: Number(p.set), to: Number(p.set) };
        const now = pr.get();
        const from = p.from ?? now;
        const to = p.to ?? from + (p.by ?? 0);
        return { pr, from, to };
      });
      const end = () => tracks.forEach((x) => x.pr.set(x.to));
      const dur = e.dur;
      if (!dur || !Number.isFinite(dur) || !d.tweens) return end();
      const ease: Ease = (EASES as Record<string, Ease>)[e.ease] ?? EASES.linear;
      const late = Math.min(1, Math.max(0, (e.at - e.t) / dur));
      const apply = (k: number) => {
        const v = ease(late + (1 - late) * k);
        for (const x of tracks) x.pr.set(x.from + (x.to - x.from) * v);
      };
      apply(0);
      let stopped = false;
      ctl.signal.addEventListener('abort', () => {
        stopped = true;
        end();
      });
      void d.tweens.run(((1 - late) * dur) / 1000, (k) => !stopped && apply(k), { target: obj, alive: () => !stopped });
    },
    clip(e, ctl, name) {
      const clips = need(d.clips, 'no clips (kitActions({ clips }))', e);
      const clip = need(d.clipOf?.(name, e), `no clip "${name}"`, e);
      const params = Object.fromEntries(e.props.filter((p) => typeof p.set === 'number').map((p) => [p.name, p.set as number]));
      const h = clips.play(clip, { scene: sceneOf(d, e), params });
      ctl.signal.addEventListener('abort', () => h.abort());
    },
    fx(e, _ctl, name) {
      const fx = need(d.fx, 'no effects (kitActions({ fx }))', e);
      playFxMarker(fx, `fx:${name}${e.target ? `@${e.target}` : ''}`, sceneOf(d, e));
    },
    sound(e, _ctl, cue) {
      need(d.sound, 'no sound (kitActions({ sound }))', e).play(cue);
    },
    call(e, _ctl, fn) {
      const f = need(d.calls?.[fn], `no call "${fn}" (known: ${Object.keys(d.calls ?? {}).join(', ') || '—'})`, e);
      f(e, argsOf(e.props));
    },
  };
  return actions;
}
