# Trempel scene format — v1.0

This is the single, current specification of the Trempel scene format, as implemented by the
npm package `@trempel/scene` 1.0. When this document and the code disagree, the code in `src/` is
authoritative and this document is the bug.

Trempel is an agent-first 2D engine on PixiJS. The format comes first, the editor second: scenes
are plain text that an agent (or a person) writes and reviews, and that any SVG tool can open.

| Entry point | What it is |
|---|---|
| `@trempel/scene` | everything: the core plus `PixiBackend`; `mountAsync` fetches prefabs by default |
| `@trempel/scene/core` | the renderer-agnostic core (parse, merge, contract, expressions, layout, clips, player) — no `pixi.js` import; for CLIs, level tools, tests |
| `@trempel/scene/editor` | the editor core: a document model with undoable commands |
| `@trempel/scene/edit` | the editor app (page, style sheet, library entry) |

Runtime dependencies are `@xmldom/xmldom` and `svg-path-properties`; `pixi.js` (^8.5) is an
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
6. **Errors are collected, not thrown one at a time**, and phrased for a person ("`#reels` must be
   an empty group — it has 3 children; the component will overwrite them"), with the node (`#id`
   or `<tag>`), the file and, for expressions, a position with a caret. (The runtime's messages are
   currently worded in Russian; the meaning given in this document is what counts.)
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
(`.errors: string[]`, deduplicated). `composeScene()` returns them by stage
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

"Shapes" = `path`, `circle`, `ellipse`, `line`, `rect`. Stroke dash/cap/join/`pathLength` on any
other tag is an error; units and percentages are errors. Not supported: `preserveAspectRatio`
(images stretch to their box), `tspan`, non-px font sizes, `vector-effect`, `stroke-miterlimit`,
CSS `filter`, soft masks.

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
  <tml:ref id="reels" tml:type="reel-grid" tml:cols="5" tml:rows="3"/>
  <tml:ref id="balance" tml:bind="state.balance | money"/>
  <tml:ref id="winLabel" tml:bind="state.win | money" tml:visible="state.win > 0"/>
  <tml:ref id="spinBtn" tml:on-click="spin()"/>

  <g id="bigWin" tml:insert="after reels" tml:visible="state.phase == 'bigwin'">
    <text x="640" y="400" font-size="96" tml:bind="state.win | money"/>
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
(`new Registry().register('reel-grid', factory)`); `createDefaultRegistry()` has the built-in
`reel-grid` (a cols×rows symbol grid of a generic slot). Instances are in `MountedScene.components`
by node id.

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
- Names resolve **only** against the own keys of the mount context (`{ state, t, spin, … }`).
  There are no globals: `Math`, `window`, `globalThis` are "name not defined".
- Calls: context functions (`spin()`, `buy(1, 'x')`) and methods of values
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

- **Syntax** errors and unknown pipes are hard mount errors in the common list (and in the
  checker), with the node, attribute, position and a caret under the source line.
- **Runtime** errors (field of `undefined`/`null`, unknown name, calling a non-function, a throwing
  context function or pipe) follow the mount options:

| `MountOptions` | Behaviour |
|---|---|
| (default) | throws `ExpressionRuntimeError { node, attr, expr, error }` (`cause` = `error`) — from `mount()` on first evaluation, from the state write that re-ran a binding, or from the event handler |
| `onError(info)` | receives `{ node, attr, expr, error }`; the write is skipped (the node keeps its last value), a failed handler does nothing |
| `lenient: true` | silent: `undefined` is written (`visible` → `false`), handler errors are swallowed; `onError` is still called if given |

`evalExpression` / `evalBinding` remain lenient helpers (an error yields `undefined`).

### 5.4 Context and reactivity

`mount({ context })` is the expression context; values made with `reactive()` (typically
`context.state`) re-run the bindings that read them (`effect()`). In the viewer and editor the
context is `{ state }` from `X.state.json`, plus what the consumer module adds (§11); names the
scene uses that nobody provides become logging stubs.

### 5.5 `self` — expressions inside a prefab

A node that comes from a prefab evaluates in the **scene's** context (the prefab is not isolated)
plus `self`:

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

Errors inside a prefab are prefixed with the instance: `#a (bad.svg): <tml:ref id="nope">: no such id`.

### 6.4 Paths

Every document is addressed by its path from the top scene's folder. Hrefs inside a prefab
(`<image href>`, `data-views`, nested `<use>`, `tml:href`, and `data-*` parameters that look like an
image path — `.png .jpg .jpeg .webp .gif .avif .svg`) are rebased into that space on load; after
expansion the whole tree resolves against the scene document like its own hrefs (`baseUrl` /
`resolveHref`, §10).

### 6.5 Overrides and multi-level inheritance

- The scene's heir addresses nodes of an instance by composite id —
  `<tml:ref id="playBtn/label" tml:bind="t('play')"/>`, `tml:insert="into box/content"` — its `tml:*`
  win over the prefab's (last wins); `<tml:ref id="playBtn">` targets the instance group. Geometry
  and style still cannot be overridden.
- An heir **without its own base** whose `tml:extends` names another scene takes that scene's
  **result** (base + instances + heir) as its base — e.g. `ui/button-green.tml.svg`:

  ```svg
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"
       tml:extends="button.svg" data-label="OK">
    <tml:ref id="bg" tml:href="art/green.png"/>
  </svg>
  ```

- Chains resolve recursively, any depth, for prefabs and top scenes alike (`mount({ heir })`
  without `base`). A cycle is an error (`tml:extends cycle: top.svg → a.svg → b.svg → a.svg`).
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
  <g id="reels" empty="true" attrs="data-cols data-rows"/>
  <text id="balance"/>
  <use id="spinBtn" href="ui/button.svg"/>
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
$tex: art/{}.png              ← file template (before the first clip)
# $clip win
$tex: fx/{}.webp              ← clip template
## $tex                       ← clip table: names one by one
| name   | href             |
|--------|------------------|
| coin_0 | coins/gold-0.png |
## $track coin
$tex: coins/{}.png            ← track template
| t | tex    |
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
  `play(clip, { targets, speed, onMarker }) → { abort(), done }`; `parallel(...)`, `sequence([...])`;
  `speed` may be a getter read every frame; call `tick()` once per frame.
- Compiling: `compileClips(md, scene?, { tex? })` throws a `TrempelError` with every problem
  (`$clip bad / $track box, row 3: x="a" — not a number`); `compileClipsResult(...)` returns
  `{ clips, errors }`. Repository CLI: `npm run anim:compile -- x.md [--scene dir] [--out x.json] [--tex …]`.

---

## 10. Mounting and readiness

```ts
import { mountAsync, PixiBackend, createDefaultRegistry, reactive } from '@trempel/scene';

const state = reactive({ balance: 1000, win: 0, phase: 'idle' });
const scene = await mountAsync({
  base, heir, contract,                 // document texts (base optional with tml:extends)
  backend: new PixiBackend(),
  context: { state, spin },
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
`loadScene?`, `sceneUrl?`, `onError?`, `lenient?`; mount args add `base?`, `heir?`, `contract?`,
`path?`.

**Hrefs.** With `baseUrl` (the scene document's URL or path) relative image hrefs — attributes of
base and heir, bound `href` values, hrefs components set through `ctx.backend` — resolve against it
like in a browser; absolute ones (`scheme:`, `/path`, `#`) are untouched. `resolveHref` is applied
after `baseUrl` (a bundler's hashed-URL table, a skin lookup). `ctx.resolveHref` exposes the same for
assets a component loads itself. Without either, hrefs reach the backend as written.

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
| `background` | stage background colour |
| `prefabs` | prefab folders for the editor palette, e.g. `['ui']` |

The editor keeps per-project data (macros) in a `.trempel/` folder.

---

## 12. Invariants

- The base is sterile: no `tml:*`. Validated, never assumed.
- Geometry and style belong to the base; the heir does not override non-`tml` attributes (sole
  exception: `tml:href` on an image).
- The contract is structure, not appearance.
- Errors are hard, collected into one list, worded for a person.
- At the reference size, the runtime draws what a browser draws from the base.
- No `eval`: expressions are interpreted, names come only from the context.

Previous names: the previous namespace prefix, heir file suffix, consumer module name and editor
project folder are still read for one release, with a deprecation warning; see MIGRATION.md.

---

## 13. Changelog

- **0.5** — two-document model: sterile base SVG + heir (`<tml:ref>`, `tml:insert`, `tml:extends`) + contract (exact node lines, `empty`, viewBox, unique ids, sterility); merge errors collected into one list.
- **0.6** — own expression language without `eval` (grammar, pipes everywhere, `money`), full SVG `transform`, SVG-faithful rendering (opacity, display, baseline text, CSS colours, rect stroke), `MountedScene.ready`, `baseUrl`/`resolveHref`, contract viewBox rules (`any`, lists, `aspect`) and pattern lines (`match`, `count`, `in`, `requires`); 0.6.1: extensible `PixiBackend.createImage`, loud runtime expression errors (`onError`, `lenient`).
- **0.7** — geometry (`path`, `circle`, `ellipse`, `line`), `<defs>`, `<clipPath>`/`clip-path` masks, md clips compiled to JSON with relative tracks and `tex`, motion along a path, `MountedScene.path`, component parameters from base `data-*` (`ctx.param`), contract `attrs`.
- **0.8** — `mix-blend-mode`, `data-tint`, `data-z`, `data-views`, `data-pivot`; clip columns `tint`, `z`, `skewX`/`skewY`, `view`.
- **0.9** — prefabs: `<use href>` instances with parameters and `self`, composite ids, multi-level `tml:extends`, `tml:href`, pointer events, `tml:bind-view`, contract `<use>` lines and `params`, scene loaders and `mountAsync`; 0.9.1: stroke dashes/caps/joins and `pathLength`, hidden-but-hittable geometry, geometry hit test, clip columns `dash`/`strokeWidth`/`strokeAlpha`, `$tex` in md clips, nested contract lines.
- **1.0** — 9-slice (`data-slices`) and tiling (`data-tile`), boxes with `data-anchor`/`data-stretch`/`data-size`, resizable prefabs (`data-resizable`, `<use width height>`), slots (`tml:slot`), clip columns `width`/`height`, `resize`/`setSize`/`sizeOf`; the format is published as Trempel (`tml:` namespace, `*.tml.svg` heirs, `trempel.view.ts`, `.trempel/`).
