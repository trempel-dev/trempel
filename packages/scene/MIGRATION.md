# Миграция на Trempel: v0.6 – v1.2

Руководство для потребителей формата и пакета `@trempel/scene`: что меняется от версии к версии и что можно снять у себя. Формат v0.5 совместим: сцены, наследники, контракты работают без правок. Полное описание формата — [`docs/format/scene-format.md`](docs/format/scene-format.md).

## 1. Подключение пакетом, без алиасов

Trempel — собираемый пакет: `exports` (`@trempel/scene` и `@trempel/scene/core`), типы в `dist`, `pixi.js` — peer.

1. В `package.json` потребителя:
   ```json
   "@trempel/scene": "^1.0.0"
   ```
   Для локальной разработки рядом с исходниками движка работает и `"@trempel/scene": "file:../trempel"` (в репозитории trempel: `npm install && npm run build`). Тогда добавьте `.npmrc`:
   ```
   install-links=true
   ```
   npm скопирует пакет вместо симлинка — `pixi.js` и `@xmldom/xmldom` резолвятся из проекта потребителя, копия одна. После правок в trempel: `npm run build` там и `npm install` у себя.
   *Альтернатива (живой симлинк):* без `install-links`, но тогда в `vite.config.ts` нужен `resolve.dedupe: ['pixi.js', '@xmldom/xmldom']` — иначе подтянется pixi из `node_modules` самого trempel.
2. Удалить, если были:
   - алиас `@trempel/scene` на исходники в `vite.config.ts` (и `dedupe`, если выбран `install-links`);
   - `tsconfig.json` → `paths`: `"@trempel/scene"`, `"pixi.js"`, `"@xmldom/xmldom"`;
   - инструменты, которым не нужен рендер (чекеры сцен, тесты), импортируют `@trempel/scene/core` — без pixi; `vite-node` для них не обязателен (`node tools/…ts` на Node 22.6+ со strip-types: пакет — чистый ESM с `.js`-импортами).

Пакет, поставленный через `file:` (+ `install-links`), импортируется голым node и `tsc --moduleResolution nodenext` без алиасов; `instanceof` pixi-классов совпадает (одна копия).

## 2. CSP: выражения без eval

С v0.6 выражения разбираются собственной грамматикой, без `new Function`: требование `unsafe-eval` в CSP снимается. Типичные выражения (`state.a ? '...' : t.watch`, `state.found + '/' + state.total`, `!(state.musicVolume > 0)`, вызовы функций контекста) работают без правок.

Поведенческие отличия:
- **Синтаксическая ошибка выражения роняет mount** (в общем списке с merge/контрактом), а не тихо даёт `undefined`. Ошибки исполнения — с v0.6.1 тоже громко, см. §6.
- Глобалов в выражениях нет (`Math.max(...)` не сработает) — всё нужное кладётся в `context`.
- `|` — всегда пайп (побитового ИЛИ нет). Неизвестный пайп — ошибка mount.

## 3. Свой подкласс `PixiBackend`: что ушло в ядро

Типичные обходы, которые потребители держали в собственном подклассе бэкенда, с v0.6 делает ядро:

| обход в своём бэкенде | v0.6 | что сделать |
|---|---|---|
| резолв href через таблицу бандла | `mount({ resolveHref })` — отображение href, применяется к атрибутам, к `tml:bind` на image и к href компонентов через `ctx.backend` | передавать `resolveHref` в `mount()`; из бэкенда — убрать |
| `new URL(href, base)` для сцен из других папок | `mount({ baseUrl })` | `mount({ base: svg, …, baseUrl: base })`, бэкенд без резолвера |
| текстура из кэша — синхронно, размер — после текстуры | так в `PixiBackend.image` / `setProp('href')`; устаревшая загрузка не перетирает новый href | убрать свой `image()` и ветку `href` в `setProp` (кроме 9-slice до v1.0, см. §6.1) |
| предзагрузка `Assets.load(urls)` до mount и ручное переназначение текстур | `MountedScene.ready` | `const scene = mount(…); await scene.ready;`. Если нужно «грузим до того, как снесли старую сцену» — mount в отсоединённый контейнер и `await ready` перед заменой |
| `opacity`, `display="none"`, `visibility="hidden"` | в ядре, на любом узле | убрать |
| transform translate/scale/rotate | в ядре: + `matrix`, `skewX/Y`, `rotate(a cx cy)`, цепочки; x/y внутри transform | убрать свой разбор transform |
| text: `font-family`/`font-weight`, `stroke`/`stroke-width`, `letter-spacing` | в ядре | убрать; семейство по умолчанию — `new PixiBackend({ fontFamily })` |
| `<text y>` как базовая линия, `dominant-baseline="middle"` | в ядре: anchor по метрикам шрифта (`ascent/descent`, с учётом stroke); `middle`/`central` → 0.5 | убрать. **Шрифт должен быть загружен до mount** (метрики меряются при создании текста). Фиксированные метрики — `new PixiBackend({ metrics: () => ({ ascent: 0.78, descent: 0.22 }) })` |
| rect: `rx`, `fill-opacity`, `stroke`, `fill="none"` | в ядре (+ `ry`, `stroke-opacity`) | убрать |
| 9-slice (`NineSliceSprite`) | в v0.6 — нет (с v1.0 — `data-slices`, §9) | оставить в подклассе |
| свои `data-*`-расширения (tint, автоподгонка текста) | нет | оставить в подклассе |
| свой разбор цвета | `parseColor` экспортируется из `@trempel/scene` (любой CSS-цвет, с альфой) | можно заменить |

После чистки подкласс обычно сводится к своим расширениям. Конструктор: `super({ fontFamily })`.

Отличие по умолчанию: текст без `fill` теперь чёрный (как в SVG), было белым.

## 4. Контракт вместо процессора сцен

Проверки, которые делал собственный процессор уровней, часто выражаются контрактом:

```xml
<contract aspect="9:16" tolerance="3%">
  <image id="back"/>
  <g id="scene"/>
  <g id="icons"/>
  <image match="o(\d+)"  count="1.." in="scene"/>
  <image match="_o(\d+)" count="0.." in="icons" requires="o$1"/>   <!-- иконка без объекта — ошибка -->
  <image match="d\d+"    count="0.." in="scene"/>
</contract>
```

- `aspect="9:16" tolerance="3%"` пропускает холсты близкой пропорции (816×1456, 960×1664, 864×1536, 541×937). Строгий список размеров — `viewBox="0 0 816 1456 | 0 0 960 1664 | …"`.
- `requires` ставится только там, где связь обязательна (иконка требует объект, а не наоборот). Шаблон `match` сравнивается со всем id: `o(\d+)` не ловит `o4 копия`.

## 5. Не изменилось в v0.6

- Layout/anchors — вне v0.6 (появились в v1.0, §9).
- `ComponentContext` по-прежнему без тикера/загрузчика/соседей; добавлен только `resolveHref`. Твины и прочее — через фабрику-замыкание.

## 6. v0.6.1

API v0.6 не сломан, новое — добавлениями; меняется поведение по умолчанию у ошибок выражений (§6.3).

### 6.1. Свой вид для `<image>` без своего кэша и готовности

В `PixiBackend` появились защищённые точки расширения:

- `protected createImage(attrs): ImageNode` — какой display-объект сделать для `<image>` (по умолчанию `Sprite`). Трансформ, `x`/`y`, `opacity`, кэш текстур, защита от устаревшего `href`, размер по `width`/`height` и учёт в `whenReady()` — делает база, в т.ч. для `NineSliceSprite`/`TilingSprite` (им ставится `width`/`height` самого вида, а не масштаб).
- `protected track(load, label)` — своя загрузка подкласса (json, шрифт) в счёт `whenReady()`; при реджекте `label` попадает в список ошибок.
- Тип `ImageNode` (`Container & { texture }`) экспортируется из `@trempel/scene`.

Что снять в подклассе, который сам делал 9-slice:

| сейчас | станет |
|---|---|
| свои WeakMap/списки загрузок/ошибок, ручная установка текстуры | удалить |
| ручное создание `NineSliceSprite` с `position.set`, `alpha`, `visible` | `createImage(a)`: для своих картинок — `new NineSliceSprite({ texture: Texture.EMPTY, leftWidth, topHeight, rightWidth, bottomHeight })`, иначе `super.createImage(a)` |
| своя ветка `createNode` для `image` | убрать — `super.createNode` |
| `setProp('href')` для своего вида | убрать — база |
| override `whenReady()` | удалить целиком |

Если подкласс сам грузит данные (таблица срезов и т.п.) — `this.track(load, 'путь/к/файлу.json')`.

### 6.2. Текстура не двигает спрайт хоста

Позже пришедшая текстура или новый `href` меняют только «подгонку под `width`/`height`» поверх **текущей** трансформации узла — позиция, поворот и масштаб, выставленные хостом после mount, сохраняются; явно выставленный хостом `sprite.width`/`height` тоже. Править ничего не нужно — снимается ограничение «арт обязан быть в кэше до `mount()`».

### 6.3. Ошибки выражений — громко

Ошибка **исполнения** `tml:bind`, `tml:bind-*`, `tml:visible`, `tml:on-click` (поле у `undefined`, неизвестное имя, исключение функции контекста, упавший пайп) больше не даёт молча `undefined`:

- `mount({ …, onError })` — колбэк `onError({ node, attr, expr, error })` (`node` — `#id` или `<tag>`, `attr` — `tml:bind`/…, `error` — исходное исключение). Запись в узел пропускается (узел держит прошлое значение), упавший клик ничего не делает.
- без `onError` — бросается `ExpressionRuntimeError` (поля те же, `cause` = исходная ошибка, сообщение `#btn tml:on-click="play()": …`): при первом вычислении — из `mount()`, позже — из записи в `state`, вызвавшей пересчёт, у клика — из обработчика.
- `lenient: true` — прежнее молчание v0.5 (`undefined` пишется, клик глотается); `onError`, если задан, всё равно вызывается.

Что сделать: передать в `mount()` `onError` (лог/телеметрия) или, если сцены опираются на «поле ещё не пришло → пусто», переписать такие выражения с `??`/`?:` (`state.user ? state.user.name : ''`). `lenient: true` — только как временный шаг. `evalExpression`/`evalBinding` как функции остались ленивыми.

## 7. v0.7 — геометрия, маски, md-клипы, движение по пути

Сцены, наследники, контракты и `anim.json` v0.6 работают без правок; API — только добавления. Новая зависимость пакета — `svg-path-properties`: после обновления `npm install`.

### 7.1. Что проверить

Сцены без новых тегов правок не требуют. Мелочи:
- свой подкласс `PixiBackend` получает новые методы `setClip` / `getProp` по наследству — ничего не переопределять;
- обёртка над `RendererBackend` (если есть) должна пробрасывать необязательные `setClip` и `getProp`, иначе сцены с `clip-path` и относительные клипы на ней не заработают;
- `<circle>` и другие фигуры раньше были ошибкой разбора, теперь рисуются — если ваш процессор полагался на эту ошибку как на запрет, держите запрет у себя (или в контракте).

### 7.2. Компоненты: `ctx.param()` вместо ручного `tml → data-*`

Если компонент сам собирает параметры:

```ts
for (const k of ['cols', 'rows', 'cellw', 'cellh', 'gapx', 'gapy']) g[k] = ctx.tml[k] ?? a[`data-${k}`];
```

— это ровно конвенция v0.7 (`tml:<name>` наследника, иначе `data-<name>` базы); заменить на единую точку чтения:

```ts
const p = (k: string) => ctx.param(k);
const cols = num(p('cols'), 5);
const rows = num(p('rows'), 3);
const cellW = num(p('cellw'), 160);
const cellH = num(p('cellh'), 160);
```

- Контракт шаблона может требовать параметры: `<g id="board" attrs="data-cols data-rows data-cellw data-cellh"/>` — рескин без них упадёт на `check`, а не в рантайме.
- `ctx.path(id)` — пути из `<defs>` базы для компонентов (полёт монеты, линии выигрыша как геометрия).
- `ComponentContext`, собранный руками (тесты, фабрики), по-прежнему валиден для `Registry.create`: `param`/`path` достраиваются (`param` читает атрибуты узла).

### 7.3. Клипы: md-клипы → anim.json

Клипы пишутся таблицами клипов в markdown (см. [`docs/format/scene-format.md`](docs/format/scene-format.md)) и компилируются при сборке, не руками в JSON:

```bash
npm run anim:compile -- anim/mascot.md --tex "art/{}.png"   # в репозитории trempel; или из своего скрипта:
```
```ts
import { compileClips } from '@trempel/scene/core';
const clips = compileClips(md, mergedScene, { tex: (n) => `art/${n}.png` }); // бросает TrempelError со списком
```

Проигрывание — `Animator` с путями сцены:

```ts
const anim = new Animator(backend, clock, (id) => scene.byId.get(id), { path: (id) => scene.path(id) });
anim.play(clips.idle);
```

- Относительные ключи (`x`/`y`/`rotation` от позы покоя, `scale` множителем) читают позу через `backend.getProp` — у `PixiBackend` он есть; своему бэкенду — реализовать.
- hrefs из `tex` идут в бэкенд как есть: `resolveHref`/`baseUrl` mount'а к ним не применяются — маппить через опцию `tex` компилятора (или таблицу бандлера внутри неё).
- `scene.byId.get('<image с clip-path>')` возвращает `Container`-группу, а не `Sprite` (маске нужен контейнер); `href` на ней работает.

## 8. v0.9 — префабы, многоуровневое наследование

Существующие сцены, наследники, контракты работают без правок (рендер пиксель в пиксель как на v0.8). Что можно снять / начать использовать:

### 8.1. Повторяющиеся группы → префаб

Кнопка/плашка/рамка, скопированная в сцене N раз, — отдельная сцена `ui/button.svg` (+ `.tml.svg` с логикой, + контракт с `params`) и N строк в базе:

```xml
<use id="settingsBtn" href="ui/button.svg" x="940" y="100" data-label="=t('settings')" data-action="openSettings"/>
```

- В редакторе: выделить группу → «в префаб» (или команда `prefab.extract`: `tml.doc.exec('prefab.extract', { node: 'panel', href: 'ui/panel.svg' })`); группа станет `<use>`, id её детей — `panel/…` (если они уже были с этим префиксом, наследник сцены и контракт не меняются).
- Логика кнопки в префабе: `tml:on-click="self.call(self.action)"` — функция сцены по имени из параметра; подпись — `tml:bind="self.label"`.
- Скин-вариант — наследник без своей базы: `button-green.tml.svg` с `tml:extends="button.svg"`, `tml:href` у картинки, свои дефолты `data-*` на корне.
- Состояния кнопок — `data-views` + `self.state`. Палитра редактора видит папку префабов, если она внутри открытой папки (`trempel.view.ts` → `prefabs: ['ui']`).

### 8.2. Загрузка префабов хостом

`mount()` синхронный — ему нужен синхронный `loadScene(url) → { base, heir?, contract? } | null` (бандл: `import.meta.glob('./**/*.{svg,xml}', { query: '?raw', eager: true })`, как в `examples/prefabs/main.ts`). Без бандла — `await mountAsync({ … })`: в браузерном `@trempel/scene` по умолчанию `fetch` тройки по stem; в `@trempel/scene/core` загрузчик передаётся явно. Сцены без `<use>` загрузчика не требуют.

- `url` — href инстанса, разрешённый как href картинки (`baseUrl`/`resolveHref`), или от `sceneUrl`, если хост резолвит арт иначе, чем документы (например, `baseUrl: false`).
- Хост с собственной сборкой дерева (просмотрщик, чекеры) — `composeScene({ base, heir, contract, loadScene, path })` → `{ tree, contract, errors: { parse, prefab, contract, merge } }` без исключений, затем `mountTree(tree, opts)`.

### 8.3. Бэкенд

- Новый необязательный метод `onPointer(node, 'over'|'out'|'down'|'up', fn)` — нужен, если сцены используют `tml:on-over/out/down/up` (кнопки с наведением). `PixiBackend` и его подклассы умеют; обёртки бэкенда должны его пробрасывать.
- `tml:bind-view` (вариант `data-views` по выражению) идёт в бэкенд как `setProp(node, 'href', …)` — ничего нового.

## 9. v1.0 — 9-slice, якоря, растягиваемые префабы, слоты

Рендер существующих сцен — пиксель в пиксель как на v0.9.1. Ломающее одно: **якорь (`data-anchor`/`data-stretch`) требует бокса у родителя** — корень с `viewBox`, инстанс префаба или `<g data-size="w h">`; узел с якорем внутри обычной группы — ошибка «якорь без размера родителя» (раньше хосты обычно якорили к холсту при любой вложенности).

### 9.1. Конвертер

Скрипт не входит в npm-пакет — запускается из checkout репозитория trempel:

```bash
node scripts/migrate-v1.mjs <папка сцен> [--slices slices.json]          # отчёт
node scripts/migrate-v1.mjs <папка сцен> [--slices slices.json] --write  # записать (правки — только вставки атрибутов)
```

1. `--slices` (таблица в формате Unity `{ "<stem>": { "px": "WxH", "border": "L.. B.. R.. T.." } }`) → `data-slices="l t r b"` на каждой `<image>` базы, чей href (stem) есть в таблице. Срезы — в пикселях файла: если файл меньше `px` таблицы (экспорт уменьшен, например 768×1536 → webp 512×1024), борта масштабируются. Срез без центра (например 4×4 с бортами по 2 — Unity так умеет, формат нет) — в отчёт, атрибут не ставится: картинка тянется целиком, как и выглядела.
2. Обычная `<g>` в корне без `transform`, в которой лежат узлы с якорями, → `data-size="<viewBox w h>" data-stretch="xy"`: группа — холст, ровно прежняя семантика. Остальные случаи — в отчёт, руками.

После конвертера проверьте сцены просмотрщиком: отличия от v0.9.1 ожидаемы только у картинок, получивших `data-slices` (там, где раньше они тянулись целиком).

### 9.2. Что снять у себя

- Свою таблицу срезов и код 9-slice в подклассе бэкенда — срезы теперь в базе (`data-slices`), их делает `PixiBackend.createImage` ядра (`NineSliceSprite`, борта 1:1, `width/height` — размер панели; `TilingSprite` — по `data-tile`). Срез, не помещающийся в текстуру, — ошибка `scene.ready` (раньше — молча кривой спрайт).
- Свой цикл раскладки якорей при ресайзе — вместо него `scene.resize(w, h)` в единицах viewBox: якоря и растяжка пересчитываются ядром. При холсте больше эталона узел едет на `(extraW·ax, extraH·ay)`, `data-stretch` растёт на extra; фон с отступами отступы сохраняет. Безопасная зона (safe area) ядром не делается — сдвиг поверх, у хоста.
- `data-anchor`/`data-stretch` в базах остаются как есть (после конвертера — валидны).
- Семейства префабов разной ширины (`button-wide` и т.п.) → один `data-resizable` префаб + `<use width height>`; тело попапа — слот (`tml:slot` в наследнике рамки, дети `<use slot="content">` в сцене).

### 9.3. Новое, без правок существующего

- `data-tile="x|y|xy"` — плитка (TilingSprite); по неплиточной оси текстура тянется.
- `<use … width height>` у `data-resizable` префаба (по его осям, не меньше `viewBox`); клипы — колонки `width`/`height` на `<use>` и на `<image data-slices>`; `MountedScene.setSize(id, w, h)`, `sizeOf(id)`.
- Слоты: `<tml:ref id="content" tml:slot="content default"/>` в наследнике префаба; дети `<use>` — узлы сцены (`slot="content"` или без — в слот по умолчанию), id без префикса инстанса, выражения — в контексте сцены.
- Контракт: `anchor="ax ay"` у узла, `slices="true"` у картинки, `resizable="xy"` у корня, `slot="true"` у группы префаба.
- Бэкенд-обёртки: `setProp(node, 'width'|'height', v)` теперь приходит и картинкам/прямоугольникам (растяжка, клипы) — пробрасывать как есть.

## 10. Переименование в Trempel (gml → tml)

Формат и пакет раньше назывались GameML (`gameml`, префикс `gml:`). С переименованием поменялись имена — смысл формата и API прежний.

| было | стало |
|---|---|
| префикс `gml:*`, xmlns `http://gameml.dev/ns` | `tml:*`, xmlns `https://trempel.dev/ns/scene` |
| наследник `X.gml.svg` | `X.tml.svg` |
| модуль просмотрщика `gameml.view.ts` | `trempel.view.ts` |
| папка редактора `.gml/` | `.trempel/` |
| `window.gml`, `gml.run` (макросы редактора) | `window.tml`, `tml.run` |
| `GameMLError` и прочие `GameML*` | `TrempelError`, `Trempel*` |
| `SceneNode.gml` (карта атрибутов префикса) | `SceneNode.tml` |
| пакет `gameml`, `gameml/core`, `gameml/editor` | `@trempel/scene`, `@trempel/scene/core`, `@trempel/scene/editor` |
| — | новый `@trempel/scene/edit`: страница редактора как библиотека (`mountEditor`, `SceneIO`) |
| `virtual:gameml-view-module` | `virtual:trempel-view-module` |
| `GML_VIEW_DIR`, `GML_VIEW_MODULE`, `GML_E2E_LOCK` | `TML_VIEW_DIR`, `TML_VIEW_MODULE`, `TML_E2E_LOCK` |

### 10.1. Совместимость — один релиз, только формат

Парсер ещё читает старые имена: префикс `gml:` и старый xmlns, наследников `X.gml.svg`, модуль `gameml.view.ts`, папку `.gml/`. На каждое такое место — одноразовое предупреждение об устаревании; `onDeprecated(fn)` из `@trempel/scene/core` перенаправляет их (в лог, в телеметрию, в ошибку теста). В следующем релизе старые имена перестанут читаться.

У API алиасов нет: `GameMLError`, импорты из `gameml`, `node.gml` и т.п. нужно переименовать сразу.

### 10.2. Конвертер

Скрипт не входит в npm-пакет — запускается из checkout репозитория trempel:

```bash
node scripts/migrate-tml.mjs <папка> [--dry-run]
```

Ниже `<папки>` (без `node_modules`, `dist`, `.git`):
- `X.gml.svg` → `X.tml.svg`;
- `gameml.view.ts` → `trempel.view.ts` (и его импорты `gameml…` → `@trempel/scene…`);
- `.gml/` → `.trempel/` (и объект `gml` в макросах → `tml`);
- во всех `*.svg` — префикс `gml:` → `tml:`, xmlns `http://gameml.dev/ns` → `https://trempel.dev/ns/scene`.

Идемпотентен: повторный запуск ничего не меняет. `--dry-run` печатает, что было бы сделано. Переименование поверх существующего файла не выполняется, а попадает в отчёт — выход с кодом 1.

Руками остаётся код за пределами модуля просмотрщика: импорты `from 'gameml'` / `'gameml/core'` → `@trempel/scene` / `@trempel/scene/core`, обращения `node.gml` → `node.tml`, `GameML*` → `Trempel*`, переменные окружения `GML_*` → `TML_*`.

## 11. v1.1 — коллекции `@имя/…` и `flatten`

Общий скин, кит и игры больше не ссылаются друг на друга относительными путями (`../skins/default/ui/panel.svg`): папка объявляется коллекцией, ссылка пишется по имени — `@skin/panel.svg`. Относительные пути работают как раньше; `@` лишь добавлен. Сцены без `@` переводить не обязательно.

### 11.1. Объявить коллекции

В корне проекта (общий предок скина и игр) — `.trempel/project.mdz`:

```
# Trempel project

## collections
$skin: skins/default/ui
```

Значение — папка от корня проекта или `npm:<пакет>/<папка>` (папка пакета из `node_modules` от корня вверх). Имя — `[a-z][a-z0-9-]*`.

### 11.2. Конвертер

Скрипт не входит в npm-пакет — из checkout trempel, после сборки:

```bash
npm run build && node scripts/migrate-collections.mjs <папка потребителя> [--dry-run]
```

Ниже `<папки>` (кроме самих папок коллекций — их собственные относительные ссылки остаются относительными) переписывает ссылки, которые от своего файла попадают в папку коллекции, на `@имя/…`:
- `*.svg` — `href` / `xlink:href` / `tml:href` / `tml:extends`, варианты `data-views`, параметры `data-*`-пути;
- md-клипы — значения `$tex:` и ячейки таблиц;
- `*.json` (манифест) — строковые значения-пути.

Идемпотентен; `--dry-run` печатает каждую строку «было → стало».

### 11.3. Хост

- В браузере рантайм файлы не ищет: передайте `collections: { skin: '<URL папки скина>' }` в `mount` / `mountAsync` (URL абсолютный или от документа сцены). `@skin/x.png` → `<URL>/x.png` **до** `baseUrl` / `resolveHref` — таблица хешей бандлера получает обычный путь, так что, например, `import.meta.glob` по папке скина продолжает работать.
- Неизвестное имя — ошибка монтирования (`TrempelError`: «коллекции @x нет в проекте (есть: …)»), не тихий 404.
- `trempel.view.ts`: `defineView({ collections })` перекрывает отдельные имена project.mdz (скин под проверкой, CDN).
- Инструменты (`check`, `view`, `view:shot`, `edit`, `flatten`) читают project.mdz сами; `view:shot` для сцены со скином больше не нужен `--dir` (папкой становится корень проекта).
- Кит (`@trempel/kit`): `createGame({ collections })`.

### 11.4. `flatten` — сцена где угодно

`npm run flatten -- <сцена> --out x.svg [--embed]` (в пакете — `trempel-flatten`): сцена с префабами, 9-slice, слотами и `@`-ссылками → один ванильный SVG для браузера и Figma. `--embed` — картинки внутрь (нужно для `<img src=x.svg>`: SVG-картинка не грузит внешние файлы). Подробно — спека §13.

## 12. v1.2 — без встроенных компонентов; монорепа с `@trempel/kit`

Формат не менялся: сцены, наследники, контракты, клипы 1.1 работают как есть.

- **Встроенных компонентов больше нет.** `createDefaultRegistry()` возвращает пустой `Registry`; демо-компонент сетки, встроенный до 1.1, и его экспорты (фабрика и тип экземпляра) из `@trempel/scene` и `@trempel/scene/core` сняты. Сцена, которая на него опиралась, падает с «unknown component "<имя>"». Что делать: зарегистрировать свой компонент под тем же именем — `new Registry().register('<имя>', myFactory)` в `mount` и в `trempel.view.ts` (`defineView({ registry: () => … })`); прежний код компонента есть в истории пакета, он пользуется только публичным API (`ComponentContext`, `NodeHandle` из `@trempel/scene/core`).
- **Просмотрщик и редактор** без `trempel.view.ts` монтируют сцену с пустым реестром; компоненты без регистрации редактор по-прежнему рисует заглушками.
- **Репозиторий — монорепа**: `packages/scene` (`@trempel/scene`), `packages/kit` (`@trempel/kit`), `templates/casual`. Команды из корня те же (`npm run check | view | view:shot | edit | flatten -- …` — прокси в `packages/scene`); пути к примерам — `packages/scene/examples/…`. Версии пакетов синхронны.
- **Общий скин кита** — коллекция `npm:@trempel/kit/skins/default/ui` (§11): в `.trempel/project.mdz` — `$skin: npm:@trempel/kit/skins/default/ui`, ссылки `@skin/…` в сценах не меняются.
