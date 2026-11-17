import { describe, it, expect } from 'vitest';
import { apply, localMatrix, parseTransform, type Matrix } from '../src/transform';
import { thrown } from './helpers/codes';

const close = (m: Matrix, want: Matrix): void => {
  m.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
};
const pt = (src: string, x: number, y: number): [number, number] => {
  const p = apply(parseTransform(src), x, y);
  return [+p.x.toFixed(9) + 0, +p.y.toFixed(9) + 0];
};

describe('transform — single functions', () => {
  it('empty / missing → identity', () => {
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform('  ')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('translate with one or two args, commas or spaces', () => {
    expect(parseTransform('translate(320,160)')).toEqual([1, 0, 0, 1, 320, 160]);
    expect(parseTransform('translate( 5 )')).toEqual([1, 0, 0, 1, 5, 0]);
    expect(parseTransform('translate(-1.5e1 .5)')).toEqual([1, 0, 0, 1, -15, 0.5]);
  });

  it('scale uniform and non-uniform', () => {
    expect(parseTransform('scale(2)')).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform('scale(2, -1)')).toEqual([2, 0, 0, -1, 0, 0]);
  });

  it('rotate in degrees, optionally about a centre', () => {
    expect(pt('rotate(90)', 1, 0)).toEqual([0, 1]);
    expect(pt('rotate(90 10 10)', 10, 10)).toEqual([10, 10]); // the centre stays put
    expect(pt('rotate(180, 10, 0)', 0, 0)).toEqual([20, 0]);
  });

  it('matrix is taken verbatim (what editors write)', () => {
    expect(parseTransform('matrix(1 0 0 1 12.5 -3)')).toEqual([1, 0, 0, 1, 12.5, -3]);
    expect(parseTransform('matrix(0.866,0.5,-0.5,0.866,10,20)')).toEqual([0.866, 0.5, -0.5, 0.866, 10, 20]);
  });

  it('skewX / skewY', () => {
    close(parseTransform('skewX(45)'), [1, 0, 1, 1, 0, 0]);
    close(parseTransform('skewY(45)'), [1, 1, 0, 1, 0, 0]);
  });
});

describe('transform — chains compose like SVG (rightmost applies first)', () => {
  it('translate then scale', () => {
    // point (1,1): scale → (2,2), then translate → (12,22)
    expect(pt('translate(10 20) scale(2)', 1, 1)).toEqual([12, 22]);
    // order matters: translate inside the scale
    expect(pt('scale(2) translate(10 20)', 1, 1)).toEqual([22, 42]);
  });

  it('translate rotate scale', () => {
    expect(pt('translate(100,0) rotate(90) scale(2)', 1, 0)).toEqual([100, 2]);
  });

  it('a chain equals the product of its matrices', () => {
    close(
      parseTransform('translate(10,20) rotate(30) scale(2,3)'),
      parseTransform(
        `matrix(${[
          2 * Math.cos(Math.PI / 6),
          2 * Math.sin(Math.PI / 6),
          -3 * Math.sin(Math.PI / 6),
          3 * Math.cos(Math.PI / 6),
          10,
          20,
        ].join(' ')})`,
      ),
    );
  });

  it('localMatrix puts x/y inside the transform', () => {
    const m = localMatrix({ x: '5', y: '0', transform: 'scale(2)' }, true);
    expect(apply(m, 0, 0)).toEqual({ x: 10, y: 0 });
    expect(localMatrix({ x: '5', transform: 'scale(2)' }, false)).toEqual([2, 0, 0, 2, 0, 0]);
  });
});

describe('transform — errors are explicit', () => {
  it.each([
    // the code, plus what the message names: the function, its arguments, the expected arity, the column
    ['perspective(3)', '"perspective"'],
    ['translate(1,2,3)', 'translate(1,2,3)'],
    ['matrix(1 0 0 1)', '6'],
    ['scale(a)', 'scale(a)'],
    ['translate(1,2) garbage', '16'],
  ])('%s', (src, named) => {
    const e = thrown(() => parseTransform(src));
    expect(e).toMatchObject({ code: 'E_TRANSFORM' });
    expect(e.message).toContain(named);
  });
});
