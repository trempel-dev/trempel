# tml — the scene editor API for scripts

<!-- Generated: npm run editor:commands (from edit/app/tml.ts and the command registry). Do not edit by hand. -->

`window.tml` is the Trempel scene editor as one object: the console (the Console tab, ⌘Enter), macros (`<scene folder>/.trempel/macros/*.js`, ⌘K), an agent (`tml.run(code)`). What gets edited is the scene **base** (`X.svg`, vanilla SVG), and only through core commands — `tml.doc.exec(name, args)`. A node is an `id` or a path of element indices from the root (`"0/3/1"`). Command coordinates are in the node's **parent** space; `tml.bounds` and `tml.moveBy` use **scene** units (the viewBox).

- A script is the body of an async function with `tml` and `console`; a single expression is returned as is. A whole `tml.run` is **one** undo entry; an exception rolls it all back. A command error is not an exception: `{ ok: false, errors }`.
- After commands the scene is redrawn asynchronously: `bounds` and `scene` are from the last render, fresh ones after `await tml.idle()`.
- A macro is the same script in a file, its first line `// name: Title`.

```ts
/** Bounds in scene units (the root <svg>'s viewBox space). */
interface TmlBounds { x: number; y: number; width: number; height: number }
/** A macro: `<scenes>/.trempel/macros/<file>.js`, first line `// name: <title>`. */
interface TmlMacro { name: string; title: string; file: string }
/** RGBA pixels row by row (like ImageData). */
interface TmlPixels { width: number; height: number; data: Uint8ClampedArray }
/** A compiled clip of the scene (anim/*.md, *.anim.md — the md clip itself; `$tex` maps tex cells). */
interface TmlClip { name: string; file: string; duration: number; clip: AnimClip }
/** Clips on the stage, own clock (exact pause/seek). Posed — the stage is read-only; stop() — the
 *  rest pose. speed 0.25–2; onion(on, delta = 1/12 s): frames t∓delta over the scene when paused. */
interface TmlAnim {
  readonly clip: string | null; readonly time: number; readonly playing: boolean; loop: boolean; speed: number;
  play(name?: string): void; pause(): void; seek(t: number): void; stop(): Promise<void>; onion(on: boolean, delta?: number): void;
}
/** Reference picture under/over the scene, fitted to the viewBox, opacity 0–100; not saved to the
 *  file. pixels(box) — the picture at the viewBox's 1:1 size, cropped to a box in scene units. */
interface TmlReference {
  readonly file: string | null; readonly opacity: number; readonly over: boolean;
  set(file: string | null, opts?: { opacity?: number; over?: boolean }): Promise<void>;
  pixels(box?: TmlBounds): Promise<TmlPixels | null>;
}
interface Tml {
  /** Core document of the open scene: exec(name, args), batch(label, calls), undo(), redo(),
   *  tree() ([{ id?, tag, path, children }]), scene (SceneNode: tag, attrs, children, text),
   *  errors, serialize(), dirty, history. null — no scene open. */
  readonly doc: EditorDocument | null;
  /** Command registry: { [name]: { schema, describe } } — see the table below. */
  readonly commands: typeof commands;
  /** Runtime of the last render: byId, getBounds, path(id) — read-only, redrawn after commands. */
  readonly scene: MountedScene | null;
  /** Open scene id ("game", "popups/map"). */
  readonly sceneId: string | null;
  /** Every element of the base, flat, depth-first (doc.tree() is nested: [root]). */
  nodes(): TreeNode[];
  /** Selected nodes: id when unique, else index path ("0/3/1"). */
  readonly selection: string[];
  /** Select nodes by id or index path ([] — clear); returns the new selection. */
  select(nodes: string | string[]): string[];
  /** Node's bounds in scene units from the last render (await tml.idle() after commands). */
  bounds(node: string): TmlBounds | null;
  /** node.move by (dx, dy) in SCENE units (converted to the node's parent space). */
  moveBy(node: string, dx: number, dy: number): CommandResult | null;
  /** G/R/S as the keys, one undo step: op('G', { axis: 'x', value: 120 }) — along the node's local X (several: global;
   *  space, exclude), op('R', { value: -45 }), op('S', { axis: 'y', value: 1.5 }) about the pivot (data-pivot / bounds
   *  centre); op('.', { x, y }) / op('ctrl+.') — set the pivot. nodes — default the selection; null — no change. */
  op(name: 'G' | 'R' | 'S' | '.' | 'ctrl+.', opts?: { axis?: 'x' | 'y' | null; value?: number; space?: 'local' | 'global'; exclude?: boolean; x?: number; y?: number; nodes?: string[] }): CommandResult | null;
  /** Resolves when the newest state is drawn and measured. */
  idle(): Promise<void>;
  /** Save the base (X.svg) to disk. */
  save(): Promise<boolean>;
  /** Open another scene of the folder (asks about unsaved changes). */
  open(sceneId: string): Promise<boolean>;
  /** Scene ids of the folder. */
  scenes(): string[];
  /** Run a script (body of an async function with `tml` and `console` in scope; a single
   *  expression is returned) as one undo step `label`; an exception rolls it all back. */
  run(code: string, label?: string): Promise<unknown>;
  /** Clips of the scene and their compile errors; playback — anim; the reference layer. */
  readonly clips: TmlClip[];
  readonly clipErrors: string[];
  readonly anim: TmlAnim;
  readonly reference: TmlReference;
  /** The scene's viewBox (scene units). */
  viewBox(): TmlBounds;
  /** The scene as drawn now (no reference/onion/handles) at the viewBox's 1:1, cropped to a box
   *  in scene units; background — the stage's, else #18181c. */
  pixels(box?: TmlBounds): Promise<TmlPixels>;
  /** "Video snapshot": the rest pose (a clip is stopped) at 1:1 on `background` (null —
   *  transparent; omitted — the panel's) → renders/<scene>-<time>.png; returns its path. */
  snapshot(opts?: { background?: string | null }): Promise<string>;
  /** Prefabs (v0.9): list() — scenes to place ("ui/button.svg"; v1.1 — a collection's too, "@skin/button.svg"); place(prefab, at?) — a <use> at a scene
   *  point (default: view centre), selected; open(node) — its prefab; extract(node, href) — <g> → prefab. */
  readonly prefabs: { list(): string[]; place(prefab: string, at?: { x: number; y: number }): Promise<CommandResult | null>; open(node: string): Promise<boolean>; extract(node: string, href: string): Promise<CommandResult | null> };
  /** Macros of the folder: list, run by name (file name or title), re-read. */
  readonly macros: {
    list(): Promise<TmlMacro[]>;
    run(name: string): Promise<unknown>;
    reload(): Promise<TmlMacro[]>;
  };
}
```

## Commands — `tml.doc.exec(name, args)`, as a batch — `tml.doc.batch(label, [{ name, args }])`

| command | arguments | what it does |
|---|---|---|
| `node.setAttr` | `node`: string, `name`: string, `value`: string \| number \| null | Set a node attribute (value: null — remove it). tml:* are not allowed in the base; id — via node.setId. |
| `node.setId` | `node`: string, `id`: string | Rename a node; clip-path="url(#…)" references in the document are updated, clips get a warning. |
| `node.setText` | `node`: string, `text`: string | Replace the text of a `<text>` (the base's mock-up string; a binding in the heir overrides it). |
| `node.move` | `node`: string, `dx`: number, `dy`: number | Move a node by (dx, dy) in its parent's coordinates: translate on a `<g>`, x/y, cx/cy, x1…y2, the points of d. |
| `node.setTransform` | `node`: string, `translate?`: [x, y], `rotate?`: number, `scale?`: number \| [x, y], `pivot?`: [x, y] | Rebuild transform from parts: translate(t+pivot) rotate scale translate(-pivot). No parts — transform is removed. pivot defaults to the node's data-pivot. |
| `node.setPivot` | `node`: string, `x`: number, `y`: number, `keepWorld?`: boolean | The node's pivot (data-pivot="x y", in its own space before transform): rotation and scale go around it — by handles, clips, setTransform. keepWorld (default true) — the node stays in place (same matrix); false — the transform parts (translate, rotate, scale) keep their numbers but now turn around the new pivot (the node shifts). |
| `node.resize` | `node`: string, `width?`: number \| null, `height?`: number \| null | Node size (v1.0): `<image>` — width/height (with data-slices it is the panel size, borders 1:1), `<rect>` — width/height, `<g data-size>` — data-size, an instance of a resizable prefab (`<use>`, data-resizable) — width/height along its axes (null — remove: the minimum size). An axis without a value is left as is. |
| `node.reorder` | `node`: string, `index`: integer | Put a node at position index among its siblings (z-order: 0 — the bottom). |
| `node.reparent` | `node`: string, `parent`: string, `index?`: integer | Move a node to another parent (index — its position among the children, default last); the world position is kept. |
| `node.insert` | `parent`: string, `index?`: integer, `xml`: string | Insert an XML fragment (exactly one element) into parent at position index (default last). |
| `node.remove` | `node`: string | Remove a node with its subtree. |
| `node.duplicate` | `node`: string, `idSuffix?`: string | A copy of a node right after it; ids in the copy get a suffix (default -2, -3… up to a free one). |
| `path.setData` | `node`: string, `d`: string | Replace the whole d of a path. |
| `path.setPoint` | `node`: string, `index`: integer, `x`: number, `y`: number | Move point index of the path (its handles move with it). |
| `path.setHandle` | `node`: string, `index`: integer, `which`: 'in' \| 'out', `x`: number, `y`: number, `linked?`: boolean | Place a Bézier handle of point index (which: in — incoming, out — outgoing); linked — mirror the opposite one. |
| `path.insertPoint` | `node`: string, `segment`: integer, `t`: number | Split segment segment at t (0<t<1) keeping the shape; segments are the L/C in order and the closing line of Z. |
| `path.removePoint` | `node`: string, `index`: integer | Remove point index; the neighbouring segments are joined into one. |
| `path.close` | `node`: string, `subpath?`: integer | Close a subpath (Z); subpath — its number, default the last. |
| `path.open` | `node`: string, `subpath?`: integer | Open a subpath (remove Z); subpath — its number, default the last. |
| `path.setNodeType` | `node`: string, `index`: integer, `type`: 'corner' \| 'smooth' | Node type of point index: smooth — align the handles on one line (lengths kept), corner — independent handles. |
| `defs.ensure` | — | Create `<defs id="defs">` as the first child of the root, if there is none. |
| `clip.create` | `id`: string, `shape`: 'rect' \| 'path', `attrs`: object | Create a `<clipPath id>` in `<defs>` with one shape (shape: rect \| path, attrs — its attributes: x y width height rx \| d). |
| `clip.assign` | `node`: string, `clip`: string \| null | Mask a node (`<g>`, `<image>`): clip-path="url(#clip)"; clip: null — remove the mask. |
| `layer.create` | `parent?`: string, `id`: string, `index?`: integer | Create an empty layer `<g id>` in parent (default the root) at position index (default last). |
| `prefab.instantiate` | `parent?`: string, `href`: string, `id`: string, `x?`: number, `y?`: number, `params?`: object, `index?`: integer | Place a prefab instance: `<use id href x y data-*>` in parent (default the root) at position index (default last). |
| `prefab.setParam` | `node`: string, `name`: string, `value`: string \| null | An instance parameter: data-`<name>` on the `<use>` (value: null — remove it, the prefab default applies). |
| `prefab.detach` | `node`: string | Turn an instance into a copy: a `<g>` with the prefab content (prefixed ids stay, nested instances stay `<use>`); the link to the prefab is broken, there is no way back. |
| `prefab.extract` | `node`: string, `href`: string, `params?`: object[] | The selected `<g>` → a new prefab href (a base file, with params also an heir) + a `<use>` in its place. params: which image hrefs / texts of the children become parameters. |

## Examples

```js
tml.nodes().filter(n => n.tag === 'image').length              // how many images
tml.doc.exec('node.move', { node: 'settingsBtn', dx: 10, dy: 0 })
for (const id of tml.selection) tml.moveBy(id, 0, -20)          // the selection up by 20 scene units
tml.doc.errors                                                   // contract, geometry, clips — after every command
await tml.save()
```
