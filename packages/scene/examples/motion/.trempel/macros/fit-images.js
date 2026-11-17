// name: Подогнать все image под ширину ≤ N
// Каждый <image> шире N уменьшается до N с сохранением пропорций (width/height атрибутами).
const answer = prompt('Максимальная ширина <image>, единицы сцены:', '64');
if (answer == null) return 'отменено';
const max = Number(answer);
if (!(max > 0)) throw new Error(`не число: ${answer}`);
const changed = [];
const visit = (node, path) => {
  if (node.tag === 'image') {
    const w = Number(node.attrs.width);
    const h = Number(node.attrs.height);
    if (w > max) {
      const ref = node.attrs.id ?? path;
      const k = max / w;
      tml.doc.exec('node.setAttr', { node: ref, name: 'width', value: max });
      if (h > 0) tml.doc.exec('node.setAttr', { node: ref, name: 'height', value: Math.round(h * k * 100) / 100 });
      changed.push(ref);
    }
  }
  node.children.forEach((c, i) => visit(c, path === '' ? String(i) : `${path}/${i}`));
};
visit(tml.doc.scene, '');
return changed.length ? `уменьшено: ${changed.join(', ')}` : `все image уже ≤ ${max}`;
