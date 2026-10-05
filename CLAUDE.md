# Trempel — project context

Лёгкий agent-first 2D-движок на PixiJS. Монорепа (npm workspaces): `@trempel/scene` 1.2.0, `@trempel/kit` 1.3.0 (шаблон следует за китом):
- `packages/scene` — `@trempel/scene`: формат сцен как валидный SVG (+ namespace `tml:`), рантайм, плеер анимаций, ядро редактора и страница редактора;
- `packages/kit` — `@trempel/kit`: кит игр поверх сцен (сервисы — контракты с обязательным моком, `src/services/`; платформы web / YouTube Playables / mock — реализации платформенных контрактов, цикл, экраны и попапы, раскладка, UI-компоненты и скины, звук, частицы, сейв, гейты сборки; дефолтный скин — `skins/default/ui`, коллекция `npm:@trempel/kit/skins/default/ui`);
- `templates/casual` — стартовый шаблон казуалки на ките (private, не публикуется); монеты — на сервисе `wallet`.

Пакеты ссылаются друг на друга **только по имени** (`@trempel/scene`, `@trempel/kit`), относительных импортов между пакетами нет — любой выносится `git filter-repo --subdirectory-filter` без правки кода. Ниже пути `src/`, `editor/`… — внутри `packages/scene`, если не сказано иначе.

## Спека
Единственный источник истины по формату — `packages/scene/docs/format/scene-format.md` (v1.2; в конце — короткий changelog версий). Двухдокументная модель: стерильная база `X.svg` (ванильный SVG) + наследник `X.tml.svg` (`tml:extends` / `<tml:ref>` / `tml:insert`) + контракт `X.contract.xml`; клипы — md-клипы (`anim/*.md`, `X.anim.md`) → anim.json. Миграция потребителей по версиям — `MIGRATION.md` (§10 — переход на имена Trempel, §11 — коллекции, §12 — 1.2: без встроенных компонентов, монорепа). Коллекции: `@имя/путь` → папка из `.trempel/project.mdz` корня проекта (`src/href.ts`, `src/project.ts`, Node — `src/node/project.ts`). Scope строгий: в формат идёт только то, что нужно реальным сценам; партиклы, plist, экспорт чужих форматов, layouts, inputs, foreach, themes — не делать (партиклы, раскладка экранов, ввод — дело кита, не формата).

## Совместимость
Старые имена формата (префикс, наследник, модуль просмотрщика, папка редактора) читаются один релиз с предупреждением — весь этот слой в `src/compat.ts` (+ `test/compat.test.ts`); конвертер — `scripts/migrate-tml.mjs`. Больше нигде старые имена не упоминаются. API без алиасов.

## Toolchain
Node 22.6+ (scene сам по себе — 20+), TS 5.x strict, ESM. pixi.js (peer: scene >= 8.5, kit >= 8.19). scene: Vite 5 (dev-страницы, `resolve.preserveSymlinks: true`), vitest 2; kit и шаблон: Vite 6, vitest 3, Playwright. Ядро тестируется без браузера через инъекцию (mock clock, mock renderer — `test/helpers/mockBackend.ts`). Кит импортирует сцену из её `dist` — корневые `typecheck`/`test` сначала собирают `@trempel/scene`.

## Команды (из корня)
- `npm run build` — scene (tsc → `dist/`: core, index, editor, node + библиотека страницы редактора `dist/edit`), затем kit (`scripts/ui-scenes.mjs` → `src/ui/scenes.ts`, tsc); `npm run build:browser` — браузерные бандлы `dist/browser/trempel*.js` (scene)
- `npm test` — unit всех пакетов (vitest, без браузера); `npm run test:e2e` — scene: редактор и `view:shot` в headless Chromium (по одному файлу, машинный лок `os.tmpdir()/trempel-e2e.lock`, `TML_E2E_LOCK` переопределяет); шаблон casual: сборки web и YouTube (+ гейты Playables) и Playwright
- `npm run typecheck`
- прокси в `packages/scene` (пути — от корня, `INIT_CWD`): `npm run view -- <папка>` — просмотрщик сцен (`view/`, в пакет не входит); `npm run view:shot -- <сцена> --out x.png` — headless-снимок + JSON ошибок; `npm run edit -- <папка>` — страница редактора на dev-сервере (`edit/`; как библиотека — `@trempel/scene/edit`: `mountEditor` + `SceneIO` хоста); `npm run check -- <папка | X.svg> [--anim anim/x.md]` — чекер сцены и клипов; `npm run flatten -- <сцена> --out x.svg [--embed]` — сцена → ванильный SVG (`src/flatten.ts`, CLI `src/node/flatten-cli.ts`); `npm run anim:compile -- anim/x.md [--tex "art/{}.png"]` — md-клипы → json; `npm run dev` — vite, примеры `examples/*/index.html`
- `node packages/scene/scripts/migrate-collections.mjs <папка>` — относительные ссылки → `@имя/…`
- `@trempel/scene/editor` — ядро редактора (`editor/`, README там); `npm run editor:commands` — пересобрать список команд в `editor/README.md` и `edit/API.md`
- kit: `trempel-skin <папка скина>` — замер арта скина в `skin.json`; `npm run view -- packages/kit/ui/scenes` — экраны кита в просмотрщике
- шаблон: `cd templates/casual && npm run dev` — играть; `npm run build:yt` — сборка Playables + гейты → `build-report.md`

## Раскладка
- `packages/scene/src/` — ядро и рантайм (`core.ts` — без Pixi, `index.ts` — + PixiBackend); `src/md/` — разбор md-клипов; `src/compat.ts` — старые имена формата; `src/node/` — Node-часть (`@trempel/scene/node`: project.mdz, flatten в файл).
- `packages/scene/editor/` — ядро редактора (команды, документ базы с минимальным диффом); `edit/` — страница редактора (`app/`), dev-сервер (`io-dev.ts`), библиотека (`lib.ts`); `view/` — просмотрщик и `view:shot`.
- `packages/scene/examples/` — `motion`, `prefabs`, `finddiff`, `collections` (проект с `.trempel/project.mdz` и коллекцией `@skin`); `test/` — unit и фикстуры.
- `packages/kit/src/` — кит (`game.ts` — `createGame`; `services/` — `contract` / `services` / `inject` / `listen`, стандартные контракты, мост к `Platform`, dev-панель `?services=1`; `platform/`, `time/`, `anim/`, `flow/`, `ui/` — экраны, попапы, раскладка, компоненты, скины; `audio/`, `fx/`, `data/`, `assets/`, `qa/`, `vite/` — плагин и гейты, `cli/skin.ts`); `ui/scenes` — шаблоны экранов (`UI_SCENES`); `skins/default/ui` — дефолтный скин (префабы, контракты, арт).
- `templates/casual/` — шаблон игры (`src/`, `scenes/`, `e2e/`).

## Инварианты
- Никакой игровой специфики в `packages/scene/src/` — формат общий, встроенных компонентов нет (`createDefaultRegistry()` — пустой реестр).
- Публичная репа жанрово-нейтральна: жанровые пакеты, их компоненты, примеры и лексика живут вне этой репы, поверх `@trempel/*` по имени.
- Рендер-агностичное ядро: логика не знает про PixiJS, общается через `RendererBackend`.
- База стерильна: `tml:*` живут только в наследнике; редактор правит только базу.
- Сервисы: объявить контракт без мока нельзя; `Platform`, `game.platform/save/ads` — фасады над контрактами (старые игры не меняются); dev-панель и `localStorage` моков в youtube-сборку не попадают (гейт `trempel-services`).
