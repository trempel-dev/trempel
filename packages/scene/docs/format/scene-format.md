# Trempel scene format — v1.3

> **For agents.** This file is the format: what a scene, an heir, a contract, a prefab and an md clip
> are, and how they combine. Every message of the runtime and the tools starts with a code
> (`E_EXPR_UNDEF: …`, `W_COMPAT_GML: …`) — the codes and their meaning are in
> [§16 Error codes](#16-error-codes) (from `src/codes.ts`); match codes, never the wording. The
> stable API is in [§15](#15-public-api). The examples of this document (the `svg`, `xml`, `md` and
> `mdz` blocks) are checked by tests at every build (`test/spec.test.ts`): a block marked
> `error=E_CODE` must fail with exactly that code, every other block must pass.

This is the single, current specification of the Trempel scene format, as implemented by the
npm package `@trempel/scene` 2.3 (format 1.3). The examples of this document
are checked by tests at every build.

Trempel is an agent-first 2D engine on PixiJS. The format comes first, the editor second: scenes
are plain text that an agent (or a person) writes and reviews, and that any SVG tool can open.

| Entry point | What it is |
|---|---|
| `@trempel/scene` | the stable API (§15): the core plus `PixiBackend`; `mountAsync` fetches prefabs by default |
| `@trempel/scene/core` | the same without `pixi.js`: parse, compose, mount over any backend, contract, clips, collections, flatten, check — for CLIs, level tools, tests |
| `@trempel/scene/node` | Node side (v1.1): the project file and its collections on disk, `flattenFile`; bin `trempel-flatten` |
| `@trempel/scene/view` | `defineView` — the consumer module `trempel.view.ts` (§11) |
| `@trempel/scene/editor` | the editor core: a document model with undoable commands |
| `@trempel/scene/edit` | the editor app (page, style sheet, library entry) |
| `@trempel/scene/browser`, `…/browser/core`, `…/browser/editor` | the same as browser bundles |
| `@trempel/scene/internal/*` | everything else (geometry, hit test, dashes, attribute parsers, expressions…) — for the kit and the editor, **no stability promise** |

Runtime dependencies are `@xmldom/xmldom` and `svg-path-properties`; `pixi.js` (^8.19) is an
optional peer. No part of the runtime uses `eval` or `new Function`: scenes run under a strict
Content Security Policy.

---

## 1. Principles

1. **The base is vanilla SVG.** It opens — and, crucially, *saves* — in any SVG editor without
   losing logic, because it contains none. A browser shows it as the static mock-up.
2. **Logic lives in a second document** (the heir), which inherits the base and adds behaviour.
   Design tools never touch it.
3. **A contract states what the logic expects from the view** — structure, never appearance.
4. **Where SVG already has a notation, use it** (`<use href>`, `clip-path`, `mix-blend-mode`,
   `stroke-dasharray`, `display`). What SVG lacks is a `data-*` attribute in the base — appearance
   of the rig, which logic does not touch.
5. **Strict subset.** What the format cannot read is an error, never silently dropped.
6. **Errors are collected, not thrown one at a time**, and phrased for a person, each with its
   code ("`E_CONTRACT_EMPTY: #board must be an empty group — it has 3 children; the component will
   overwrite them`"), with the node (`#id` or `<tag>`), the file and, for expressions, a position
   with a caret. Tools and tests match the code (§16), never the wording.
7. At the reference size, a scene looks exactly like the base SVG in a browser. Runtime-only
   features (anchors, stretch, pivots, tint) change nothing at the reference size or in the
   SVG matrix.

---

## 2. What a scene is

A scene is named by its stem `X` (a path relative to the folder, e.g. `popups/pause`). Files:

| File | Role | Required |
|---|---|---|
| `X.svg` | **base** — vanilla SVG, edited by people, design tools, agents | yes, unless the heir extends another scene (§6.5) |
| `X.tml.svg` | **heir** — logic: refs, inserts, bindings, events, components, slots | no |
| `X.contract.xml` | **contract** — the brief / validator of the view | no |
| `X.state.json` | stand-in state for the viewer and editor (the reactive `state`) | no |
| `anim/*.md` (next to the scene), `*.anim.md` (in the scene's folder) | **md clips** — animation tables | no |

Any scene is also a prefab (§6): there is nothing special in a prefab's files.

Pipeline of one scene (`composeScene`, `mount`):

1. parse the base (or resolve the `tml:extends` chain);
2. expand `<use>` instances (recursively);
3. check the contract against this pre-heir tree;
4. merge the heir (`<tml:ref>`, `tml:insert`, root `data-*`);
5. expand instances the heir inserted; check slots and resizable prefabs;
6. check geometry, presentation/layout attributes and expressions over the final tree;
7. build onto the backend: nodes, bindings, events, components, layout.

Steps 2–6 report into one list; `mount()` throws them together as a `TrempelError`
(`.errors: string[]` — `E_CODE: message` each, deduplicated; `.codes`, `.code` — the first).
`checkScene()` runs the same pipeline without a backend and returns the list. `composeScene()` returns them by stage
(`{ parse, prefab, contract, merge }`) without throwing — for viewers, checkers and the editor.

---

## 3. The base (`X.svg`)

### 3.1 Elements

Root: `<svg>` (anything else is a parse error). Allowed elements:

| Element | Notes |
|---|---|
| `svg` | root only |
| `g` | group |
| `image` | `href`, `x`, `y`, `width`, `height` |
| `text` | single run of text (no `<tspan>`, no multi-line) |
| `rect` | `x`, `y`, `width`, `height`, `rx`, `ry` |
| `path` | `d` |
| `circle` | `cx`, `cy`, `r` |
| `ellipse` | `cx`, `cy`, `rx`, `ry` |
| `line` | `x1`, `y1`, `x2`, `y2` (stroke only — a line has no fill) |
| `defs` | service geometry, not drawn (§3.6) |
| `clipPath` | geometric mask, inside `defs` (§3.7) |
| `use` | a prefab instance (§6) |

Anything else is a parse error listing what is supported; `<mask>` hints at `<clipPath>`,
`<polygon>`/`<polyline>` hint at `<path>`.

**No DTD.** A `<!DOCTYPE …>` or an `<!ENTITY …>` in any document of the format (base, heir,
prefab, contract) is an error before the XML is parsed — `E_DOCTYPE`: a scene never needs one, and
entity expansion and external entities are refused outright.

```svg error=E_DOCTYPE
<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>&b;</text></svg>
```

**Sterility invariant.** The base carries **no `tml:*` attribute** — checked on every mount and by
the checker, not left to discipline. The only link between base and logic is node `id`s. Ids are
unique in the document. Text content in the base is mock-up copy; bindings overwrite it at run time.

### 3.2 Transforms and placement

`transform` is parsed into one affine matrix, SVG semantics: `matrix(a b c d e f)`,
`translate(x [y])`, `scale(sx [sy])`, `rotate(deg [cx cy])`, `skewX(deg)`, `skewY(deg)`; chains in
any order (the rightmost applies to the point first); arguments separated by spaces and/or commas.
An unknown function or a wrong argument count is an error. `x`/`y` of an element lie *inside* its
transform: local matrix = `transform · translate(x, y)`.

### 3.3 Presentation attributes

| Attribute | Where | Runtime meaning |
|---|---|---|
| `opacity` | any drawn node | alpha |
| `display="none"`, `visibility="hidden"` | any drawn node | hidden; hidden geometry is still hit-tested and measurable |
| `fill`, `fill-opacity` | text, shapes | any CSS colour (`#rgb`, `#rrggbbaa`, names, `rgb()`); `fill="none"`; SVG default black |
| `fill-rule` | `path` | holes by contour orientation (no exact `evenodd`/`nonzero` emulation) |
| `stroke`, `stroke-width`, `stroke-opacity` | text, shapes | SVG defaults: no stroke, width 1 |
| `stroke-linecap` | shapes | `butt` \| `round` \| `square` |
| `stroke-linejoin` | shapes | `miter` \| `round` \| `bevel` |
| `stroke-dasharray` | shapes | non-negative plain numbers (space/comma separated) or `none`; odd lists repeat; all zeros = solid; restarts on each subpath |
| `stroke-dashoffset` | shapes | a number; positive shifts the pattern back |
| `pathLength` | shapes | positive number: dash lengths and offset are in these units |
| `font-family`, `font-size` (px), `font-weight`, `font-style`, `letter-spacing` | text | — |
| `text-anchor` | text | `start` \| `middle` \| `end` |
| `dominant-baseline` | text | default: `y` is the **baseline**; `middle`/`central` → centre; `hanging`/`text-before-edge` → top |
| `clip-path` | `g`, `image` | `url(#id)` of a `<clipPath>`, or `none` (§3.7) |
| `style` | `g`, `image`, shapes | **only** `mix-blend-mode: normal \| plus-lighter \| multiply \| screen`; any other property is an error ("styles are attributes") |
| `preserveAspectRatio` | `image` with `width` and `height` | 1.3: how the picture fits its box — `<align> slice` covers it (the picture is cut), `<align> meet` contains it (whole, aligned in the box); `<align>` is `xMinYMin` … `xMaxYMax`, `meet` by default; `none` — fills the box (as without the attribute) |

"Shapes" = `path`, `circle`, `ellipse`, `line`, `rect`. Stroke dash/cap/join/`pathLength` on any
other tag is an error; units and percentages are errors. Not supported: `tspan`, non-px font sizes,
`vector-effect`, `stroke-miterlimit`, CSS `filter`, soft masks.

An image fills its box (`width` × `height`) — without `preserveAspectRatio` it is stretched, unlike
SVG's default (`xMidYMid meet`). With it the box keeps its size and the picture keeps its
proportions: a background stretched over any screen (`data-stretch`, §8.1) covers it without
distortion. A malformed value, or one on an `<image data-slices>` / `data-tile` (they fill the box by
their own rules) — `E_ASPECT`; on the root `<svg>` it is the document's own and is ignored.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920">
  <image id="bg" href="art/bg.png" width="1080" height="1920" data-stretch="xy"
         preserveAspectRatio="xMidYMid slice"/>
  <image id="logo" href="art/logo.png" x="140" y="200" width="800" height="400"
         preserveAspectRatio="xMidYMin meet"/>
</svg>
```

```svg error=E_ASPECT
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <image id="panel" href="art/panel.png" width="400" height="200" data-slices="24"
         preserveAspectRatio="xMidYMid slice"/>
</svg>
```

`mix-blend-mode` on a group applies to every built node of its subtree; a node's own mode wins
(including `normal` under `plus-lighter`). Not on `text`. Not bindable (`tml:bind-style` is an error).

### 3.4 `data-*` attributes of the base

All of these are appearance of the rig and belong to the base; the heir does not set them.

| Attribute | On | Meaning |
|---|---|---|
| `data-tint="#rrggbb"` | `image`, `g` | multiply tint (`#rgb` accepted; white = none). A group tints the **images** of its subtree (not shapes or text); an image's own tint wins |
| `data-z="<int>"` | any drawn node | order among **siblings** (the tree does not change); equal values keep document order; siblings without it keep their index |
| `data-views="name:href, name:href"` | `image` | named sprite variants; names `[A-Za-z0-9_.-]`, unique; `href` itself is the default variant |
| `data-pivot="x y"` | any drawn node | rotation/scale origin in the node's own space (before `transform`; for `image`/`rect`/`text` — the space of `x/y/width/height`). Does **not** change the SVG matrix — the browser draws the same; clips rotate/scale around it, `motion` puts the pivot on the path |
| `data-slices="l t r b"` | `image` | 9-slice borders in **file pixels**: 1 value = all four, 2 = `horizontal vertical`, 4 = left top right bottom; ≥ 0 (§8.2) |
| `data-tile="x\|y\|xy"` | `image` | tiling along those axes, stretched along the other; not with `data-slices` (§8.2) |
| `data-anchor="ax ay"` | direct child of a box | anchor in 0..1 (§8.1) |
| `data-stretch="x\|y\|xy"` | `image`, `rect`, `g[data-size]`, instance of a resizable prefab | grows with its box along those axes (§8.1) |
| `data-size="w h"` | `g` | makes the group a box with that reference size (§8.1) |
| `data-resizable="x\|y\|xy"` | root `<svg>` of a prefab only | the prefab can be sized along those axes (§6.6); elsewhere an error |
| `data-<param>` | root `<svg>` | prefab parameter defaults (§6.2) |
| `data-<name>` | a component node | component parameter, read by `ctx.param(name)` (§4.3) |

`data-z`/`data-pivot` on `svg`, `defs`, `clipPath` are errors (those are not drawn). Malformed values
are errors with the expected form. `yx` is accepted for `xy`.

### 3.5 Geometry data

`d` supports `M L H V C S Q T A Z` in both cases, implicit repeats (pairs after `M` are `L`),
compact numbers (`10-5.5.5`) and packed arc flags. It is parsed by the core's own strict parser
(`parsePathData`): anything unrecognised is an error with the node and position; an empty `d` is an
error. Normal form (what the renderer, lengths and exporters get): absolute `M L C Q A Z`
(`H/V → L`, `S → C`, `T → Q` with the reflected control point, a zero-radius arc → `L`).

### 3.6 `<defs>` — service geometry

- Only as a direct child of the root. Children: `path`, `circle`, `ellipse`, `line`, `rect`, `g`
  (with the same set), `clipPath`.
- Never built: the backend does not see it, `MountedScene.byId` has none of its nodes. Geometry is
  measured through `MountedScene.path(id)`; clips reference it by id (`$path: fly1`); a contract may
  require it (`<path id="fly1"/>`).
- Nothing inside `defs` is bound: `<tml:ref>` onto it, or a `tml:*` attribute on a node inserted
  into it, is an error. To insert into `defs` the base's `<defs>` needs an id
  (`tml:insert="into defs"` with an id-less `<defs>` says so).

### 3.7 Masks — `<clipPath>` / `clip-path`

- `<clipPath id>` only inside `defs`, with an id; children `path`, `rect`, `circle`, `ellipse`, `g`
  of those (`line` has no area — error). Transforms of the clipPath, its groups and shapes compose.
  `clipPathUnits` only `userSpaceOnUse` (the default).
- `clip-path="url(#m)"` or `"none"` on `g` and `image` only. Another tag, a dangling reference, a
  reference to a non-clipPath, any other value — error.
- SVG semantics: the mask geometry is in the coordinate system of the **masked** node, with its
  transform — the window moves with the node. Fill only; stroke is ignored. One clipPath may mask
  many nodes.
- A masked `<image>` is built as a group (id, transform, opacity, display/visibility) holding the
  sprite (x, y, size, href) and the mask; `byId` gives the group, and `href` writes reach the sprite.
- Switchable from the heir: `tml:bind-clip-path="state.open ? 'url(#m)' : 'none'"`.
- The backend must implement `setClip`; otherwise a scene with `clip-path` does not mount.

---

## 4. The heir (`X.tml.svg`)

```svg
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
     tml:extends="game.svg">
  <tml:ref id="board" tml:type="tile-grid" tml:cols="8" tml:rows="8"/>
  <tml:ref id="coins" tml:bind="state.coins | money"/>
  <tml:ref id="scoreLabel" tml:bind="state.score" tml:visible="state.score > 0"/>
  <tml:ref id="playBtn" tml:on-click="play()"/>

  <g id="levelUp" tml:insert="after board" tml:visible="state.phase == 'levelup'">
    <text x="640" y="400" font-size="96" tml:bind="state.level"/>
  </g>
</svg>
```

Namespace: `xmlns:tml="https://trempel.dev/ns/scene"`. Root: `<svg tml:extends="X.svg">`. The
value of `tml:extends` is resolved relative to the heir; pointing at its own base `X.svg` is the
ordinary case, pointing at another scene is inheritance (§6.5).

### 4.1 Children of the heir

Every child of the heir root is exactly one of:

1. **`<tml:ref id="…">`** — mixes `tml:*` attributes into an existing node.
   - The id must exist (in the base, or inside an instance by composite id `btn/label`, or the
     instance itself `btn`).
   - Only `id` and `tml:*` attributes; any other attribute is an error — geometry and style are
     edited in the base, so the mock-up stays the truth.
   - The same id referenced twice is an error. A ref onto a node in `<defs>` is an error.
   - The one appearance an heir may change: `tml:href="…"` on a ref to an `<image>` (resolved
     relative to the heir); on another tag it is an error.
2. **An SVG subtree with `tml:insert`** — structure that exists only in the heir:
   - `tml:insert="after <id>"` — next sibling of that node; `tml:insert="into <id>"` — its last child.
   - Inside the subtree any allowed element and inline `tml:*` attributes are fine (the heir is
     logic territory); a `<use>` inside is expanded after the merge.

Anything else is an error. In addition, `data-*` on the heir root override the base root's — new
**parameter defaults** (§6.2).

Merge errors (all collected): base not sterile; duplicate ids in the base, in the inserts or
between them; ref without id / to a missing id / with foreign attributes / repeated / into `defs`;
malformed `tml:insert` or a missing target; `after` the root; a stray child.

### 4.2 `tml:` attributes

| Attribute | Meaning |
|---|---|
| `tml:bind="expr"` | reactive binding to the default property: `text` → its text, `image` → `href`. Other tags have no default — use `tml:bind-<attr>` (otherwise an error at mount) |
| `tml:bind-<attr>="expr"` | reactive write of any backend property path: `bind-x`, `bind-alpha`, `bind-href`, `bind-tint`, `bind-clip-path`, … |
| `tml:bind-view="expr"` | a `data-views` variant by name on an image (or a group with one image); `''`/`null` → the default `href`; an unknown name is a runtime error listing the names |
| `tml:visible="expr"` | visibility (`Boolean(value)`) |
| `tml:on-click="expr"` | click/tap handler |
| `tml:on-over`, `tml:on-out`, `tml:on-down`, `tml:on-up` | pointer handlers (`up` also fires when released outside); the backend must implement `onPointer` |
| `tml:type="name"` | hand the node to a registered component (§4.3) |
| `tml:<name>` on a component | component configuration (wins over the base's `data-<name>`) |
| `tml:slot="name"` / `"name default"` | in a prefab's heir: the group is a slot (§6.7) |
| `tml:href="…"` | in a `<tml:ref>` to an `<image>`: swap the image |
| `tml:insert`, `tml:extends` | structural, see above |

`tml:bind-style` is an error (blend modes do not switch).

### 4.3 Components — `tml:type`

A component owns its node's subtree: the scene does not build the children; the factory receives
them (`ctx.children`) and returns `{ root, …its API }`. Components are registered in a `Registry`
(`new Registry().register('tile-grid', factory)`); the runtime has no built-in components
(`createDefaultRegistry()` is an empty registry; up to 1.1 it held a demo grid component). Instances
are in `MountedScene.components` by node id.

`ComponentContext`: `tag`, `attrs`, `tml`, `backend`, `children`, `resolveHref(href)`,
`param(name)`, `path(id)`, `setView(id, name)`, `hitTest(id, x, y)`.

`ctx.param(name)` is the one place a component reads its configuration: `tml:<name>` from the heir,
else `data-<name>` from the base, else `undefined`. Geometry that is appearance (cell size, gaps)
lives in the sterile base and survives a reskin; logic may override it. A contract can require the
base attributes with `attrs="data-cols data-rows"` (§7).

---

## 5. Expressions

Every expression attribute (`tml:bind`, `tml:bind-*`, `tml:visible`, `tml:on-*`, and `=`-parameters
of instances) is a bare expression — the whole attribute value, no curly braces. It is parsed by
the core's own parser and run by an interpreter (`compile` / `run`); there is no code generation.

### 5.1 Grammar (lowest precedence first)

```
pipeline := cond ( '|' NAME ( ':' ARG )? )*          ARG: number | string | name
cond     := nullish ( '?' cond ':' cond )?
nullish  := or  ( '??' or )*
or       := and ( '||' and )*
and      := eq  ( '&&' eq )*
eq       := rel ( ( '==' | '!=' | '===' | '!==' ) rel )*
rel      := add ( ( '<' | '<=' | '>' | '>=' ) add )*
add      := mul ( ( '+' | '-' ) mul )*
mul      := un  ( ( '*' | '/' | '%' ) un )*
un       := ( '!' | '-' | '+' ) un | postfix
postfix  := primary ( '.' NAME | '[' cond ']' | '(' args ')' )*
primary  := number | 'string' | "string" | true | false | null | undefined | NAME
          | '(' cond ')' | '[' items ']' | '{' key ':' cond, … '}'
```

- Operators have JavaScript semantics (`==` is loose; `&&`, `||`, `??` short-circuit).
- Strings: `'…'` or `"…"`, escapes `\n \t \r \b \f \v \0 \\ \' \" \uXXXX`. No template strings.
- Names resolve **only** against the own keys of the mount context (`{ state, t, play, … }`).
  There are no globals: `Math`, `window`, `globalThis` are "name not defined".
- Calls: context functions (`play()`, `buy(1, 'x')`) and methods of values
  (`state.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })`) with the right `this`.
- Access to `constructor`, `prototype`, `__proto__`, `__defineGetter__`, `__defineSetter__`,
  `__lookupGetter__`, `__lookupSetter__` is refused (also via `[...]` and as object keys).
- Not in the language: assignment (`=` is a syntax error with a hint to use `===`), `;`, arrow
  functions, `new`, bitwise operators.

### 5.2 Pipes

`|` is always a pipe; `||` is logical OR; `|` inside a string is text. Pipes work in any expression.

| Pipe | Result |
|---|---|
| `fixed:N` | `Number(v).toFixed(N)` (default 0) |
| `int` | `Math.floor(Number(v))` |
| `money[:symbol]` | `symbol` + en-US number with 2 decimals; default symbol `$` (`money:'€'`, `money:EUR`) |

The registry is `PIPES` — a host may add its own before mounting. An unknown pipe is a mount /
checker error.

### 5.3 Errors

- **Syntax** errors (`E_EXPR_SYNTAX`) and unknown pipes (`E_PIPE_UNKNOWN`) are hard mount errors in
  the common list (and in the checker), with the node, attribute, position and a caret under the
  source line.
- **Runtime** errors (field of `undefined`/`null`, unknown name, calling a non-function, a throwing
  context function or pipe) follow the mount options:

| `MountOptions` | Behaviour |
|---|---|
| (default) | throws `ExpressionRuntimeError { code, node, attr, expr, error }` (`cause` = `error`; `code` — `E_EXPR_UNDEF`, `E_EXPR_FIELD`, `E_EXPR_CALL`, `E_EXPR_FORBIDDEN`, or `E_EXPR_RUNTIME` for a context function's own failure) — from `mount()` on first evaluation, from the state write that re-ran a binding, or from the event handler |
| `onError(info)` | receives `{ node, attr, expr, error }`; the write is skipped (the node keeps its last value), a failed handler does nothing |
| `lenient: true` | silent: `undefined` is written (`visible` → `false`), handler errors are swallowed; `onError` is still called if given |

`evalExpression` / `evalBinding` remain lenient helpers (an error yields `undefined`).

### 5.4 Context and reactivity

`mount({ context })` is the expression context; values made with `reactive()` (typically
`context.state`) re-run the bindings that read them (`effect()`). Names are looked up at evaluation
time: a function the host adds to the context after the mount (a game's actions) is callable from
then on, in the scene and inside its prefabs. In the viewer and editor the
context is `{ state }` from `X.state.json`, plus what the consumer module adds (§11); names the
scene uses that nobody provides become logging stubs.

### 5.5 `self` — expressions inside a prefab

A node that comes from a prefab evaluates in the **scene's** context (the prefab is not isolated)
plus `self`. 1.3: the instance's context **inherits** the level above (not a copy taken at mount):
names the host adds or changes later are seen inside prefabs too — `tml:on-click="tap(self.action)"`
in a prefab's heir calls the game's `tap`, and a binding may call the game's functions.

| Member | Meaning |
|---|---|
| `self.<param>` | instance parameter: `data-*` without `data-`, kebab → camel (`data-hit-size` → `self.hitSize`). Values are strings; a value starting with `=` is an expression compiled in the context of the **level above** (the scene or the outer prefab) and re-evaluated reactively |
| `self.id` | the instance id (composite when nested: `panel/close`) |
| `self.call(name, …args)` | call a function of the level above by a name held in a parameter: `tml:on-click="self.call(self.action)"`; a missing function is a runtime error with its place |
| `self.state`, `self.set(k, v)` | local reactive state of the instance (hover, pressed) |

A parameter may not be named `data-id`, `data-call`, `data-state` or `data-set`. A prefab opened
as a scene on its own (viewer, editor, tests) sees `self` built from its root's defaults, unless
the host passes its own `self`. A `<tml:ref id="btn/label">` written in an outer heir evaluates in
that outer document's context, not the prefab's.

### 5.6 `param()` — component parameters

Not an expression function: `ctx.param(name)` is how a component (§4.3) reads `tml:<name>` (heir)
falling back to `data-<name>` (base).

---

## 6. Prefabs

Any scene is a prefab: `X.svg` (+ `X.tml.svg`, + `X.contract.xml`). Example (a resizable button):

```svg
<!-- ui/button.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 72" data-resizable="x"
     data-label="Button" data-action="">
  <image id="bg" href="art/btn.png" width="240" height="72" data-slices="28 0"/>
  <image id="shade" href="art/shade.png" width="240" height="72" data-slices="28 0"
         data-views="hover:art/shade-hover.png, pressed:art/shade-down.png"/>
  <text id="label" x="120" y="46" text-anchor="middle" font-size="28" fill="#fff"
        data-anchor="0.5 0">Button</text>
  <rect id="hit" width="240" height="72" opacity="0" data-stretch="x"/>
</svg>
```

```svg
<!-- ui/button.tml.svg -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
     tml:extends="button.svg">
  <tml:ref id="label" tml:bind="self.label"/>
  <tml:ref id="shade"
    tml:bind-view="self.state.pressed ? 'pressed' : self.state.hover ? 'hover' : ''"/>
  <tml:ref id="hit" tml:on-click="self.call(self.action)"
    tml:on-over="self.set('hover', true)" tml:on-out="self.set('hover', false)"
    tml:on-down="self.set('pressed', true)" tml:on-up="self.set('pressed', false)"/>
</svg>
```

### 6.1 Instance — `<use>`

```xml
<use id="settingsBtn" href="ui/button.svg" x="280" y="270" width="320"
     data-label="=t('settings')" data-action="openSettings"/>
```

- `href` — the prefab's base, relative to the document. `id` is required.
- Passed to the instance group: `id`, `transform`, `opacity`, `display`, `visibility`,
  `clip-path`, `style`, and the presentation data `data-z`, `data-pivot`, `data-tint`,
  `data-anchor`, `data-stretch`. `x`/`y` become `translate(x y)` **after** `transform` (as SVG `use`).
- `width`/`height` — only for a resizable prefab, only along its axes (§6.6).
- Every other `data-*` is a **parameter** (overrides the defaults). `data-tml-*` are tool marks
  (e.g. the editor's index paths): passed to the group, not parameters.
- Children of `<use>` go into the prefab's slots (§6.7); text directly inside `<use>` is an error.
- Errors: no `id`; no `href`; any other attribute ("an instance is configured by parameters and
  transform"); a reserved parameter name; a syntax error in an `=` parameter; a missing required
  parameter; a prefab cycle (`menu.svg → a.svg → b.svg → a.svg`); a missing prefab; no loader.

### 6.2 Parameters

- Defaults are the `data-*` of the prefab base's root (`data-resizable` excluded); an heir root's
  `data-*` override them (§4.1).
- Required parameters: `<contract params="data-label data-action">` in the prefab's contract.
  Checked on the prefab itself (its root must give a default for each) and on every instance (each
  must set them, or an heir in the chain must have given a new default).
- Values are strings. A value starting with `=` is an expression of the level above.

### 6.3 Expansion and ids

Right after the base is parsed (before the contract and the heir), each `<use>` is replaced by a
`<g>` with the attributes above and, inside, the **result** of the prefab (its base, its instances,
its heir). Ids inside get the instance prefix: `settingsBtn/label`; `clip-path="url(#m)"`
references into the prefab are rewritten (`url(#settingsBtn/m)`). Nested instances expand
recursively and prefixes add up (`panel/close/label`). The expanded `<g>` carries
`instance: { href, rel, params, defaults, own, use, required, scope, min, size, resizable, slotted }`
for tools.

Errors inside a prefab are prefixed with the instance, the code stays first:
`E_REF_MISSING: #a (bad.svg): <tml:ref id="nope">: no such id in the base.`

### 6.4 Paths

Every document is addressed by its path from the top scene's folder. Hrefs inside a prefab
(`<image href>`, `data-views`, nested `<use>`, `tml:href`, and `data-*` parameters that look like an
image path — `.png .jpg .jpeg .webp .gif .avif .svg`) are rebased into that space on load; after
expansion the whole tree resolves against the scene document like its own hrefs (`baseUrl` /
`resolveHref`, §10). A collection href (`@skin/…`, §12) is a space of its own: a prefab at
`@skin/button.svg` rebases its relative hrefs to `@skin/art/…`.

### 6.5 Overrides and multi-level inheritance

- The scene's heir addresses nodes of an instance by composite id —
  `<tml:ref id="playBtn/label" tml:bind="t('play')"/>`, `tml:insert="into box/content"` — its `tml:*`
  win over the prefab's (last wins); `<tml:ref id="playBtn">` targets the instance group. Geometry
  and style still cannot be overridden.
- An heir **without its own base** whose `tml:extends` names another scene takes that scene's
  **result** (base + instances + heir) as its base — e.g. `ui/button-green.tml.svg`:

  ```svg
  <!-- ui/button-green.tml.svg -->
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
       tml:extends="button.svg" data-label="OK">
    <tml:ref id="bg" tml:href="art/green.png"/>
  </svg>
  ```

- Chains resolve recursively, any depth, for prefabs and top scenes alike (`mount({ heir })`
  without `base`). A cycle is an error (`E_EXTENDS_CYCLE: tml:extends cycle: top.svg → a.svg → b.svg → a.svg.`).
  An own base **and** `tml:extends` of another scene is an error ("one base").
- An inherited base is not sterile by construction — sterility is only asked of a document's own
  base. The contract is inherited too: without its own `X.contract.xml` the extending scene uses
  the extended scene's contract (and its `params`).

### 6.6 Resizable prefabs

- The prefab base root has `data-resizable="x|y|xy"` and a `viewBox`, which is the **minimum**
  size (missing viewBox — error). `data-resizable` is not a parameter (`self` does not see it).
- `<use … width="600" height="800">` — only on a resizable prefab and only along its axes;
  otherwise an error ("not resizable — scale an instance with transform" / "resizes only along x").
  Smaller than the minimum — error. Without a size — the minimum.
- **Default background:** an `<image data-slices>` that is a direct child of the root, without its
  own `data-stretch`/`data-anchor`, stretches along the `data-resizable` axes. A resizable prefab in
  which nothing stretches is an error ("needs an `<image data-slices>` or `data-stretch` on the
  background").
- Everything else inside is placed with anchors (`data-anchor="0.5 0"` on a title, `"1 0"` on a
  nested close button).
- The instance is a box (§8.1); `setSize`, `sizeOf` and the clip columns `width`/`height` drive it.

### 6.7 Slots

- In the **prefab's heir**: `<tml:ref id="content" tml:slot="content"/>` marks a group as a slot (in
  the base it is an ordinary empty `<g id="content"/>`). `tml:slot="content default"` makes it the
  default slot too (a slot named `default` is default as well). A slot must be a `<g>`; two slots
  with one name, or two defaults, are errors.
- In the **scene**: children of `<use>` are ordinary nodes (`g image text use …`) with
  `slot="name"`; without `slot` they go to the default slot. On expansion they are appended to the
  slot group.
- They remain **the scene's nodes**: ids without the instance prefix (`#resumeBtn`, not
  `#pause/resumeBtn` — a clash is an ordinary duplicate-id error), expressions in the scene's
  context (not the prefab's `self`), the scene's heir edits them directly, and the scene's sterility
  check and contract see them. Instances among them expand in the scene's document.
- Errors: a child without `slot` and no default slot; an unknown slot name (both list the slots);
  children of a `<use>` whose prefab has no slots.
- A prefab nested inside another prefab: the children of its `<use>` belong to the outer prefab
  (outer prefix, outer `self`).

A panel with two slots (its base and its heir), and a scene filling them:

```svg
<!-- ui/panel.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" data-resizable="xy" data-title="Panel">
  <image id="bg" href="art/panel.png" width="400" height="300" data-slices="40"/>
  <text id="title" x="200" y="56" text-anchor="middle" font-size="36" data-anchor="0.5 0">Panel</text>
  <g id="content"/>
  <g id="footer"/>
</svg>
```

```svg
<!-- ui/panel.tml.svg -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
     tml:extends="panel.svg">
  <tml:ref id="title" tml:bind="self.title"/>
  <tml:ref id="content" tml:slot="content default"/>
  <tml:ref id="footer" tml:slot="footer"/>
</svg>
```

```xml
<use id="pause" href="ui/panel.svg" width="600" height="800" data-title="Pause">
  <use id="resumeBtn" href="ui/button.svg" x="150" y="300" data-label="Resume" data-action="resume"/>
  <text id="hint" slot="footer" x="300" y="700">Tap to continue</text>
</use>
```

### 6.8 Loading

Prefabs and `tml:extends` chains are loaded through a scene loader: `url → { base?, heir?, contract? }`
(text) or `null` for "no such scene".

- `mount({ loadScene })` needs a synchronous loader; an asynchronous one is an error ("use
  `mountAsync()`").
- `mountAsync({ loadScene })` loads every document first (`preloadScenes`), then mounts. In the
  browser entry `@trempel/scene`, `mountAsync` without `loadScene` uses `fetchSceneLoader()`, which
  fetches `X.svg`, `X.tml.svg`, `X.contract.xml` by stem (404 = absent).
- The loader's `url` is the instance href resolved like an image href (`baseUrl`/`resolveHref`), or
  against `sceneUrl` when given. In `@trempel/scene/core` a `<use>` without a loader is an error.

---

## 7. The contract (`X.contract.xml`)

One file, three roles: **a brief** for the view (what the mock-up must contain — for a person, and a
prompt for generating or reskinning a base), **a validator** (a deterministic check of the base
against the logic's expectations), **documentation** (an enumerable list of what the logic needs).

**Invariant: a contract describes structure, not appearance** — topology, node types, invariants.
No "the button looks nice", no "logo in the top third".

Syntax: an XML skeleton that mirrors the scene.

```xml
<contract viewBox="0 0 1280 800">
  <image id="bg"/>
  <g id="board" empty="true" attrs="data-cols data-rows"/>
  <text id="coins"/>
  <use id="playBtn" href="ui/button.svg"/>
  <g id="lines" empty="true"/>
  <g id="zones">
    <ellipse match="z\d+" count="1.." attrs="data-pivot pathLength stroke-dasharray"/>
  </g>
</contract>
```

### 7.1 Root `<contract>`

| Attribute | Meaning |
|---|---|
| `viewBox="0 0 1280 800"` | the base viewBox must be exactly this (commas = spaces) |
| `viewBox="any"` (or `*`) | any, but present and valid |
| `viewBox="0 0 816 1456 \| 0 0 960 1664"` | one of the list |
| `aspect="9:16"` [+ `tolerance="3%"`] | only the width:height ratio; tolerance a fraction or a percentage |
| neither | not checked |
| `params="data-a data-b"` | required prefab parameters (§6.2) |
| `resizable="x\|y\|xy"` | the base root carries this `data-resizable` |

`viewBox` and `aspect` together are an error.

### 7.2 Node lines

`<tag id="…" …/>` — the node exists in the base **exactly once** and has this tag.

| Attribute | Meaning |
|---|---|
| `empty="true"` | no children (a component owns the container) |
| `attrs="data-cols data-rows"` | these base attributes are present (values unchecked) |
| `anchor="ax ay"` | the node's `data-anchor` has these values |
| `slices="true"` | on `<image>`: it has `data-slices` |
| `slot="true"` | on `<g>`: the group is a slot (`tml:slot`) — checked after the heir |
| `<use id href>` | the node is an instance of **this** prefab (hrefs compared as normalised paths); a non-instance says "expected an instance `<use href>`, the base has `<g>`" |

Nodes inside instances are addressed by composite id (`<text id="settingsBtn/label"/>`); slot
children by their own id, nested where they live (`<use id="pause"><use id="resumeBtn" …/></use>`).

### 7.3 Pattern lines

`<tag match="regex" …/>` describes a family of nodes rather than one id.

| Attribute | Meaning |
|---|---|
| `match` | regular expression against the **whole** id (`o\d+` does not match `xo1` or `o4 copy`) |
| `count` | `N`, `N..M`, `N..`, `..M`; default `1..` |
| `in="<id>"` | matching nodes must lie inside that node (counted only there) |
| `requires="<id template>"` | each match needs a partner id; `$1…$9` are the match's groups. One-directional |
| `empty`, `attrs` | as for nodes, applied to each match |
| (tag) | the tag every match must have |

`id` and `match` on one element are an error; a pattern has no children.

### 7.4 Nesting

A node or pattern written **inside** a contract node must lie inside it in the base. For patterns
this is `in="<parent id>"` (an explicit `in` wins). Children of an `empty="true"` line are an error.

### 7.5 Checks and when they run

1. every contract node exists once, tag matches (or is an instance of the prefab);
2. `empty`, `attrs`, `anchor`, `slices`, nesting;
3. the viewBox rule;
4. patterns: count, placement, tag, partners;
5. `params` defaults and `resizable` on the root;
6. all base ids unique; the base is sterile (not asked of an inherited base or of instance content);
7. after the heir: `slot="true"` groups are marked.

The contract is checked against the **expanded, pre-heir** tree. It runs on every `mount()`
(together with merge, prefab and expression errors) and in the repository's checker
(`npm run check -- <scene file or folder> [--anim anim/x.md]`), which exits non-zero with a readable
report — so a design tool's save is caught before the scene reaches people.

---

## 8. Layout

All layout is base attributes. At the reference size the scene is exactly the vanilla SVG; anchors
and stretch act only when a box is larger than its reference.

### 8.1 Boxes, anchors, stretch

A **box** is a node whose size its direct children are laid out against:

| Box | Reference size | Current size |
|---|---|---|
| root `<svg>` | `viewBox` | `MountedScene.resize(w, h)` (viewBox units — the host's canvas) |
| prefab instance | the prefab's `viewBox` (its minimum) | `<use width height>`, clip `width`/`height`, `setSize` |
| `<g data-size="w h">` | `data-size` | its own `data-stretch`, `setSize` |

- `data-anchor="ax ay"` (0..1) on a direct child of a box: when the box is larger than its
  reference by `(extraW, extraH)`, the node moves by `(extraW·ax, extraH·ay)` — it stays at
  `(ax·W, ay·H)` plus its own offset from `(ax·W₀, ay·H₀)`. The offset is added to the node's
  position in its parent; transform, rotation and pivot are untouched.
- `data-stretch="x|y|xy"` on `<image>`, `<rect>`, `<g data-size>` and an instance of a resizable
  prefab: the size along the axis grows by the extra (`w₀ + extraW`) — margins to the box edges are
  kept. With `data-slices` the image is a 9-slice, without it a scale. A stretched box (group,
  instance) then lays out its own children. Along a stretched axis an anchor does not act.
  A stretched `image`/`rect` must have `width` and `height`; a stretched instance only along the
  prefab's `data-resizable` axes.
- **The parent must be a box**: an anchored/stretched node under a group without `data-size` is an
  error ("give the group `data-size="w h"`, or move the node to the root / into a prefab"); under the
  root, the root needs a viewBox.
- `data-size` is validated only when the group actually is a box (it has anchored/stretched children
  or stretches itself); otherwise it may be a component parameter (`ctx.param('size')`).
- On `<use>`, `data-anchor` and `data-stretch` place the instance, they are not parameters.
- Layout is live: box sizes are reactive; `resize`, `setSize` and clip `width`/`height` immediately
  move and stretch everything nested. Hit tests follow the layout.

### 8.2 9-slice and tiling

- `<image data-slices="l t r b">`: `width`/`height` are the **panel** size; the texture is not
  scaled, borders stay 1:1 (`PixiBackend` builds a `NineSliceSprite`). Slices that leave no centre of
  at least 1 px on an axis (`l + r ≥` texture width) reject `scene.ready` with the sizes — checked
  with every new texture (`href` change).
- `<image data-tile="x|y|xy">`: a tiling sprite repeating along those axes, stretched along the
  other. Not combined with `data-slices`.
- Runtime size: `setProp(node, 'width' | 'height', v)` on an image changes its SVG box (the 9-slice/
  tile view itself, or a plain sprite's texture fit; host transforms untouched); on a `<rect>` it
  redraws. `MountedScene.setSize(id, w?, h?)` is the public form.
- `PixiBackend.createImage(attrs)` is the extension point; subclasses calling `super.createImage`
  keep 9-slice and tiling.

---

## 9. Clips — md clips

Clips are written as **clip tables** in Markdown (`anim/<name>.md` next to the scene, or
`X.anim.md` in the scene's folder). The compiled JSON (`anim.json` shape) is only an output for the
game: viewer and editor always play the `.md`.

### 9.1 Syntax

```markdown
Clips of the mascot. Prose and headings without `$` are comments.
$tex: art/{}.png

# $clip idle
$duration: 2.4
$loop: true

## $track mascotHead
| t    | rotation | tex        | ease  |
|------|----------|------------|-------|
| 0    | 0        | head-idle  | inOut |
| 1.0  | 6        |            | inOut |
| 2.05 |          | head-blink | step  |
| 2.15 |          | head-idle  |       |
| 2.4  | 0        |            |       |

## $track bird
$path: fly1
$orient: auto
$offset: 0, -12
| t | motion | alpha | ease  |
|---|--------|-------|-------|
| 0 | 0      | 0     | inOut |
| 2 | 1      | 1     |       |

## $events
| t    | event |
|------|-------|
| 2.05 | blink |
```

- `# $clip <name>` opens a clip (names unique in the file). Clip attributes: `$duration` (seconds;
  default — the last key or event), `$loop: true|false`, `$tex`.
- Inside: `## $track <id>` (a table of keys for one target), `## $events` (`t`, `event` columns),
  `## $tex` (a `name`/`href` table). Unknown blocks or attributes are errors listing what exists.
- Track attributes: `$path`, `$orient`, `$orient-offset`, `$offset` (motion only), `$tex`.
- A target `$name` is late-bound at play time (`play(clip, { targets: { name: handle } })`).
- 1.3: a numeric cell `$name` is a **clip parameter**, given at play time in the column's units
  (`play(clip, { params: { toX: 120, toY: -40 } })`): one clip flies to a different place each
  play, without copying it. Allowed in the number columns (`x`, `y`, `rotation`, `scale…`, `skew…`,
  `alpha`, `motion`, `dash`, `strokeWidth`, `strokeAlpha`, `width`, `height`); a name is
  `[A-Za-z_][A-Za-z0-9_]*`. A parameter not given (or not a number) at play — `E_ANIM_PARAM`, before
  anything moves. Compiled: the key has `param` and `v` = the column's unit (`params[param] × v`).

  ```markdown
  # $clip collect
  $duration: 1.35

  ## $track flyingPostcard
  | t    | x    | y    | scale | alpha | ease  |
  |------|------|------|-------|-------|-------|
  | 0    | 0    | 0    | 1     | 1     | inOut |
  | 1.15 | $toX | $toY | 0.53  | 1     |       |
  | 1.35 | $toX | $toY | 0.53  | 0     |       |
  ```
- One target may have any number of tables (different eases for different properties); the same
  property of a target twice in one clip is an error.
- A table needs a header, a `|---|` separator row and a `t` column. Times are numbers ≥ 0, strictly
  ascending, ≤ `$duration`.

### 9.2 Columns

| Column | Value | Compiled property |
|---|---|---|
| `t` | seconds | — |
| `x`, `y` | offset from the rest pose | `x`, `y`, `relative` |
| `rotation` | degrees clockwise, offset from rest | `rotation` (radians), `relative` |
| `scale` \| `scaleX`, `scaleY` | multiplier of rest (`scale` and `scaleX/Y` in one table — error) | `scale.x` + `scale.y`, `relative` |
| `skewX`, `skewY` | degrees, offset from rest | `skew.x`, `skew.y` (radians), `relative` |
| `alpha` | absolute | `alpha` |
| `tint` | `#rrggbb`, absolute, interpolated per RGB channel | `tint` (0xRRGGBB numbers) |
| `z` | integer, absolute, always `step` (the row's ease does not apply) | `z` |
| `tex` | texture name → href (§9.4), held until the next key | `href` (string keys) |
| `view` | a `data-views` name of the target image; needs the scene | `href` (string keys) |
| `motion` | fraction 0..1 of `$path`'s length | `motion` + `path`, `orient`, `orientOffset`, `offset` |
| `dash` | `stroke-dashoffset`, absolute (in `pathLength` units if set); target needs `stroke-dasharray` | `stroke-dashoffset` |
| `strokeWidth` | ≥ 0, absolute | `stroke-width` |
| `strokeAlpha` | 0..1, absolute | `stroke-opacity` |
| `width`, `height` | ≥ 0, absolute — an `<image data-slices>` or an instance of a resizable prefab (along its axes) | `width`, `height` |
| `ease` | see §9.3 | moved onto the next key |

An empty cell is "no key for this property". An unknown column is an error. String keys
(`tex`, `view`) are not interpolated and are written only on change. Rules with a scene:
`tex`/`view` targets are an `<image>` or a group with exactly one image; stroke columns need
geometry (`path`, `line`, `circle`, `ellipse`, `rect`); `width`/`height` elsewhere is an error;
targets must exist and not be in `<defs>`. `view` and `tex` in one track write `href` twice — error.

### 9.3 Easing

The ease of a row means "**from this key to the next key of the same property**"; a row without a
value in a column has no ease for it; the last key's ease does nothing. (The compiled JSON stores
the ease on the destination key of the segment.)

Names: `linear`, `in`, `out`, `inOut` (quadratic), `outBack`, `inBack`, `outBounce`, `step` (holds
the value through the segment, jumps at the next key), plus `quadIn`, `quadOut`, `quadInOut`,
`cubicInOut`, `backOut`, `elasticOut`; or `[x1,y1,x2,y2]` — a cubic Bézier.

### 9.4 `$tex` — how a `tex` cell becomes an href

```markdown
The file template (before the first clip):
$tex: art/{}.png

# $clip win
The clip template:
$tex: fx/{}.webp

## $tex
The clip table — names one by one:
| name   | href             |
|--------|------------------|
| coin_0 | coins/gold-0.png |

## $track coin
The track template:
$tex: coins/{}.png
| t   | tex    |
|-----|--------|
| 0   | coin_0 |
| 0.5 | spin   |
```

- `{}` is replaced by the name (every occurrence); a template without `{}` is an error. The table
  needs `name` and `href` columns; a repeated name is an error; `$tex` on a track without a `tex`
  column is an error.
- Lookup order: track template → clip table → clip template → file template → the name as written.
- A compile-time `tex` option (`compileClips(md, scene, { tex })`, CLI `--tex "art/{}.png"`)
  overrides all `$tex`.
- Clip hrefs are relative to the scene and reach the backend as is — `baseUrl`/`resolveHref` of the
  mount do not apply to them; map them with `$tex` (viewer and editor resolve them themselves).

### 9.5 Motion along a path

- A `motion` column plus `$path: <id>` of a `path`, `line`, `circle`, `ellipse` or `rect` (usually in
  `<defs>`). `$path` without `motion`, or `motion` without `$path`, is an error.
- `motion` is a **fraction of length** (with `linear` — constant speed), not a Bézier parameter.
  An open path clamps to 0..1; a closed one (`Z`; circle/ellipse/rect always) wraps — loops without a
  jump. Shapes start and run as in SVG: circle/ellipse from `(cx + r, cy)` clockwise on screen,
  rect from `(x + rx, y)` to the right.
- Path coordinates are in the target's **parent** space (as `animateMotion`); the player writes `x`,
  `y` = the path point (absolute; the rest pose is ignored), placing the node's pivot on the path.
  The path node's own transform applies but must be a similarity (translate, rotate, uniform scale,
  mirror); stretch/skew is an error.
- `$orient: auto` — `rotation` follows the tangent (+ `$orient-offset` degrees); without it rotation
  is untouched. `motion` with `x`/`y`, or with `rotation` under `auto`, is an error.
  `$offset: dx, dy` shifts from the path point — in the node's rotated axes under `auto`.
- A missing path is an error at compile time (with the scene) and at `play()`.

### 9.6 Player

- **Rest pose** is what the scene built: read through `backend.getProp` the first time a relative
  track touches a node with this `Animator`, and remembered (no drift across clips). Relative tracks
  write `rest + v` (`x`, `y`, `rotation`, `skew.*`) or `rest × v` (`scale.*`). Rotation, scale and
  skew turn around `data-pivot`.
- `loop` repeats until `abort()` (`done` resolves on abort); events fire every cycle.
- `width`/`height` on an instance go to its box (contents re-layout; the container is not scaled),
  on an image to the backend.
- API: `new Animator(backend, clock, (id) => scene.byId.get(id), { path: (id) => scene.path(id) })`;
  `play(clip, { targets, params, speed, onMarker }) → { abort(), done }`; `parallel(...)`, `sequence([...])`;
  `speed` may be a getter read every frame; call `tick()` once per frame.
- Compiling: `compileClips(md, scene?, { tex? })` throws a `TrempelError` with every problem
  (`E_ANIM_VALUE: $clip bad / $track box, row 3: x="a" — not a number.`); `compileClipsResult(...)` returns
  `{ clips, errors }`. Repository CLI: `npm run anim:compile -- x.md [--scene dir] [--out x.json] [--tex …]`.

---

## 10. Mounting and readiness

```ts
import { mountAsync, PixiBackend, createDefaultRegistry, reactive } from '@trempel/scene';

const state = reactive({ coins: 1000, score: 0, phase: 'idle' });
const scene = await mountAsync({
  base, heir, contract,                 // document texts (base optional with tml:extends)
  backend: new PixiBackend(),
  context: { state, play },
  registry: createDefaultRegistry(),
  container: app.stage,
  baseUrl: 'scenes/game.svg',
});
await scene.ready;
```

| Function | Purpose |
|---|---|
| `mount(args)` | synchronous two-document mount; throws `TrempelError` with all problems |
| `mountAsync(args)` | loads prefabs / extends chain with an async `loadScene`, then `mount` |
| `mountScene(svg, opts)` | single document with inline `tml:*` (no heir, no sterility) — for quick tests |
| `mountTree(tree, opts)` | build an already composed tree without checks |
| `composeScene(input)` | parse + expand + contract + merge, errors by stage, no throw |

`MountOptions`: `backend`, `context`, `registry?`, `container?`, `baseUrl?`, `resolveHref?`,
`loadScene?`, `sceneUrl?`, `collections?` (§12), `heirs?` (project heirs, §12), `onError?`, `lenient?`; mount args add `base?`,
`heir?`, `contract?`, `path?`.

**Hrefs.** With `baseUrl` (the scene document's URL or path) relative image hrefs — attributes of
base and heir, bound `href` values, hrefs components set through `ctx.backend` — resolve against it
like in a browser; absolute ones (`scheme:`, `/path`, `#`) are untouched. `resolveHref` is applied
after `baseUrl` (a bundler's hashed-URL table, a skin lookup). `ctx.resolveHref` exposes the same for
assets a component loads itself. Without either, hrefs reach the backend as written. A collection
href `@name/path` is expanded first (`collections`, §12): `resolveHref` gets an ordinary path.

**`MountedScene`:**

| Member | Meaning |
|---|---|
| `root`, `byId`, `components` | built root, nodes with an id, component instances by id |
| `ready: Promise<void>` | resolves when every texture started during the build (and while waiting) has loaded; rejects with a `TrempelError` listing failed hrefs (and 9-slice misfits). Handled internally — not awaiting it causes no unhandled rejection |
| `path(id)` | `{ length, closed, pointAt(s), tangentAt(s) }` of a geometry node, `s` in scene units |
| `setView(id, name)` | show a `data-views` variant of the image (or the group's single image) |
| `hitTest(id, x, y)` | is the scene point inside the node's geometry |
| `hitTestAll(x, y)` | ids of shapes/images under the point, topmost first |
| `resize(w, h)` | the root box's new size (viewBox units) |
| `setSize(id, w?, h?)` | size an instance of a resizable prefab, a `<g data-size>`, an `<image>`, a `<rect>` |
| `sizeOf(id)` | current size of a box or a laid-out node |

**Hit test** is by the **document's geometry**, in scene (viewBox) coordinates, with the whole
transform chain and the live layout applied; poses given by clips or the host at run time are not.
`path`/`circle`/`ellipse`/`rect` — inside the outline (`fill-rule`, `rx/ry`; `fill="none"` is still an
area); `line` — within half its stroke width (at least 0.5); `image` — its `x/y/width/height` box (no
size — no hit); `g` — any drawn descendant; `text` and components — never. `display`, `visibility`,
`opacity` do not matter: a hidden zone is hit. `hitTestAll` walks reverse paint order (document
order, `data-z` among siblings), skipping `defs`, `clipPath` and component subtrees; prefab nodes
appear by composite id. Core helpers: `pointInNode`, `nodeMatrix`, `hitTestTree`.

**Backend contract** (`RendererBackend`): `createNode`, `setProp`, `onClick`, `addChild`, `mount`,
`getBounds`; optional `whenReady` (readiness), `setClip` (masks), `getProp` (rest pose, required for
relative clips), `onPointer` (pointer events). `setProp` paths include `text`, `href`, `visible`,
`tint`, `x`, `y`, `alpha`, `rotation`, `scale.x`, `skew.x`, `z`, `mix-blend-mode`, `display`,
`width`, `height`, `stroke-dashoffset`, `stroke-width`, `stroke-opacity`. `PixiBackend` implements
all of them; options `{ fontFamily?, metrics?, baselineRatio? }`. Fonts must be loaded before mount
(text metrics are measured at creation).

---

## 11. The consumer module `trempel.view.ts`

An optional module next to a folder of scenes, read by the viewer and the editor. Its default export
is a plain configuration object; every field is optional:

| Field | Purpose |
|---|---|
| `setup()` | one-time setup before the first scene (patches, preloads) |
| `registry()`, `backend()` | component registry, backend (e.g. a `PixiBackend` subclass) per mount |
| `baseUrl`, `resolveHref` | href resolution as in §10 (`baseUrl: false` — scene-relative) |
| `fonts`, `fontFamily` | web fonts loaded before the first mount; default text family |
| `context(state)` | extra expression context next to `state` (texts, real handlers) |
| `onMount({ id, scene, state })` | seed components after each mount |
| `onClipTime({ id, scene, clip, t, markers })` | 2.2: after every pose of the scene by a clip (`view:shot --clip --t`, a seek or a played frame of the editor's clip panel): `t` — seconds shown, `markers` — the clip's `$events` at or before `t` in this cycle; what lives in time next to the clip (a particle effect fired by a marker) catches up — deterministically |
| `background` | stage background colour |
| `prefabs` | prefab folders for the editor palette, e.g. `['ui']` |
| `collections` | v1.1: collection name → folder URL (relative to the scene folder, or absolute), over the project's (§12) |
| `inspectors` | 2.3: the editor's panels for the nodes of a `tml:type` — `{ fx: factory }`; see below |

The editor keeps per-project data (macros) in a `.trempel/` folder.

**Inspectors (2.3).** The editor knows nothing of a consumer's components; a consumer brings their
editors. `inspectors[type]` is a factory `(host) => { el, dispose }`, or `{ panel, palette?, api? }`:
`panel` — shown for the inspected node of that `tml:type` (the selected node; a node the heir
inserts is picked in the layers tree); `palette` — shown whatever is selected (what it drags onto
the stage with the type `application/x-trempel-fx`, `FX_DRAG_MIME`, becomes an effect node of the
heir — `heir.insertFx` into the selected group); `api` — the same edits for scripts and agents
(`tml.inspect[type]`). The `host` gives the node (`id`, `tag`, `attrs`, `tml`, `inserted`), the
mounted scene and the node's component, `exec(name, args)` — the editor core's commands (one undo
step each), `files` (`list`, `read`, `write` — the scene folder; the editor writes scene documents,
md clips and effect data: `fx/*.json`, `systems.json`), `ui` — the page's widgets (`curve`,
`gradient`), `log`, `refresh`. The kit's `kitView()` brings the particle editor of `fx` nodes.

---

## 12. Collections — `@name/…`

A shared skin, a kit and the games that use them should not reach each other through relative
paths (`../skins/default/ui/panel.svg`): a moved folder breaks every scene, and tools do not see files
above the scene's folder. A **collection** is a named folder; any href — `<use href>`, `<image href>`,
`tml:href`, `data-views` variants, image parameters, bound values, a clip's `$tex` — may point into it
as **`@name/path`** (the extension as usual: `@skin/panel.svg`, `@skin/art/icons/play.png`).

- Name: `[a-z][a-z0-9-]*`. `@` at the start of a relative path means a collection, nothing else.
- Inside a collection's file its own relative hrefs resolve as always — from that file (they stay
  in the collection: `art/x.png` in `@skin/button.svg` is `@skin/art/x.png`; `..` never climbs out).
  A collection file may point into itself or another collection by `@`.
- An unknown name is an error — `E_COLLECTION_UNKNOWN: … the project has no collection @name
  (collections: …)` — at mount, in `check`, in the viewer, never a silent 404.
- The price, taken on purpose: a scene with `@` hrefs does not open in a browser as is. A scene with
  prefabs does not either (an external `<use>`, 9-slice, slots) — `flatten` (§13) makes the vanilla
  SVG of any scene.

**Where they are declared.** `.trempel/project.mdz` in the **project root** — the nearest ancestor of
the scene holding that file (none — no collections). md blocks, read by the core's md parser:

```mdz
# Trempel project

## collections
$skin: skins/default/ui
$kit: npm:@trempel/kit/ui
```

A value is a folder **from the project root**, or `npm:<package>/<subfolder>` — the package's folder
found by Node resolution from the root (`node_modules` up the tree). Other sections are notes.

**Resolution.** `@name/path` → `<collection folder URL>/path`, **before** `baseUrl` / `resolveHref`
(the host's table gets an ordinary path, bundler hash tables keep working). The runtime in a browser
looks nothing up: the host passes `collections: Record<string, string>` (name → folder URL, absolute
or relative to the scene document) to `mount*`; the viewer / editor take it from `trempel.view.ts`
(`defineView({ collections })`, overriding single names of the project's). The Node tools (`view`,
`view:shot`, `edit`, `check`, `flatten`, `migrate-collections`) read `project.mdz` themselves.

**Contract.** A `<use>` line's `href` is compared by the resolved file: `@skin/panel.svg` and the
same file by its relative path are one prefab.

**Extending a collection document.** An heir of the project may extend a document of a collection
(`tml:extends="@ui/level.svg"`): the base — with its instances, its own heir and its contract — comes
from the collection, the project's heir binds, inserts and overrides over it as over any base. The
collection stays as delivered; the game keeps only its heirs.

**Project heirs (1.3).** A collection is a library, the project configures it: **any heir of the
project whose `tml:extends` names a collection document is that document's heir in the project**.
Every instance of the document — in the project's scenes and inside the collection's own documents
(`<use href="ui/card.svg">` in `@ui/album.svg` is `@ui/ui/card.svg`) — is built as that heir: the
collection's base, its heir, then the project's heir, layered like a multi-level `tml:extends`
(§6.5) — the collection heir's slots and bindings stay, the project adds clicks, variants, data; a
`<tml:ref>` of the project heir overrides the collection heir's by the usual rules. The link is the
`tml:extends` target, not the file's name or folder. A top scene that extends the document is that
heir itself (merged once). Two heirs of the project extending one document — `E_PROJECT_HEIR` (a
variant extends the project heir instead). The Node tools (`check`, `view`, `view:shot`, `edit`,
`flatten`) find the project heirs themselves — every `*.tml.svg` below the project root, outside
the collections, `node_modules`, dot-folders and builds; a browser host passes them to `mount*` as
`heirs` (collection document → the heir scene's href from the scene document; the kit's Vite plugin
does it for a game).

A UI kit delivered as a collection — a card prefab with its heir, and an album of cards:

```svg
<!-- @ui/ui/card.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 400" data-title="Place" data-action="">
  <image id="photo" href="art/photo.png" x="20" y="20" width="280" height="280"/>
  <text id="title" x="160" y="350" text-anchor="middle" font-size="32">Place</text>
  <rect id="hit" width="320" height="400" opacity="0"/>
</svg>
```

```svg
<!-- @ui/ui/card.tml.svg -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
     tml:extends="card.svg">
  <tml:ref id="title" tml:bind="self.title"/>
</svg>
```

```svg
<!-- @ui/album.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920">
  <text id="worldTitle" x="540" y="160" text-anchor="middle" font-size="64">Istanbul</text>
  <use id="card1" href="ui/card.svg" x="60" y="300" data-title="Tea Room" data-action="openCard"/>
  <use id="card2" href="ui/card.svg" x="700" y="300" data-title="Rooftops" data-action="openCard"/>
</svg>
```

The game: the card's project heir (every card of every scene gets the photo and the click) and the
album's heir (extends the collection's album, adds a third card):

```svg
<!-- scenes/ui/card.tml.svg -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
     tml:extends="@ui/ui/card.svg">
  <tml:ref id="photo" tml:bind="state.cards[self.id].photo"/>
  <tml:ref id="hit" tml:on-click="openCard(self.id)"/>
</svg>
```

```svg
<!-- scenes/album.tml.svg -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
     tml:extends="@ui/album.svg">
  <tml:ref id="worldTitle" tml:bind="state.album.name"/>
  <use id="card3" tml:insert="after card2" href="@ui/ui/card.svg" x="60" y="800" data-title="Bazaar"/>
</svg>
```

**Core API:** `expandCollection(href, collections)`, `collectionOf(href)`, `parseProject(text)`,
`collectionErrors(tree, collections)`, `usedCollections(tree)`, 1.3: `projectHeirs(files)`,
`heirsFor(heirs, scenePath)`; Node (`@trempel/scene/node`): `loadProject(dir)` → `{ root,
collections: name → absolute folder, heirs: document → absolute heir scene, errors }`,
`heirsOf(project, sceneFile)`, `collectionPath(file, collections)`.

---

## 13. Tools

| Command | What it does |
|---|---|
| `npm run check -- <folder \| X.svg> [--anim anim/x.md]` | the mount pipeline without rendering (parse, prefabs, contract, merge, geometry, attributes, expressions, collections); clips against the scene |
| `npm run view -- <folder>` / `npm run edit -- <folder>` | the viewer / the editor on a dev server; serves the project root and the collections' folders (anything else — 403) |
| `npm run view:shot -- <scene> --out x.png` | a headless PNG + JSON of the scene's problems; the folder — `--dir`, else the nearest `trempel.view.ts`, else the project root |
| `npm run flatten -- <scene> --out x.svg [--embed] [--state s.json]` | **open the scene anywhere:** one vanilla SVG (bin `trempel-flatten`) |
| `trempel-edit eval [--port N] '<code>'` · `save` · `state` · `mcp` | 2.3: an agent in the editor page a person has open (`npm run edit`): a `tml` script as one undo step, ⌘S, the page's state; `mcp` — the same as an MCP server (stdio: `editor.eval`, `editor.save`, `editor.state`); localhost only |
| `node scripts/migrate-collections.mjs <folder> [--dry-run]` | relative links into a collection → `@name/…` (MIGRATION §11) |

**`flatten`** builds the scene with the runtime itself over a recording backend and writes what it
would draw at the scene's own size as plain SVG that any browser and Figma draw:

- the heir merged, prefab instances expanded into `<g>` (ids with the instance prefix, as at run
  time), slots filled;
- `data-slices` — the picture as 9 pieces, each a nested `<svg x y width height viewBox="sx sy sw sh"
  preserveAspectRatio="none">` around the one `<image>` (the raster is not cut; borders 1:1, scaled
  down like the runtime when the box is smaller); `data-tile` — a `<pattern>`; an image's box is
  stretched as the runtime does it (`preserveAspectRatio="none"`);
- anchors and stretches laid out for the scene's size (resizable instances at their width/height) and
  written as coordinates; `data-tint` — an `feColorMatrix` filter; `data-z` — sibling order; masks — a
  `<clipPath>` per use; `data-*` and `tml:*` dropped;
- expressions — values at a state (`--state`, else `X.state.json` next to the scene) and instance
  parameters; an expression that reads a name nobody provides (no state, a host function) keeps the
  base's value;
- every `href` relative to the output file (collections resolved); `--embed` — pictures as `data:`
  URIs, one self-contained file (what `<img src=out.svg>` needs: an SVG image loads nothing external);
- what vanilla SVG cannot do — components with code, clips — stays as in the base, listed as warnings.

---

## 14. Invariants

- The base is sterile: no `tml:*`. Validated, never assumed.
- Geometry and style belong to the base; the heir does not override non-`tml` attributes (sole
  exception: `tml:href` on an image).
- The contract is structure, not appearance.
- Errors are hard, collected into one list, worded for a person, each with a stable code (§16).
- At the reference size, the runtime draws what a browser draws from the base.
- No `eval`: expressions are interpreted, names come only from the context.

Previous names: the previous namespace prefix, heir file suffix, consumer module name and editor
project folder are still read for one release, with a deprecation warning; see MIGRATION.md.

---

## 15. Public API

The stable entries — `@trempel/scene` (with `PixiBackend`), `@trempel/scene/core` (without it),
`@trempel/scene/node`, `@trempel/scene/view`, `@trempel/scene/editor`, `@trempel/scene/browser*` —
export only this; semver covers exactly this list.

| Area | Exports |
|---|---|
| Parse and compose | `parse`, `parseHeir`, `merge`, `mergeScene`, `composeScene`, `preloadScenes`, `fetchSceneLoader`, `NS`, `HEIR_EXT`, `heirFile`, `isHeirFile`, `sceneStem`; types `SceneNode`, `HeirDoc`, `HeirRef`, `HeirInsert`, `PrefabInstance`, `InstanceScope`, `MergeOutcome`, `MergeOptions`, `SceneSource`, `SceneLoader`, `AsyncSceneLoader`, `ComposeInput`, `Composed`, `ComposeErrors` |
| Mount | `mount`, `mountAsync`, `mountScene`, `mountTree`, `reactive`, `effect`, `PIPES`, `Registry`, `createDefaultRegistry`; types `MountOptions`, `MountArgs`, `MountArgsLoose`, `MountedScene`, `ScenePath`, `PathPoint`, `PipeFn`, `ComponentContext`, `ComponentInit`, `ComponentInstance`, `ComponentFactory` |
| Backend | `PixiBackend` (`@trempel/scene` only); types `RendererBackend`, `NodeHandle`, `Bounds`, `ClipShape`, `PointerKind`, `PixiBackendOptions`, `FontMetricsFn`, `ImageNode` |
| Contract | `parseContract`, `checkContract`; types `Contract`, `ContractNode`, `ContractPattern`, `ViewBoxRule`, `CheckContractOptions` |
| Clips | `Animator`, `compileClips`, `compileClipsResult`; types `Clock`, `SpeedSource`, `PlayOptions`, `Handle`, `ClipSpec`, `AnimatorOptions`, `CompileClipsOptions`, `CompileClipsResult`, `AnimClip`, `Track`, `Keyframe`, `Marker`, `Ease`, `EaseName` |
| Collections | `expandCollection`, `parseProject`, `PROJECT_FILE`; types `ProjectFile`, `CollectionSpec`; node: `loadProject`, `heirsOf`, `findProjectRoot`, `findPackageDir`, `collectionPath`, `isInside`, type `Project` |
| Flatten, check | `flattenScene`, `checkScene`; types `FlattenInput`, `FlattenResult`, `CheckInput`, `CheckResult`; node: `flattenFile`, `sceneStemOf`, `imageSize`, `imageSizeOf`, `mimeOf` |
| The consumer module | `defineView`, `FX_DRAG_MIME` (`@trempel/scene/view`); types `ViewConfig`, `ViewHookArgs`, `ViewClipArgs`, `FontSpec`, `InspectorFactory`, `InspectorHost`, `InspectorPanel`, `InspectorUi` |
| Errors and codes | `TrempelError`, `ExpressionRuntimeError`, `ExpressionError`, `PathDataError`, `trempelError`, `CODES`, `coded`, `codeOf`, `within`; types `Code`, `ExpressionErrorInfo` |

Everything else — geometry (`pathFromNode`, `shapeCommands`…), the hit test, dashes and outlines,
the presentation/layout attribute parsers, expressions and bindings (`compile`, `run`,
`bindingErrors`…), transforms, compatibility helpers, `parseColor` — is internal:
`@trempel/scene/internal/<module>` (e.g. `@trempel/scene/internal/geom/hit`), for the kit and the
editor, with no stability promise. CHANGELOG.md of the package lists where each export of 1.2 went.

---

## 16. Error codes

Every message the package shows a person — mount and check errors, contract violations, expression
errors, clip compile errors, warnings of `flatten` and the compatibility layer, the viewer and the
editor — starts with its code: `E_CODE: message (place)`, a caret line under expressions as before.
`E_…` is an error, `W_…` a warning. The code is the stable part (match it, never the wording); the
catalog is `src/codes.ts`, this section is generated from it (`npm run error-codes`, checked by
`test/codes.test.ts`).

<!-- BEGIN codes (scripts/error-codes.mjs) -->
**XML and documents**

| Code | Meaning |
|---|---|
| `E_XML` | the document is not well-formed XML |
| `E_DOCTYPE` | a `<!DOCTYPE>` or an entity in a scene document (never needed; refused for safety) |
| `E_ROOT` | wrong root element (`<svg>` for a scene or an heir, `<contract>` for a contract) |
| `E_TAG` | an element outside the format (the message lists what is supported) |
| `E_TEXT` | text where the format has none (a `<use>`, a group) |
| `E_EMPTY_SCENE` | nothing to draw: no base and no tml:extends |

**Base, heir, merge**

| Code | Meaning |
|---|---|
| `E_STERILE` | the base carries tml:* attributes — logic lives in the heir |
| `E_DUP_ID` | an id is used more than once in a document |
| `E_REF_NO_ID` | `<tml:ref>` without an id |
| `E_REF_FOREIGN` | `<tml:ref>` with non-tml attributes (geometry and style are edited in the base) |
| `E_REF_TWICE` | the same id referenced by two `<tml:ref>` |
| `E_REF_MISSING` | `<tml:ref>` to an id the base does not have |
| `E_REF_DEFS` | `<tml:ref>` or tml:* on service geometry in `<defs>` |
| `E_REF_HREF` | tml:href on a node that is not an `<image>` |
| `E_INSERT_SYNTAX` | malformed tml:insert (expected 'after `<id>`' or 'into `<id>`') |
| `E_INSERT_TARGET` | tml:insert into or after a node the base does not have |
| `E_INSERT_ROOT` | tml:insert 'after' the root (it has no parent) |
| `E_HEIR_STRAY` | a child of the heir that is neither `<tml:ref>` nor a tml:insert subtree |
| `E_EXTENDS_BASE` | an own base and tml:extends of another scene (one base) |
| `E_EXTENDS_MISSING` | tml:extends names a scene that does not exist |
| `E_EXTENDS_CYCLE` | a tml:extends cycle |

**Transforms, geometry, masks**

| Code | Meaning |
|---|---|
| `E_TRANSFORM` | a transform that cannot be parsed (unknown function, wrong argument count) |
| `E_PATH_DATA` | path data (d) or a geometry attribute that cannot be parsed |
| `E_GEOMETRY` | a node that is not geometry where geometry is needed |
| `E_PATH_SIMILARITY` | a path whose transform stretches or skews it (lengths along it are undefined) |
| `E_DEFS_PLACE` | `<defs>` or `<clipPath>` outside its place, or a child they do not allow |
| `E_CLIP_PATH` | a clip-path value, target or host the format does not allow |
| `E_CLIP_NO_ID` | `<clipPath>` without an id |
| `E_CLIP_UNITS` | clipPathUnits other than userSpaceOnUse |

**Presentation attributes**

| Code | Meaning |
|---|---|
| `E_STYLE` | a style property other than mix-blend-mode |
| `E_BLEND` | an unknown mix-blend-mode, or one on a tag that does not blend |
| `E_BIND_STYLE` | tml:bind-style (blend modes do not switch) |
| `E_TINT` | malformed data-tint, or data-tint on a tag that is not tinted |
| `E_Z` | malformed data-z, or data-z on a node that is not drawn |
| `E_PIVOT` | malformed data-pivot, or data-pivot on a node that is not drawn |
| `E_VIEWS` | malformed data-views, or data-views on a node that is not an `<image>` |
| `E_NUMBER` | an attribute that must be a number is not |
| `E_STROKE` | a stroke attribute (dasharray, dashoffset, linecap, linejoin, pathLength) that is malformed or on a tag without a stroke |

**Layout**

| Code | Meaning |
|---|---|
| `E_SLICES` | malformed data-slices, or data-slices on a tag that is not an `<image>` |
| `E_TILE` | data-tile on a tag that is not an `<image>`, or together with data-slices |
| `E_ANCHOR` | malformed data-anchor |
| `E_AXES` | an axes value other than x, y or xy (data-stretch, data-tile, data-resizable) |
| `E_SIZE` | malformed data-size |
| `E_ASPECT` | a malformed preserveAspectRatio on an `<image>`, or one with data-slices / data-tile |
| `E_STRETCH` | data-stretch on a node that cannot stretch, or without a size |
| `E_NO_BOX` | an anchored or stretched node whose parent is not a box |
| `E_RESIZABLE` | data-resizable misplaced, without a viewBox or without a stretching background |

**Expressions and bindings**

| Code | Meaning |
|---|---|
| `E_EXPR_SYNTAX` | an expression that cannot be parsed (the message has the position and a caret) |
| `E_EXPR_UNDEF` | a name the expression context does not define |
| `E_EXPR_FIELD` | reading a field of undefined or null |
| `E_EXPR_FORBIDDEN` | access to a forbidden member (constructor, prototype, __proto__…) |
| `E_EXPR_CALL` | calling something that is not a function |
| `E_EXPR_RUNTIME` | an expression failed at run time (the cause is attached) |
| `E_PIPE_UNKNOWN` | an unknown pipe |
| `E_BIND_DEFAULT` | tml:bind on a tag without a default property (use tml:bind-`<attr>`) |
| `E_SELF_CALL` | self.call() of a function the scene context does not have |

**Prefabs and slots**

| Code | Meaning |
|---|---|
| `E_USE_NO_ID` | a `<use>` instance without an id |
| `E_USE_NO_HREF` | a `<use>` instance without an href |
| `E_USE_ATTR` | an attribute an instance does not take (instances are configured by data-* parameters and transform) |
| `E_PARAM_RESERVED` | a parameter named data-id, data-call, data-state or data-set |
| `E_PARAM_MISSING` | a required parameter (contract params) not set |
| `E_PREFAB_CYCLE` | a prefab cycle |
| `E_PREFAB_MISSING` | a prefab that does not exist or failed to load |
| `E_PROJECT_HEIR` | a project heir that is not an heir of its collection document, or two heirs of one document |
| `E_PREFAB_LOADER` | no scene loader, or an asynchronous one for mount() (use mountAsync) |
| `E_PREFAB_RESIZE` | width/height on an instance of a prefab that does not resize along that axis |
| `E_PREFAB_MIN_SIZE` | an instance smaller than its prefab’s viewBox (the minimum size) |
| `E_SLOT` | a malformed slot (not a `<g>`, a name twice, two defaults) |
| `E_SLOT_UNKNOWN` | a child of `<use>` for a slot the prefab does not have |

**The contract**

| Code | Meaning |
|---|---|
| `E_CONTRACT_SYNTAX` | a contract that cannot be read (attribute values, id and match together, children of a pattern) |
| `E_CONTRACT_MISSING` | a node the contract requires is missing from the base |
| `E_CONTRACT_TWICE` | a node the contract requires is in the base more than once |
| `E_CONTRACT_TAG` | a node of another tag (or not an instance of the prefab) than the contract says |
| `E_CONTRACT_EMPTY` | a node the contract wants empty has children |
| `E_CONTRACT_ATTR` | a base attribute the contract requires is missing (attrs, anchor, slices, params, resizable) |
| `E_CONTRACT_PLACE` | a node outside the node the contract puts it in |
| `E_CONTRACT_VIEWBOX` | the base viewBox breaks the contract rule (value, list, aspect) |
| `E_CONTRACT_COUNT` | a pattern matches a number of nodes the contract does not allow |
| `E_CONTRACT_PARTNER` | a pattern match without its required partner node |
| `E_CONTRACT_SLOT` | a group the contract wants as a slot is not marked tml:slot |

**Collections and the project**

| Code | Meaning |
|---|---|
| `E_COLLECTION_UNKNOWN` | an @name/… href to a collection the project does not declare |
| `E_PROJECT` | .trempel/project.mdz: a malformed or missing collection |

**Md clips**

| Code | Meaning |
|---|---|
| `E_ANIM_SYNTAX` | an md clip file that cannot be read (blocks, attributes, tables) |
| `E_ANIM_COLUMN` | an unknown or conflicting column in a clip table |
| `E_ANIM_VALUE` | a cell value of the wrong kind (number, colour, integer, range) |
| `E_ANIM_TIME` | a key time that is not a number ≥ 0, not ascending, or past $duration |
| `E_ANIM_EASE` | an unknown ease |
| `E_ANIM_TARGET` | a clip target that does not exist, is in `<defs>`, or cannot take the column |
| `E_ANIM_TEX` | a malformed $tex template or table |
| `E_ANIM_MOTION` | a motion track that is inconsistent ($path, $orient, $offset, x/y, rotation) |
| `E_ANIM_TWICE` | a property of a target keyed twice in one clip, or a clip name twice |
| `E_ANIM_UNKNOWN` | a clip name the scene’s clip files do not have |
| `E_ANIM_PLAY` | a clip that cannot be played (motion without a path, no rest pose) |
| `E_ANIM_PARAM` | a clip parameter ($name cell) not given at play time, or not a number |

**Runtime: mounting, the backend, the scene API**

| Code | Meaning |
|---|---|
| `E_NO_REGISTRY` | tml:type without a component registry |
| `E_COMPONENT` | an unknown component, or a component API used outside a scene |
| `E_NODE` | a scene API call (path, hitTest, setView, setSize) with an id the scene does not have |
| `E_VIEW` | an unknown data-views variant, or no `<image>` with data-views |
| `E_BACKEND` | the backend lacks what the scene needs (setClip, onPointer, getProp) or got a bad value |
| `E_TEXTURE` | a texture did not load |
| `E_SLICES_FIT` | data-slices do not fit the texture (the centre needs at least 1 px) |
| `E_RESIZE` | resize or setSize the scene cannot do |
| `E_FETCH` | a document could not be fetched |

**Tools: flatten, check, the viewer**

| Code | Meaning |
|---|---|
| `E_STATE` | stand-in state that is not a JSON object |
| `E_IMAGE_MISSING` | an image file that does not exist |
| `E_FLATTEN_LEFTOVER` | flatten output still has tml:, data-* or @-hrefs |
| `E_CLI` | a command-line usage error |
| `W_FLATTEN` | something vanilla SVG cannot show (a component, a clip, a binding, an unknown image size) |
| `W_CONTEXT_STUB` | names the scene uses that nobody provides — the viewer stubs them |

**The editor**

| Code | Meaning |
|---|---|
| `E_EDITOR_COMMAND` | an unknown editor command |
| `E_EDITOR_ARGS` | command arguments that do not fit its schema (type, required, unknown, range, pattern) |
| `E_EDITOR_API` | EditorDocument misused (an unknown event, end/abort without begin) |
| `E_EDITOR_NO_NODE` | a node reference (id or index path) that matches no node |
| `E_EDITOR_NODE_AMBIGUOUS` | an id used by several nodes — address the node by its index path |
| `E_EDITOR_INDEX` | a child index out of range |
| `E_EDITOR_ID_TAKEN` | a new id that is already in the document |
| `E_EDITOR_ATTR` | an attribute the command does not set (xmlns, id outside node.setId) |
| `E_EDITOR_TAG` | a command applied to a node of a tag it does not work on |
| `E_EDITOR_ROOT` | a command the root `<svg>` cannot take (remove, move, copy, transform) |
| `E_EDITOR_VALUE` | an attribute value the command cannot work with (a list, not a number, a degenerate transform) |
| `E_EDITOR_TEXT` | replacing the text of an element with element children |
| `E_EDITOR_FRAGMENT` | an XML fragment that is not exactly one element, or is an `<svg>` |
| `E_EDITOR_REPARENT` | a node moved into itself |
| `E_EDITOR_PATH` | an impossible path edit (no such point, segment or subpath; a handle without a segment; the last point) |
| `E_EDITOR_NOT_INSTANCE` | a prefab command on a node that is not a `<use>` instance |
| `E_EDITOR_NOT_EXPANDED` | an instance that is not expanded (the prefab is missing or has errors) |
| `E_EDITOR_PARAM` | a prefab parameter that cannot be one (a presentation attribute, not a child of the group, the wrong tag) |
| `E_EDITOR_NO_ID` | a group without an id where the command needs one (prefab.extract) |
| `E_EDITOR_FILE_EXISTS` | a file the command would create already exists |
| `E_EDITOR_CLIP_NONE` | a clip the md clip file does not have |
| `E_EDITOR_CLIP_TAKEN` | a clip name the md clip file already has |
| `E_EDITOR_CLIP_TRACK` | a track (## $track) the clip does not have, or a column it already keys |
| `E_EDITOR_CLIP_KEY` | a key the track does not have, or a key moved onto another key of its column |
| `E_EDITOR_CLIP_EVENT` | an event ($events) the clip does not have |
| `E_EDITOR_CLIP_VALUE` | a clip cell or attribute value of the wrong kind (a string in a number column, \| in a cell) |
| `E_EDITOR_NO_HEIR` | an heir command on a scene without an heir (X.tml.svg) |
| `E_EDITOR_READONLY` | a base command on a scene whose base lives in another scene (tml:extends) — read-only here |
| `W_EDITOR_CLIP_REF` | a clip refers to a renamed or removed id |
| `W_EDITOR_PATH_REWRITTEN` | d rewritten as absolute M L C Z (arcs approximated by cubics) |
| `W_EDITOR_DETACH` | prefab logic (the tml of its heir) is not carried into a detached copy |
| `W_EDITOR_EXTRACT` | prefab.extract changed an id or left a clip-path outside the prefab |
| `E_EDIT_NO_SCENE` | no scene is open or drawn in the editor |
| `E_EDIT_NO_BASE` | a scene without its base X.svg (the editor edits only the base) |
| `E_EDIT_NODE` | a node (id or index path) the open scene does not have |
| `E_EDIT_SELECTION` | nothing selected for an action that needs a selection |
| `W_EDIT_SELECTION` | an editor action that does not apply to the selected nodes |
| `E_EDIT_ARGS` | malformed arguments of a tml call, an operator or a command field |
| `E_EDIT_SINGULAR` | a degenerate transform (scale 0) cannot be inverted |
| `E_EDIT_SCENE` | a scene the open folder does not have |
| `E_EDIT_CLIP` | a clip the scene does not have, no clips, or no clip selected |
| `E_EDIT_REC` | a recorded edit (● Rec) that cannot become clip keys (a node without an id) |
| `E_EDIT_HOST` | a feature only the editor page provides (clips, reference, snapshots, prefabs) |
| `E_EDIT_NO_PAGE` | the agent bridge has no open editor page to run in (or it did not answer) |
| `E_EDIT_SCRIPT` | a console script or macro failed (or the page CSP forbids running scripts) |
| `E_EDIT_MACRO` | a macro the folder does not have |
| `W_EDIT_MACRO` | a macro file that could not be read |
| `E_EDIT_WRITE` | a file could not be written to the folder |
| `E_EDIT_SNAPSHOT` | the video snapshot failed |
| `W_EDIT_SNAPSHOT` | the video snapshot could not be written to the folder — offered as a download |
| `E_EDIT_REFERENCE` | the reference picture could not be loaded |
| `E_EDIT_RENDER` | the stage failed to render the scene |
| `W_EDIT_PREVIEW` | a prefab preview could not be drawn |
| `W_EDIT_OUTSIDE` | a prefab outside the open folder (the editor cannot see it) |
| `W_EDIT_COMPONENT` | components without an implementation — their base is drawn |
| `W_EDIT_DISK` | a file changed on disk while the editor has unsaved changes |
| `W_EDIT_READ_ONLY` | the stage is read-only (a clip is posed) |

**The viewer**

| Code | Meaning |
|---|---|
| `E_VIEW_ACCESS` | a path outside the scene folder, the project and its collections, or in a service folder |
| `E_VIEW_WRITE` | a write the dev server refuses (read-only folder, an heir, not a base, not renders/*.png) |
| `E_VIEW_REQUEST` | a malformed request to the dev server |
| `E_VIEW_MODULE` | the folder view module (trempel.view.ts) failed: loading, setup(), context(), onMount() |
| `E_VIEW_VIEWPORT` | a viewport that cannot be parsed (expected scene, W:H or WxH) |
| `W_VIEW_HEIR` | the heir is not applied — the base is shown without it |
| `W_VIEW_TEXTURE_TIMEOUT` | textures did not load within the timeout |

**Compatibility (one release)**

| Code | Meaning |
|---|---|
| `W_COMPAT_GML` | the previous namespace prefix (gml:) — write tml: |
| `W_COMPAT_HEIR` | an heir under the previous file suffix |
| `W_COMPAT_VIEW_MODULE` | a consumer module under the previous name |
| `W_COMPAT_PROJECT_DIR` | a project folder under the previous name |
<!-- END codes -->

---

## 17. Changelog

- **0.5** — two-document model: sterile base SVG + heir (`<tml:ref>`, `tml:insert`, `tml:extends`) + contract (exact node lines, `empty`, viewBox, unique ids, sterility); merge errors collected into one list.
- **0.6** — own expression language without `eval` (grammar, pipes everywhere, `money`), full SVG `transform`, SVG-faithful rendering (opacity, display, baseline text, CSS colours, rect stroke), `MountedScene.ready`, `baseUrl`/`resolveHref`, contract viewBox rules (`any`, lists, `aspect`) and pattern lines (`match`, `count`, `in`, `requires`); 0.6.1: extensible `PixiBackend.createImage`, loud runtime expression errors (`onError`, `lenient`).
- **0.7** — geometry (`path`, `circle`, `ellipse`, `line`), `<defs>`, `<clipPath>`/`clip-path` masks, md clips compiled to JSON with relative tracks and `tex`, motion along a path, `MountedScene.path`, component parameters from base `data-*` (`ctx.param`), contract `attrs`.
- **0.8** — `mix-blend-mode`, `data-tint`, `data-z`, `data-views`, `data-pivot`; clip columns `tint`, `z`, `skewX`/`skewY`, `view`.
- **0.9** — prefabs: `<use href>` instances with parameters and `self`, composite ids, multi-level `tml:extends`, `tml:href`, pointer events, `tml:bind-view`, contract `<use>` lines and `params`, scene loaders and `mountAsync`; 0.9.1: stroke dashes/caps/joins and `pathLength`, hidden-but-hittable geometry, geometry hit test, clip columns `dash`/`strokeWidth`/`strokeAlpha`, `$tex` in md clips, nested contract lines.
- **1.0** — 9-slice (`data-slices`) and tiling (`data-tile`), boxes with `data-anchor`/`data-stretch`/`data-size`, resizable prefabs (`data-resizable`, `<use width height>`), slots (`tml:slot`), clip columns `width`/`height`, `resize`/`setSize`/`sizeOf`; the format is published as Trempel (`tml:` namespace, `*.tml.svg` heirs, `trempel.view.ts`, `.trempel/`).
- **1.1** — collections: `@name/path` hrefs into named folders (`.trempel/project.mdz`, folders from the project root or `npm:` packages), `collections` in `MountOptions` / `defineView`, resolved before `baseUrl`/`resolveHref`, unknown name — an error, contract `href` compared by the resolved file; the dev server serves the project root and the collections; the editor's palette groups a collection's prefabs and writes `@name/…`; `flatten` — any scene as one vanilla SVG (`--embed`, `--state`; `@trempel/scene/node`, bin `trempel-flatten`); `migrate-collections.mjs`.
- **1.3** (package 2.0) — what a real game needed: an instance's context inherits the scene's (names added after the mount — a game's actions — are seen inside prefabs); clip parameters (`$name` number cells, `play(clip, { params })`, `E_ANIM_PARAM`); `preserveAspectRatio` of an `<image>` (meet / slice, `E_ASPECT`); an heir of the project extending a collection document, and project heirs — every instance of a collection document is built with the project's heir over the collection's (`heirs` in `MountOptions`, found by the Node tools, `E_PROJECT_HEIR`).
- **2.0** (package; the format stays 1.2) — every message in English with a code (§16); `<!DOCTYPE>` and entities are refused (`E_DOCTYPE`); a narrow stable API (§15), the rest under `@trempel/scene/internal/*`; `checkScene`; `@trempel/scene/view`; the examples of this document are tests.
- **2.2** (package; the format stays 1.3) — the consumer module's `onClipTime` (§11): the viewer and the editor report the clip time shown and the markers crossed, so effects fired by clip markers are drawn at that moment; `view:shot` settles to fixed moments of its virtual clock (a picture that lives in time is the same every run).
- **2.3** (package; the format stays 1.3) — the consumer module's `inspectors` (§11): the editor shows a consumer's panels for its components' nodes (the kit's particle editor), their palettes and agent APIs. The editor (not the format): md clips edited by commands with a minimal diff (the timeline), the heir's two effect edits (`heir.setAttr`, `heir.insertFx`), scenes extending another one edited (their clips and effects), the agent's bridge into the open page (`trempel-edit`).
- **1.2** — no format changes. The runtime has no built-in components: the demo grid component of 1.1 left `createDefaultRegistry()`, which is now an empty registry — games register their own. The repository is a monorepo: `@trempel/scene` and the game kit `@trempel/kit` (screens, popups, layout, UI components, a default skin as the collection `npm:@trempel/kit/skins/default/ui`), versioned together.
