// name: Выровнять выделение по левому краю
// Левые края выделенных узлов — к самому левому (bounds — в единицах сцены, с последней отрисовки).
const sel = tml.selection;
if (sel.length < 2) throw new Error('выделите два узла или больше (Shift+клик)');
const boxes = sel.map((n) => ({ n, b: tml.bounds(n) })).filter((x) => x.b);
const left = Math.min(...boxes.map((x) => x.b.x));
let moved = 0;
for (const { n, b } of boxes) {
  if (Math.abs(b.x - left) < 0.01) continue;
  const r = tml.moveBy(n, left - b.x, 0);
  if (!r.ok) throw new Error(`${n}: ${r.errors.join('; ')}`);
  moved++;
}
return `сдвинуто: ${moved}`;
