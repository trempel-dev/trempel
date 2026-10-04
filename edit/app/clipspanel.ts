// clipspanel.ts — the «Клипы» tab: the clip list, ▶ ⏸ ⏹, time slider with the seconds, loop,
// speed, onion (+ Δ), and «снимок для видео» (background colour / transparent — kept in
// localStorage). Everything goes through Clips (edit/app/clips.ts) — the same calls as tml.anim.

import type { Clips } from './clips';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const BG_KEY = 'tml-edit:i2v-background';

export interface ShotSetting {
  color: string;
  transparent: boolean;
}

/** The «снимок для видео» background setting (null — transparent). */
export function shotBackground(): string | null {
  const t = ($('shot-transparent') as HTMLInputElement | null)?.checked;
  return t ? null : (($('shot-bg') as HTMLInputElement | null)?.value ?? '#ffffff');
}

export function mountClipsPanel(clips: Clips, onShot: () => void): void {
  const name = $('clip-name') as HTMLSelectElement;
  const slider = $('clip-time') as HTMLInputElement;
  const num = $('clip-t') as HTMLInputElement;
  const dur = $('clip-dur');
  const loop = $('clip-loop') as HTMLInputElement;
  const speed = $('clip-speed') as HTMLSelectElement;
  const onion = $('clip-onion') as HTMLInputElement;
  const delta = $('clip-onion-d') as HTMLInputElement;
  const info = $('clip-info');
  const bg = $('shot-bg') as HTMLInputElement;
  const transparent = $('shot-transparent') as HTMLInputElement;

  const fail = (e: unknown): void => {
    info.textContent = e instanceof Error ? e.message : String(e);
  };
  const guard = (fn: () => void) => () => {
    try {
      fn();
    } catch (e) {
      fail(e);
    }
  };

  const fillList = (): void => {
    const keep = clips.selected ?? '';
    name.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = clips.list.length ? '— клип —' : 'клипов нет';
    name.append(none);
    for (const c of clips.list) {
      const o = document.createElement('option');
      o.value = c.name;
      o.textContent = `${c.name} · ${c.duration.toFixed(2)} с`;
      o.title = c.file;
      name.append(o);
    }
    name.value = keep;
  };

  const sync = (): void => {
    const c = clips.current;
    name.value = clips.selected ?? '';
    const d = c?.duration ?? 0;
    slider.max = String(d || 1);
    slider.disabled = !c;
    num.disabled = !c;
    dur.textContent = c ? `/ ${d.toFixed(2)} с` : '';
    loop.checked = clips.loop;
    speed.value = String(clips.speed);
    onion.checked = clips.onion.on;
    $('clip-play').toggleAttribute('disabled', !clips.list.length || clips.playing);
    $('clip-pause').toggleAttribute('disabled', !clips.playing);
    $('clip-stop').toggleAttribute('disabled', !clips.active);
    info.textContent = c
      ? `${c.file}${clips.errors.length ? ` · ошибок клипов: ${clips.errors.length}` : ''}`
      : clips.errors.length
        ? `ошибок клипов: ${clips.errors.length} (панель «Ошибки»)`
        : '';
  };
  const tick = (): void => {
    const t = clips.time;
    slider.value = String(t);
    if (document.activeElement !== num) num.value = t.toFixed(2);
  };

  name.onchange = guard(() => clips.select(name.value || null));
  $('clip-play').onclick = guard(() => clips.play(name.value || undefined));
  $('clip-pause').onclick = guard(() => clips.pause());
  $('clip-stop').onclick = () => void clips.stop();
  slider.oninput = guard(() => clips.seek(Number(slider.value)));
  num.onchange = guard(() => clips.seek(Number(num.value) || 0));
  loop.onchange = () => clips.setLoop(loop.checked);
  speed.onchange = () => clips.setSpeed(Number(speed.value));
  onion.onchange = () => clips.setOnion(onion.checked, Number(delta.value));
  delta.onchange = () => clips.setOnion(onion.checked, Number(delta.value));

  // «снимок для видео»: the background setting survives reloads
  try {
    const saved = JSON.parse(localStorage.getItem(BG_KEY) ?? 'null') as ShotSetting | null;
    if (saved) {
      bg.value = saved.color;
      transparent.checked = saved.transparent;
    }
  } catch {
    /* no storage */
  }
  const keep = (): void => {
    bg.disabled = transparent.checked;
    try {
      localStorage.setItem(BG_KEY, JSON.stringify({ color: bg.value, transparent: transparent.checked }));
    } catch {
      /* no storage */
    }
  };
  bg.onchange = keep;
  transparent.onchange = keep;
  bg.disabled = transparent.checked;
  $('shot-take').onclick = onShot;

  clips.on('list', () => {
    fillList();
    sync();
  });
  clips.on('state', sync);
  clips.on('tick', tick);
  fillList();
  sync();
}
