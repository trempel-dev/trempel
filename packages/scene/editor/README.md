# @trempel/scene/editor — ядро редактора сцен

Без браузерного DOM и Pixi: работает в Node (тесты, headless-агент) и в браузере. Документ — XML-DOM **базы** (`@xmldom/xmldom`) с памятью исходного текста: без команд `serialize()` возвращает исходник байт в байт, правка меняет только свои атрибуты. Спека — `../trempel.dev/specs/editor-core.md`.

```ts
import { openDocument, commands } from '@trempel/scene/editor';

const doc = openDocument(svg, { contract, heir, clips: { 'anim/x.md': md }, path: 'scenes/game.svg' });
doc.exec('node.move', { node: 'backBtn', dx: 10, dy: 0 });   // { ok, changed, errors?, warnings? }
doc.batch('разложить', [{ name: 'node.move', args: {…} }, …]); // одна запись undo; ошибка — откат всей пачки
doc.begin('скрипт'); …; doc.end();                              // всё между — одна запись undo (с await внутри; вложенные — в общую); doc.abort() — откат группы
doc.undo(); doc.redo(); doc.history;                           // [{ label, at }]
doc.errors;      // контракт + tml в базе + id + геометрия + merge наследника + клипы — после каждой команды
doc.scene;       // SceneNode базы; doc.merged — с наследником
doc.serialize(); // SVG базы; doc.dirty / doc.markClean()
doc.tree();      // [{ id?, tag, path: "0/3", children, bounds? }] — bounds заполняет UI
doc.on('change', (e) => …);                                    // exec | batch | undo | redo
commands;        // { [name]: { schema: JSONSchema7, describe } } — тулы для UI и агента
```

- Узел адресуется по `id` или путём индексов элементов от корня (`"0/3/1"`; `""` — корень).
- Координаты — пространство родителя узла; экран↔локальные — дело UI.
- Числа пишутся с ≤ 2 знаками после запятой (коэффициенты `matrix()`/`scale()` — 6).
- Path-команды работают с абсолютными `M L C Z`: на первой правке относительные, `H V S T Q A` переписываются (дуги — кубиками), в `warnings` об этом есть строка. Точки (`index`) — каждый M/L/C; сегменты (`segment`) — каждый L/C и ненулевая замыкающая линия Z.
- Ошибка аргументов (схема) или команды — `ok: false`, документ не меняется. Ошибки валидации не блокируют: команда применяется, проблема — в `doc.errors`.

### Префабы (v0.9)

```ts
const doc = openDocument(svg, { heir, contract, path: 'menu.svg', loadScene: (rel) => ({ base, heir?, contract? }) | null });
doc.merged;                       // сцена с развёрнутыми инстансами (<use> → <g>, id «btn/label»)
doc.instance('playBtn');          // { id, href, params: [{ name, value, own, required, default? }], missing, expanded }
doc.exec('prefab.instantiate', { href: 'ui/button.svg', id: 'ok', x: 10, y: 20, params: { label: 'OK', action: 'close' } });
const r = doc.exec('prefab.extract', { node: 'badge', href: 'ui/badge.svg' }); // r.files — [{ path, text }]: записывает хост
doc.refresh();                    // префаб изменился на диске — перепроверить (загрузчик уже отдаёт новый текст)
```

- `loadScene(rel)` — синхронный: `rel` — путь относительно папки сцены; хост держит кэш (редактор — `Editor.loadPrefabs`).
- Инстанс в базе — один ванильный `<use>`; внутренности правятся в префабе. `node.move` двигает `<use>` по `x`/`y`.
- `detach` копирует развёрнутое содержимое в базу (`<g>`, id с префиксом; вложенные инстансы остаются `<use>`); логика наследника префаба в базу не переносится (стерильность) — статические подписи (`self.label` от обычного параметра) запекаются, остальное — предупреждение.
- `extract` создаёт файлы, документ сразу видит их (валидация); undo отменяет правку документа, файлы остаются (их записал хост).

## Команды

<!-- BEGIN commands (scripts/editor-commands.mjs) -->
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
<!-- END commands -->

Список выше генерируется: `npm run editor:commands`.
