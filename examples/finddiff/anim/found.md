# Клипы FindDiff (Trempel v0.9.1)

Канон — эти таблицы; играется на зоне, которую нашли: `play(clips.found, { targets: { target: zone } })`.
dash — stroke-dashoffset в единицах pathLength зоны (у зон pathLength="100", stroke-dasharray="100"): 100 — обводки нет, 0 — вся.
scale — множитель позы покоя, вокруг data-pivot (центр эллипса); strokeWidth — толщина, абсолют.

# $clip found
$duration: 1.1

Обводка прорисовывается за 0.45 с, зона вспухает и дважды пульсирует.

## $track $target
| t    | dash | scale | strokeWidth | ease  |
|------|------|-------|-------------|-------|
| 0    | 100  | 1     | 7           | out   |
| 0.45 | 0    | 1.18  | 4           | inOut |
| 0.7  |      | 1     |             | inOut |
| 0.9  |      | 1.08  |             | inOut |
| 1.1  |      | 1     |             |       |
