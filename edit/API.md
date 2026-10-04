# tml — API редактора сцен для скриптов

<!-- Сгенерировано: npm run editor:commands (из edit/app/tml.ts и реестра команд). Не править руками. -->

`window.tml` — редактор сцен Trempel одним объектом: консоль (вкладка «Консоль», ⌘Enter), макросы (`<папка сцен>/.trempel/macros/*.js`, ⌘K), агент (`tml.run(code)`). Правится **база** сцены (`X.svg`, ванильный SVG): только командами ядра — `tml.doc.exec(name, args)`. Узел — `id` или путь индексов элементов от корня (`"0/3/1"`). Координаты команд — пространство **родителя** узла; `tml.bounds` и `tml.moveBy` — единицы **сцены** (viewBox).

- Скрипт = тело async-функции с `tml` и `console`; одно выражение возвращается само. Весь `tml.run` — **одна** запись undo; исключение откатывает всё. Ошибка команды — не исключение: `{ ok: false, errors }`.
- После команд сцена перерисовывается асинхронно: `bounds` и `scene` — с прошлой отрисовки, свежие — после `await tml.idle()`.
- Макрос — тот же скрипт в файле, первая строка `// name: Подпись`.

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
  /** «Снимок для видео»: the rest pose (a clip is stopped) at 1:1 on `background` (null —
   *  transparent; omitted — the panel's) → renders/<scene>-<time>.png; returns its path. */
  snapshot(opts?: { background?: string | null }): Promise<string>;
  /** Prefabs (v0.9): list() — scenes to place ("ui/button.svg"); place(prefab, at?) — a <use> at a scene
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

## Команды — `tml.doc.exec(name, args)`, пачкой — `tml.doc.batch(label, [{ name, args }])`

| команда | аргументы | что делает |
|---|---|---|
| `node.setAttr` | `node`: string, `name`: string, `value`: string \| number \| null | Задать атрибут узла (value: null — удалить). tml:* в базе запрещены; id — через node.setId. |
| `node.setId` | `node`: string, `id`: string | Переименовать узел; ссылки clip-path="url(#…)" в документе обновляются, клипы — предупреждение. |
| `node.setText` | `node`: string, `text`: string | Заменить текст `<text>` (макетная строка базы; биндинг наследника его перекрывает). |
| `node.move` | `node`: string, `dx`: number, `dy`: number | Сдвинуть узел на (dx, dy) в координатах родителя: translate у `<g>`, x/y, cx/cy, x1…y2, точки d. |
| `node.setTransform` | `node`: string, `translate?`: [x, y], `rotate?`: number, `scale?`: number \| [x, y], `pivot?`: [x, y] | Пересобрать transform из частей: translate(t+pivot) rotate scale translate(-pivot). Без частей — transform снимается. pivot по умолчанию — data-pivot узла. |
| `node.setPivot` | `node`: string, `x`: number, `y`: number, `keepWorld?`: boolean | Пивот узла (data-pivot="x y", его собственное пространство до transform): вокруг него вращение и масштаб — ручками, клипами, setTransform. keepWorld (по умолчанию true) — узел на месте (матрица та же); false — части transform (сдвиг, поворот, масштаб) остаются числами, но теперь вокруг нового пивота (узел смещается). |
| `node.resize` | `node`: string, `width?`: number \| null, `height?`: number \| null | Размер узла (v1.0): `<image>` — width/height (у data-slices это размер панели, борта 1:1), `<rect>` — width/height, `<g data-size>` — data-size, инстанс растягиваемого префаба (`<use>`, data-resizable) — width/height по его осям (null — снять: минимальный размер). Ось без значения не меняется. |
| `node.reorder` | `node`: string, `index`: integer | Поставить узел на место index среди соседей (z-order: 0 — самый нижний). |
| `node.reparent` | `node`: string, `parent`: string, `index?`: integer | Перенести узел в другого родителя (index — место среди его детей, по умолчанию последним); мировая позиция сохраняется. |
| `node.insert` | `parent`: string, `index?`: integer, `xml`: string | Вставить XML-фрагмент (ровно один элемент) в parent на место index (по умолчанию последним). |
| `node.remove` | `node`: string | Удалить узел с поддеревом. |
| `node.duplicate` | `node`: string, `idSuffix?`: string | Копия узла сразу после него; id в копии — с суффиксом (по умолчанию -2, -3… до свободного). |
| `path.setData` | `node`: string, `d`: string | Заменить d пути целиком. |
| `path.setPoint` | `node`: string, `index`: integer, `x`: number, `y`: number | Передвинуть точку index контура (ручки едут с ней). |
| `path.setHandle` | `node`: string, `index`: integer, `which`: 'in' \| 'out', `x`: number, `y`: number, `linked?`: boolean | Поставить ручку Безье точки index (which: in — входящая, out — исходящая); linked — зеркалить противоположную. |
| `path.insertPoint` | `node`: string, `segment`: integer, `t`: number | Разрезать сегмент segment в t (0<t<1) с сохранением формы; сегменты — L/C по порядку и замыкающая линия Z. |
| `path.removePoint` | `node`: string, `index`: integer | Удалить точку index; соседние сегменты сшиваются в один. |
| `path.close` | `node`: string, `subpath?`: integer | Замкнуть подконтур (Z); subpath — номер, по умолчанию последний. |
| `path.open` | `node`: string, `subpath?`: integer | Разомкнуть подконтур (убрать Z); subpath — номер, по умолчанию последний. |
| `path.setNodeType` | `node`: string, `index`: integer, `type`: 'corner' \| 'smooth' | Тип узла index: smooth — выровнять ручки на одну прямую (длины сохраняются), corner — ручки независимы. |
| `defs.ensure` | — | Создать `<defs id="defs">` первым ребёнком корня, если его нет. |
| `clip.create` | `id`: string, `shape`: 'rect' \| 'path', `attrs`: object | Создать `<clipPath id>` в `<defs>` с одной фигурой (shape: rect \| path, attrs — её атрибуты: x y width height rx \| d). |
| `clip.assign` | `node`: string, `clip`: string \| null | Назначить узлу (`<g>`, `<image>`) маску: clip-path="url(#clip)"; clip: null — снять. |
| `layer.create` | `parent?`: string, `id`: string, `index?`: integer | Создать пустой слой `<g id>` в parent (по умолчанию корень) на месте index (по умолчанию последним). |
| `prefab.instantiate` | `parent?`: string, `href`: string, `id`: string, `x?`: number, `y?`: number, `params?`: object, `index?`: integer | Поставить инстанс префаба: `<use id href x y data-*>` в parent (по умолчанию корень) на место index (по умолчанию последним). |
| `prefab.setParam` | `node`: string, `name`: string, `value`: string \| null | Параметр инстанса: data-`<name>` на `<use>` (value: null — снять, остаётся значение по умолчанию префаба). |
| `prefab.detach` | `node`: string | Развернуть инстанс в копию: `<g>` с содержимым префаба (id с префиксом остаются, вложенные инстансы — `<use>`); связь с префабом рвётся, обратной операции нет. |
| `prefab.extract` | `node`: string, `href`: string, `params?`: object[] | Выделенный `<g>` → новый префаб href (файл базы, при params — и наследник) + `<use>` на его месте. params: какие href картинок / тексты детей станут параметрами. |

## Примеры

```js
tml.nodes().filter(n => n.tag === 'image').length              // сколько картинок
tml.doc.exec('node.move', { node: 'settingsBtn', dx: 10, dy: 0 })
for (const id of tml.selection) tml.moveBy(id, 0, -20)          // выделение вверх на 20 единиц сцены
tml.doc.errors                                                   // контракт, геометрия, клипы — после каждой команды
await tml.save()
```
