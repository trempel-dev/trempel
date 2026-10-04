# Клипы примера motion (Trempel v0.7–v0.8)

Канон — эти таблицы; `motion.json` рядом — компилят для игры (`npm run anim:compile -- examples/motion/anim/motion.md`), руками не пишется; просмотрщик и редактор играют этот файл.
v0.9.1: `$tex` ниже — как имя из колонки tex становится href (`{}` — имя), для всех клипов файла.
x / y / rotation / skew — от позы покоя в сцене, scale — множитель, alpha, tint, z, tex, view — абсолют; ease — «от этого ключа к следующему».
v0.8: `view` — имя варианта из data-views картинки (компилируется в href по сцене), `z` — порядок среди соседей (step), `tint` — цвет по каналам.

$tex: art/{}.svg

# $clip fly
$duration: 4
$loop: true

Птица летит по #fly1 с равномерной скоростью (motion — доля длины пути), нос по касательной, проявляется и гаснет.

## $track bird
$path: fly1
$orient: auto
$offset: 0, -6
| t   | motion | alpha | ease  |
|-----|--------|-------|-------|
| 0   | 0      | 0     | inOut |
| 0.4 |        | 1     |       |
| 3.6 |        | 1     |       |
| 4   | 1      | 0     |       |

Взмахи крыльями — вариантами спрайта (v0.8, `data-views` у #birdImg).

## $track bird
| t    | view |
|------|------|
| 0    | up   |
| 0.25 | down |
| 0.5  | up   |
| 0.75 | down |
| 1    | up   |
| 1.25 | down |
| 1.5  | up   |
| 1.75 | down |
| 2    | up   |
| 2.25 | down |
| 2.5  | up   |
| 2.75 | down |
| 3    | up   |
| 3.25 | down |
| 3.5  | up   |

# $clip idle
$duration: 2.4
$loop: true

Дыхание тела (с тинт-пульсацией, v0.8), покачивание головы, моргание подменой текстуры.

## $track mascotBody
| t   | y  | scaleY | tint    | ease  |
|-----|----|--------|---------|-------|
| 0   | 0  | 1      | #ffffff | inOut |
| 1.2 | -4 | 1.03   | #c8ffdc | inOut |
| 2.4 | 0  | 1      | #ffffff |       |

## $track mascotHead
| t    | rotation | tex        | ease  |
|------|----------|------------|-------|
| 0    | 0        | head-idle  | inOut |
| 1.0  | 6        |            | inOut |
| 2.05 |          | head-blink | step  |
| 2.15 |          | head-idle  |       |
| 2.4  | 0        |            |       |

## $events
| t    | event |
|------|-------|
| 2.05 | blink |

# $clip wave
$duration: 2
$loop: true

Рука машет вокруг плеча (`data-pivot`) и на взмахе выходит вперёд — колонка `z` (v0.8): за телом (0) → перед головой (3) → обратно.

## $track mascotArm
| t   | rotation | z | ease  |
|-----|----------|---|-------|
| 0   | 0        | 0 | inOut |
| 0.5 | -150     | 3 | inOut |
| 0.8 | -120     |   | inOut |
| 1.1 | -150     |   | inOut |
| 1.6 | 0        | 0 |       |
