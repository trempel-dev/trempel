# Клипы попапа паузы (v1.0: колонки width / height — размер растягиваемого префаба)

# $clip open
$duration: 0.6

## $track pause
| t   | width | height | alpha | ease    |
|-----|-------|--------|-------|---------|
| 0   | 320   | 240    | 0     | outBack |
| 0.45| 600   | 800    | 1     |         |

## $track dim
| t   | alpha |
|-----|-------|
| 0   | 0     |
| 0.3 | 0.6   |

# $clip close
$duration: 0.3

## $track pause
| t   | height | alpha | ease  |
|-----|--------|-------|-------|
| 0   | 800    | 1     | inOut |
| 0.3 | 240    | 0     |       |
