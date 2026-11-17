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
 *  rest pose. speed 0.25–2; onion(on, delta = 1/12 s): frames t∓delta over the scene when paused.
 *  rec (2.3): posed + rec — edits of nodes become keys at the playhead; params — $name values for the preview. */
interface TmlAnim {
  readonly clip: string | null; readonly time: number; readonly playing: boolean; loop: boolean; speed: number; rec: boolean;
  params: Record<string, number>;
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
  /** 2.3: an md clip file as commands (clip.*, track.*, key.*, event.* — the table below), in this scene's
   *  undo: tml.clipsDoc().exec('key.move', { clip, keys, dt }); .clips() — clips as written (tracks,
   *  keys by column, events). file — default the timeline's clip's file (else the scene's first). */
  clipsDoc(file?: string): ClipsDocument | null;
  readonly clipCommands: typeof clipCommands;
  /** 2.3: inspectors of the folder's trempel.view.ts by tml:type, e.g. tml.inspect.fx — effects (kit). */
  readonly inspect: Record<string, any>;
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
| `node.setId` | `node`: string, `id`: string | Rename a node; clip-path="url(#…)" references in the document and the clips' references (## $track, $path, fx:…@id events) are updated. |
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
| `heir.setAttr` | `node`: string, `name`: string, `value`: string \| number \| null | Effects only (2.3): set an attribute of an element of the heir — data-effect, data-scale, transform… of an fx node the heir inserts, tml:* of a `<tml:ref>` (one is added for a tml:* attribute of a base node the heir does not reference yet). value null — remove. |
| `heir.insertFx` | `into`: string, `id`: string, `effect`: string, `x?`: number, `y?`: number, `scale?`: number | Effects only (2.3): a new effect node in the heir — `<g id tml:insert="into <into>`" tml:type="fx" transform="translate(x y)" data-effect>, at (x, y) of the group's space. |

## Clips — `tml.clipsDoc(file?).exec(name, args)`

The scene's md clips (`anim/*.md`, `X.anim.md`) are edited by commands with a minimal diff of the md; each is one undo step in the scene's history (with the base), saved by ⌘S / `tml.save()`. `file` — default the clip on the Timeline (else the scene's first file). A command that adds compile errors is refused (`ok: false`). Keys are addressed `{ target, column, t }`; events `{ t, event }`. Read the clip as written: `tml.clipsDoc().clip('win')` → `{ tracks: [{ target, columns, keys: { x: [{ t, value, ease, param? }] } }], events, duration, loop }`.

| command | arguments | what it does |
|---|---|---|
| `clip.create` | `name`: string, `duration?`: number, `loop?`: boolean | Create an empty clip (# $clip `<name>`) at the end of the file; duration — $duration (s), loop — $loop. |
| `clip.rename` | `clip`: string, `name`: string | Rename a clip. |
| `clip.remove` | `clip`: string | Remove a clip with its tracks and events. |
| `clip.duplicate` | `clip`: string, `name`: string | Copy a clip under a new name, right after it. |
| `clip.setAttr` | `clip`: string, `name`: 'duration' \| 'loop' \| 'tex', `value`: number \| boolean \| string \| null | A clip attribute: duration ($duration, seconds), loop ($loop), tex ($tex template); value null — remove it. |
| `track.add` | `clip`: string, `target`: string, `columns?`: 'x' \| 'y' \| 'rotation' \| 'scale' \| 'scaleX' \| 'scaleY' \| 'skewX' \| 'skewY' \| 'alpha' \| 'tint' \| 'z' \| 'tex' \| 'view' \| 'motion' \| 'dash' \| 'strokeWidth' \| 'strokeAlpha' \| 'width' \| 'height'[] | A new track (## $track `<target>`) in a clip, with a table of these value columns (t and ease added) and no keys yet. |
| `track.remove` | `clip`: string, `target`: string, `index?`: integer | Remove the tracks of a target from a clip (index — only that table of the target). |
| `track.retarget` | `clip`: string, `target`: string, `to`: string, `index?`: integer | Point a target's tracks at another node (index — only that table of the target). |
| `track.setAttr` | `clip`: string, `target`: string, `index?`: integer, `name`: 'path' \| 'orient' \| 'orient-offset' \| 'offset' \| 'tex', `value`: number \| string \| null | A track attribute: path ($path, a geometry id for motion), orient (auto), orient-offset (degrees), offset ("dx, dy"), tex (template); value null — remove it. |
| `key.set` | `clip`: string, `target`: string, `column`: 'x' \| 'y' \| 'rotation' \| 'scale' \| 'scaleX' \| 'scaleY' \| 'skewX' \| 'skewY' \| 'alpha' \| 'tint' \| 'z' \| 'tex' \| 'view' \| 'motion' \| 'dash' \| 'strokeWidth' \| 'strokeAlpha' \| 'width' \| 'height', `t`: number, `value`: number \| string, `ease?`: 'linear' \| 'in' \| 'out' \| 'inOut' \| 'outBack' \| 'inBack' \| 'outBounce' \| 'step' \| 'quadIn' \| 'quadOut' \| 'quadInOut' \| 'cubicInOut' \| 'backOut' \| 'elasticOut' \| number[] \| null | Set a key: the value of column at time t of the target in a clip — the track, the column and the row are created when missing (a new row takes the ease of the row before it). value: a number, #rrggbb (tint), a name (tex, view) or $name (a clip parameter). |
| `key.remove` | `clip`: string, `keys`: object[] | Remove keys (cells); a row left without values is removed, a track left without rows too. |
| `key.move` | `clip`: string, `keys`: object[], `dt`: number, `snap?`: boolean | Move keys by dt seconds (a selection — one step). snap (default true): the new times stick to other keys within 2 frames, else to frames of 1/60 s. A key landing on another key of its column is an error. |
| `key.setEase` | `clip`: string, `keys`: object[], `ease`: 'linear' \| 'in' \| 'out' \| 'inOut' \| 'outBack' \| 'inBack' \| 'outBounce' \| 'step' \| 'quadIn' \| 'quadOut' \| 'quadInOut' \| 'cubicInOut' \| 'backOut' \| 'elasticOut' \| number[] \| null | The ease of keys (from the key to the next key of its column). The format keeps one ease per table row: the other values of the row share it. |
| `key.setParam` | `clip`: string, `target`: string, `column`: 'x' \| 'y' \| 'rotation' \| 'scale' \| 'scaleX' \| 'scaleY' \| 'skewX' \| 'skewY' \| 'alpha' \| 'tint' \| 'z' \| 'tex' \| 'view' \| 'motion' \| 'dash' \| 'strokeWidth' \| 'strokeAlpha' \| 'width' \| 'height', `t`: number, `param`: string \| null, `value?`: number | Make a key a clip parameter (param: the name, cell $name — given at play time) or a number again (param: null, value: the number). |
| `event.add` | `clip`: string, `t`: number, `event`: string | Add an event ($events) at t: a name the game handles, e.g. sfx:stamp, or fx:`<effect>`@`<node>` — an effect at a node of the scene. |
| `event.remove` | `clip`: string, `events`: object[] | Remove events (by time and name); the $events block goes when it is empty. |
| `event.move` | `clip`: string, `events`: object[], `dt`: number, `snap?`: boolean | Move events by dt seconds (snap — to frames of 1/60 s and to keys within 2 frames, default true). |
| `event.set` | `clip`: string, `event`: object, `name?`: string, `t?`: number | Change one event: its name (name) and / or its time (t). |

## Effects — `tml.inspect.fx` (the kit's `kitView()`), `heir.*`

Effect nodes (`tml:type="fx"`) are configured in the heir: `heir.setAttr` (`data-effect` / `data-scale` / `transform` of a node the heir inserts, `tml:effect` of a `<tml:ref>`), a new one — `heir.insertFx`. The effects themselves (particle configs) — `tml.inspect.fx`: `list()` (`{ name, origin: file | systems | preset | code }`), `origin(name)`, `get(name)`, `update(name, fn)` (the preview plays it), `save(name)` (`fx/<name>.json` whole, a converter's `systems.json` — only that effect's systems), `extract(name)` (a preset / an effect from code → `fx/<name>.json`), `unsaved()`.

## Examples

```js
tml.nodes().filter(n => n.tag === 'image').length              // how many images
tml.doc.exec('node.move', { node: 'settingsBtn', dx: 10, dy: 0 })
for (const id of tml.selection) tml.moveBy(id, 0, -20)          // the selection up by 20 scene units
tml.doc.errors                                                   // contract, geometry, clips — after every command
await tml.save()

// «move every key of the track card by 0.2 s»
const d = tml.clipsDoc(), tr = d.clip('collect').tracks.find((t) => t.target === 'card')
d.exec('key.move', { clip: 'collect', keys: tr.columns.flatMap((column) => tr.keys[column].map((k) => ({ target: 'card', column, t: k.t }))), dt: 0.2 })
// «put fx:fdFound@spot1 at 0.8»
tml.clipsDoc().exec('event.add', { clip: 'collect', t: 0.8, event: 'fx:fdFound@spot1' })
// «double the rate of fdHintButton» (and save it into its file)
tml.inspect.fx.update('fdHintButton', (c) => { for (const s of c) s.rate *= 2 }); await tml.inspect.fx.save('fdHintButton')
```

From outside the page — the same scripts into the page a person has open: `npx trempel-edit eval [--port 5181] '<code>'` (`--file x.js`), `trempel-edit save`, `trempel-edit state`; `trempel-edit mcp` — an MCP server (stdio) with `editor.eval`, `editor.save`, `editor.state`. An agent's script is one undo step, marked «agent» in the log.
