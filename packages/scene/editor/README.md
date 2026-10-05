# @trempel/scene/editor — the scene editor core

No browser DOM and no Pixi: it runs in Node (tests, a headless agent) and in the browser. The document is an XML DOM of the **base** (`@xmldom/xmldom`) that remembers the source text: with no commands `serialize()` returns the source byte for byte, and an edit changes only its own attributes. Spec — `../trempel.dev/specs/editor-core.md`.

```ts
import { openDocument, commands } from '@trempel/scene/editor';

const doc = openDocument(svg, { contract, heir, clips: { 'anim/x.md': md }, path: 'scenes/game.svg' });
doc.exec('node.move', { node: 'backBtn', dx: 10, dy: 0 });   // { ok, changed, errors?, warnings? }
doc.batch('lay out', [{ name: 'node.move', args: {…} }, …]);   // one undo entry; an error rolls back the whole batch
doc.begin('script'); …; doc.end();                              // everything in between is one undo entry (awaits inside are fine; nested groups join the outer one); doc.abort() rolls the group back
doc.undo(); doc.redo(); doc.history;                           // [{ label, at }]
doc.errors;      // contract + tml in the base + ids + geometry + heir merge + clips — after every command
doc.scene;       // SceneNode of the base; doc.merged — with the heir
doc.serialize(); // the base SVG; doc.dirty / doc.markClean()
doc.tree();      // [{ id?, tag, path: "0/3", children, bounds? }] — the UI fills bounds
doc.on('change', (e) => …);                                    // exec | batch | undo | redo
commands;        // { [name]: { schema: JSONSchema7, describe } } — tools for the UI and an agent
```

- A node is addressed by `id` or by the index path of elements from the root (`"0/3/1"`; `""` — the root).
- Coordinates are the node's parent space; screen ↔ local is the UI's business.
- Numbers are written with ≤ 2 decimals (`matrix()`/`scale()` coefficients — 6).
- Path commands work on absolute `M L C Z`: on the first edit relative commands and `H V S T Q A` are rewritten (arcs — as cubics), and `warnings` says so. Points (`index`) — every M/L/C; segments (`segment`) — every L/C and a non-zero closing line of Z.
- An argument (schema) or command error — `ok: false`, the document is not changed. Validation errors do not block: the command is applied, the problem lands in `doc.errors`.
- Every message starts with its code — `E_CODE: text` (warnings — `W_CODE: text`); the editor's codes are `E_EDITOR_…` / `W_EDITOR_…` in the catalog `src/codes.ts`. Match codes, not wording: `codeOf(message)` from `@trempel/scene/core`.

### Prefabs (v0.9)

```ts
const doc = openDocument(svg, { heir, contract, path: 'menu.svg', loadScene: (rel) => ({ base, heir?, contract? }) | null });
doc.merged;                       // the scene with expanded instances (<use> → <g>, ids like "btn/label")
doc.instance('playBtn');          // { id, href, params: [{ name, value, own, required, default? }], missing, expanded }
doc.exec('prefab.instantiate', { href: 'ui/button.svg', id: 'ok', x: 10, y: 20, params: { label: 'OK', action: 'close' } });
const r = doc.exec('prefab.extract', { node: 'badge', href: 'ui/badge.svg' }); // r.files — [{ path, text }]: the host writes them
doc.refresh();                    // a prefab changed on disk — validate again (the loader already returns the new text)
```

- `loadScene(rel)` is synchronous: `rel` is a path relative to the scene's folder; the host keeps a cache (the editor page — `Editor.loadPrefabs`).
- An instance in the base is a single vanilla `<use>`; its insides are edited in the prefab. `node.move` moves a `<use>` by `x`/`y`.
- `detach` copies the expanded content into the base (`<g>`, prefixed ids; nested instances stay `<use>`); the logic of the prefab's heir is not carried into the base (sterility) — static labels (`self.label` from a plain parameter) are baked in, the rest gets a warning.
- `extract` creates files and the document sees them at once (validation); undo reverts the document edit, the files stay (the host wrote them).

## Commands

<!-- BEGIN commands (scripts/editor-commands.mjs) -->
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
<!-- END commands -->

The list above is generated: `npm run editor:commands`.
