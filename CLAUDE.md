# Trempel — project context

Лёгкий agent-first 2D-движок на PixiJS: формат сцен как валидный SVG (+ namespace `tml:`), рантайм, плеер анимаций, ядро редактора и страница редактора. npm-пакет `@trempel/scene`.

## Спека
Единственный источник истины по формату — `docs/format/scene-format.md` (v1.0; в конце — короткий changelog версий). Двухдокументная модель: стерильная база `X.svg` (ванильный SVG) + наследник `X.tml.svg` (`tml:extends` / `<tml:ref>` / `tml:insert`) + контракт `X.contract.xml`; клипы — md-клипы (`anim/*.md`, `X.anim.md`) → anim.json. Миграция потребителей по версиям — `MIGRATION.md` (§10 — переход на имена Trempel). Scope строгий: в формат идёт только то, что нужно реальным сценам; партиклы, plist, экспорт чужих форматов, layouts, inputs, foreach, themes — не делать.

## Совместимость
Старые имена формата (префикс, наследник, модуль просмотрщика, папка редактора) читаются один релиз с предупреждением — весь этот слой в `src/compat.ts` (+ `test/compat.test.ts`); конвертер — `scripts/migrate-tml.mjs`. Больше нигде старые имена не упоминаются. API без алиасов.

## Toolchain
Node 20+, TS 5.x strict, ESM. pixi.js >= 8.5.0 (peer). Vite (dev-страницы, `resolve.preserveSymlinks: true`), vitest. Ядро тестируется без браузера через инъекцию (mock clock, mock renderer — `test/helpers/mockBackend.ts`).

## Команды
- `npm run build` — tsc (`dist/`: core, index, editor) + библиотека страницы редактора (`dist/edit`, `npm run build:edit`); `npm run build:browser` — браузерные бандлы `dist/browser/trempel*.js`
- `npm test` — unit (vitest, без браузера); `npm run test:e2e` — редактор и `view:shot` в headless Chromium (по одному файлу, машинный лок `os.tmpdir()/trempel-e2e.lock`, `TML_E2E_LOCK` переопределяет)
- `npm run typecheck`
- `npm run dev` — vite, примеры `examples/*/index.html`
- `npm run view -- <папка>` — просмотрщик сцен (`view/`, в пакет не входит); `npm run view:shot -- <сцена> --out x.png` — headless-снимок + JSON ошибок
- `npm run edit -- <папка>` — страница редактора на dev-сервере (`edit/`); как библиотека — `@trempel/scene/edit` (`mountEditor` + `SceneIO` хоста)
- `npm run check -- <папка | X.svg> [--anim anim/x.md]` — чекер сцены и клипов; `npm run anim:compile -- anim/x.md [--tex "art/{}.png"]` — md-клипы → json
- `@trempel/scene/editor` — ядро редактора (`editor/`, README там); `npm run editor:commands` — пересобрать список команд в `editor/README.md` и `edit/API.md`

## Раскладка
- `src/` — ядро и рантайм (`core.ts` — без Pixi, `index.ts` — + PixiBackend); `src/md/` — разбор md-клипов; `src/compat.ts` — старые имена формата.
- `editor/` — ядро редактора (команды, документ базы с минимальным диффом).
- `edit/` — страница редактора (`app/`), dev-сервер (`io-dev.ts`), библиотека (`lib.ts`).
- `view/` — просмотрщик и `view:shot`.
- `examples/` — `motion`, `prefabs`, `finddiff`; `test/` — unit и фикстуры.

## Инварианты
- Никакой игровой специфики в `src/` — формат общий; компонент `reel-grid` покрыт синтетической фикстурой (`test/reel-grid.test.ts`).
- Рендер-агностичное ядро: логика не знает про PixiJS, общается через `RendererBackend`.
- База стерильна: `tml:*` живут только в наследнике; редактор правит только базу.
