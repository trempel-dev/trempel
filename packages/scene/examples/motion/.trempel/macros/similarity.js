// name: Сходство с эталоном
// Для каждого <image> с bounds: кроп эталона (вписан в viewBox, 1:1) против кропа рендера стадии
// в той же рамке. Метрика — как в check_scene.py скилла макетов: 1 − средняя разница каналов RGB
// (большие области — по уменьшенной копии 200×200; мельче 4 px и фон на ≥ 90 % кадра — пропуск).
// Порог 0.85; худшие — первыми. Эталон — кнопка «эталон…» (или <сцена>.mockup.png рядом).
const THRESHOLD = 0.85;
if (!tml.reference.file) throw new Error('эталон не выбран — кнопка «эталон…» в панели (или <сцена>.mockup.png рядом со сценой)');
await tml.idle();
const vb = tml.viewBox();
const render = await tml.pixels();
const mockup = await tml.reference.pixels();
const W = render.width;
const H = render.height;

/** RGB of a box (integer px) as a flat array, optionally resized (nearest) to size × size. */
const rgb = (p, x0, y0, x1, y1, size) => {
  const w = x1 - x0;
  const h = y1 - y0;
  const ow = size ?? w;
  const oh = size ?? h;
  const out = new Uint8Array(ow * oh * 3);
  for (let r = 0; r < oh; r++) {
    const y = y0 + (size ? Math.floor(((r + 0.5) * h) / oh) : r);
    for (let c = 0; c < ow; c++) {
      const x = x0 + (size ? Math.floor(((c + 0.5) * w) / ow) : c);
      const i = (y * p.width + x) * 4;
      const o = (r * ow + c) * 3;
      out[o] = p.data[i];
      out[o + 1] = p.data[i + 1];
      out[o + 2] = p.data[i + 2];
    }
  }
  return out;
};
const sad = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s;
};

const rows = [];
for (const n of tml.nodes()) {
  if (n.tag !== 'image') continue;
  const ref = n.id ?? n.path;
  const b = tml.bounds(ref);
  if (!b) continue;
  const x0 = Math.max(0, Math.trunc(b.x - vb.x));
  const y0 = Math.max(0, Math.trunc(b.y - vb.y));
  const x1 = Math.min(W, Math.ceil(b.x - vb.x + b.width));
  const y1 = Math.min(H, Math.ceil(b.y - vb.y + b.height));
  if (x1 - x0 < 4 || y1 - y0 < 4) continue;
  const area = (x1 - x0) * (y1 - y0);
  if (area > 0.9 * W * H) continue; // фон: на макете закрыт остальными слоями
  const diff =
    area < 40000
      ? sad(rgb(mockup, x0, y0, x1, y1), rgb(render, x0, y0, x1, y1))
      : (sad(rgb(mockup, x0, y0, x1, y1, 200), rgb(render, x0, y0, x1, y1, 200)) / 40000) * area;
  rows.push({ score: 1 - diff / (area * 3) / 255, name: n.id ?? `<image> ${n.path}` });
}
rows.sort((a, b) => a.score - b.score);
if (!rows.length) return 'нет <image> с bounds для сравнения';
const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
const width = Math.max(...rows.map((r) => r.name.length), 4);
console.log(`эталон ${tml.reference.file}, рендер ${W}×${H}; порог ${THRESHOLD}`);
console.log(`${'узел'.padEnd(width)}  сходство`);
for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.score.toFixed(3)}${r.score < THRESHOLD ? '  <-- проверь' : ''}`);
const bad = rows.filter((r) => r.score < THRESHOLD).map((r) => r.name);
return `среднее ${avg.toFixed(3)} по ${rows.length}; ниже ${THRESHOLD}: ${bad.length ? bad.join(', ') : 'нет'}`;
