// keymap.ts — the stage's hot keys as a table with two schemes: `blender` (default — modal
// operators G/R/S, Tab, Shift+D, H/Alt+H, A/Alt+A, F3) and `figma` (V/P, arrows, ⌘D, ⌘⇧P). Keys
// common to both (⌘Z/⌘S/⌘K/⌘P, zoom, Delete, Esc/Enter) live in COMMON. The scheme is a setting of
// the page (localStorage). Pure: no DOM beyond reading a KeyboardEvent-like object.
//
// A chord is `mod+shift+alt+ctrl+<key>`: mod — ⌘ on a Mac, Ctrl elsewhere; ctrl — the Control key
// itself (Blender's Ctrl+. on a Mac too). Letters match by physical key (event.code), so a Russian
// layout works the same; other keys by event.key.

export type KeymapScheme = 'blender' | 'figma';

export type Action =
  | 'op.move'
  | 'op.rotate'
  | 'op.scale'
  | 'pivot.pick'
  | 'pivot.centre'
  | 'tool.select'
  | 'tool.path'
  | 'scope.enter'
  | 'scope.exit'
  | 'node.duplicate'
  | 'node.remove'
  | 'node.hide'
  | 'node.unhideAll'
  | 'select.all'
  | 'select.none'
  | 'palette.commands'
  | 'palette.macros'
  | 'palette.prefabs'
  | 'nudge.left'
  | 'nudge.right'
  | 'nudge.up'
  | 'nudge.down'
  | 'nudge.left10'
  | 'nudge.right10'
  | 'nudge.up10'
  | 'nudge.down10'
  | 'save'
  | 'undo'
  | 'redo'
  | 'zoom.fit'
  | 'zoom.100'
  | 'zoom.in'
  | 'zoom.out';

export interface Binding {
  action: Action;
  keys: string[];
  /** For the palette and the help line. */
  title: string;
}

const NUDGE: Binding[] = [
  { action: 'nudge.left', keys: ['arrowleft'], title: 'nudge ← 1' },
  { action: 'nudge.right', keys: ['arrowright'], title: 'nudge → 1' },
  { action: 'nudge.up', keys: ['arrowup'], title: 'nudge ↑ 1' },
  { action: 'nudge.down', keys: ['arrowdown'], title: 'nudge ↓ 1' },
  { action: 'nudge.left10', keys: ['shift+arrowleft'], title: 'nudge ← 10' },
  { action: 'nudge.right10', keys: ['shift+arrowright'], title: 'nudge → 10' },
  { action: 'nudge.up10', keys: ['shift+arrowup'], title: 'nudge ↑ 10' },
  { action: 'nudge.down10', keys: ['shift+arrowdown'], title: 'nudge ↓ 10' },
];

export const COMMON: Binding[] = [
  { action: 'save', keys: ['mod+s'], title: 'save' },
  { action: 'undo', keys: ['mod+z'], title: 'undo' },
  { action: 'redo', keys: ['mod+shift+z', 'mod+y'], title: 'redo' },
  { action: 'palette.macros', keys: ['mod+k'], title: 'macros' },
  { action: 'palette.prefabs', keys: ['mod+p'], title: 'prefabs' },
  { action: 'zoom.fit', keys: ['mod+0'], title: 'fit' },
  { action: 'zoom.100', keys: ['mod+1'], title: '100%' },
  { action: 'zoom.in', keys: ['+', '='], title: 'zoom +' },
  { action: 'zoom.out', keys: ['-', '_'], title: 'zoom −' },
  { action: 'node.remove', keys: ['delete', 'backspace'], title: 'delete' },
  { action: 'scope.exit', keys: ['escape'], title: 'up a level / deselect' },
  { action: 'scope.enter', keys: ['enter'], title: 'into the group / open the prefab' },
];

export const SCHEMES: Record<KeymapScheme, Binding[]> = {
  blender: [
    { action: 'op.move', keys: ['g'], title: 'move (G)' },
    { action: 'op.rotate', keys: ['r'], title: 'rotate (R)' },
    { action: 'op.scale', keys: ['s'], title: 'scale (S)' },
    { action: 'pivot.pick', keys: ['.'], title: 'pivot to the clicked point' },
    { action: 'pivot.centre', keys: ['ctrl+.', 'mod+.'], title: 'pivot to the bounds centre' },
    { action: 'tool.path', keys: ['tab'], title: 'inside: group / path contour' },
    { action: 'node.duplicate', keys: ['shift+d'], title: 'duplicate' },
    { action: 'node.hide', keys: ['h'], title: 'hide (for the session)' },
    { action: 'node.unhideAll', keys: ['alt+h'], title: 'show hidden' },
    { action: 'select.all', keys: ['a'], title: 'select all' },
    { action: 'select.none', keys: ['alt+a'], title: 'deselect all' },
    { action: 'palette.commands', keys: ['f3'], title: 'command palette' },
    ...NUDGE,
  ],
  figma: [
    { action: 'tool.select', keys: ['v'], title: 'select' },
    { action: 'tool.path', keys: ['p'], title: 'contour' },
    { action: 'node.duplicate', keys: ['mod+d'], title: 'duplicate' },
    { action: 'pivot.centre', keys: ['ctrl+.', 'mod+.'], title: 'pivot to the bounds centre' },
    { action: 'select.all', keys: ['mod+a'], title: 'select all' },
    { action: 'palette.commands', keys: ['mod+shift+p'], title: 'command palette' },
    ...NUDGE,
  ],
};

export const SCHEME_KEY = 'tml-edit-keymap';

/** The bindings of a scheme with the common ones. */
export function bindings(scheme: KeymapScheme): Binding[] {
  return [...COMMON, ...SCHEMES[scheme]];
}

/** A chord written canonically: modifiers in the order mod, ctrl, shift, alt; the key lower-case. */
export function normalizeChord(chord: string, mac: boolean): string {
  const parts = chord.toLowerCase().split('+');
  let key = parts.pop()!;
  if (key === '' && chord.endsWith('+')) key = '+'; // "+" itself
  const mods = new Set(parts.filter(Boolean));
  // on a non-Mac ⌘ is Ctrl: «mod» and «ctrl» are one key
  if (!mac && mods.has('ctrl')) {
    mods.delete('ctrl');
    mods.add('mod');
  }
  return [...['mod', 'ctrl', 'shift', 'alt'].filter((m) => mods.has(m)), key].join('+');
}

/** Chord collisions inside a scheme (with the common keys): [chord, actions]. */
export function collisions(scheme: KeymapScheme, mac: boolean): [string, Action[]][] {
  const by = new Map<string, Set<Action>>();
  for (const b of bindings(scheme)) for (const k of b.keys) {
    const c = normalizeChord(k, mac);
    if (!by.has(c)) by.set(c, new Set());
    by.get(c)!.add(b.action);
  }
  return [...by].filter(([, a]) => a.size > 1).map(([c, a]) => [c, [...a]]);
}

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The chord of a key event (letters by physical key: a Russian layout gives the same chord). */
export function chordOf(e: KeyLike, mac: boolean): string {
  let key = e.key.toLowerCase();
  if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (e.code && /^Digit\d$/.test(e.code) && (e.metaKey || e.ctrlKey)) key = e.code.slice(5);
  else if (e.code === 'Period' && (e.ctrlKey || e.metaKey)) key = '.';
  const mods: string[] = [];
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod) mods.push('mod');
  if (mac && e.ctrlKey) mods.push('ctrl');
  // Shift is part of the character for + and _ (and the like): not a modifier there
  if (e.shiftKey && !(key.length === 1 && !/[a-z0-9.]/.test(key))) mods.push('shift');
  if (e.altKey) mods.push('alt');
  return [...mods, key].join('+');
}

/** The action bound to a key event in a scheme (null — none). */
export function actionOf(e: KeyLike, scheme: KeymapScheme, mac: boolean): Action | null {
  const chord = chordOf(e, mac);
  for (const b of bindings(scheme)) if (b.keys.some((k) => normalizeChord(k, mac) === chord)) return b.action;
  return null;
}

/** The first key of an action in a scheme, for hints («G», «⌘D»); '' — unbound. */
export function keyHint(action: Action, scheme: KeymapScheme, mac: boolean): string {
  const b = bindings(scheme).find((x) => x.action === action);
  const k = b?.keys[0];
  if (!k) return '';
  return k
    .split('+')
    .map((p) => ({ mod: mac ? '⌘' : 'Ctrl+', ctrl: mac ? '⌃' : 'Ctrl+', shift: '⇧', alt: mac ? '⌥' : 'Alt+', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', escape: 'Esc', enter: 'Enter', tab: 'Tab', delete: 'Del', backspace: '⌫' })[p] ?? p.toUpperCase())
    .join('');
}

export function loadScheme(): KeymapScheme {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    return v === 'figma' ? 'figma' : 'blender';
  } catch {
    return 'blender';
  }
}

export function saveScheme(s: KeymapScheme): void {
  try {
    localStorage.setItem(SCHEME_KEY, s);
  } catch {
    // private window: the scheme lives for the page
  }
}
