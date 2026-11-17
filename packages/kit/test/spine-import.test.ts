// Kit 2.2 (TRM-12): trempel-spine-import — Spine skeletons → Trempel scenes and md clips, verified
// against Trempel's own player. Skeletons are synthetic, built in test/helpers/spine.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { compileClipsResult, parse } from '@trempel/scene';
import { encodePng } from '../src/fx-import/image.js';
import { crop, decodePng, extend, rotateCw, unpremultiply, cutRegions } from '../src/spine-import/art.js';
import { parseAtlas, regionIndex } from '../src/spine-import/atlas.js';
import { buildClips } from '../src/spine-import/clips.js';
import { easeOf, segmentAt, valueAt } from '../src/spine-import/curve.js';
import { posedSvg, clipsOf } from '../src/spine-import/frames.js';
import { importSkeleton, importSkeletons, skeletonFiles } from '../src/spine-import/import.js';
import { decompose, samplePose } from '../src/spine-import/pose.js';
import { buildRig, defaultHref, sceneSvg, transformOf } from '../src/spine-import/rig.js';
import { drawOrderOf, readSkeleton } from '../src/spine-import/spine.js';
import { verify } from '../src/spine-import/verify.js';
import { main } from '../src/cli/spine-import.js';
import { NAMES, SKELETONS, skeleton, transfer } from './helpers/spine.js';

const tmp = mkdtempSync(join(tmpdir(), 'spine-import-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The body of `## $track <id>` blocks, in order. */
const tracks = (md: string, id: string): string[] => md.split(/\n(?=## |# )/).filter((b) => b.startsWith(`## $track ${id}\n`));

describe('spine-import: reading', () => {
  it('4.x absolute curves per value, 3.x normalized curves made absolute', () => {
    const sk = skeleton('chain');
    const scale = sk.animations[0].bones.filter((b) => b.bone === 'forearm' && b.prop.startsWith('scale'));
    expect(scale.map((s) => s.keys[0].curve)).toEqual([
      { kind: 'bezier', cx1: 0.3, cy1: 1.2, cx2: 0.6, cy2: 1.5 },
      { kind: 'bezier', cx1: 0.3, cy1: 1, cx2: 0.6, cy2: 0.8 },
    ]);
    const leg = skeleton('legacy35');
    const rot = leg.animations[0].bones.find((b) => b.prop === 'rotate')!;
    expect(rot.keys[0].curve).toEqual({ kind: 'bezier', cx1: 0.125, cy1: 0, cx2: 0.375, cy2: 45 });
    // 3.8: c3 with defaults
    const glide = leg.animations[1].bones[0].keys[0].curve;
    expect(glide).toEqual({ kind: 'bezier', cx1: 0.25, cy1: 10, cx2: 0.75, cy2: -10 });
    expect(leg.bones[2].inherit).toBe('noRotationOrReflection');
  });

  it('colour timelines by channel, dark colours, draw order offsets, events with data', () => {
    const sk = skeleton('colours');
    const fade = sk.animations[0];
    expect(fade.color.map((c) => c.slot)).toEqual(['back', 'front', 'glow']);
    expect(fade.tinted.sort()).toEqual(['back', 'front', 'glow']);
    expect(fade.dark).toEqual(['glow']);
    expect(sk.slots[2].dark).toBe(true);
    expect(fade.drawOrder).toEqual([{ t: 0.4, offsets: [{ slot: 'back', offset: 2 }] }, { t: 0.8, offsets: null }]);
    expect(drawOrderOf(sk, fade.drawOrder[0].offsets)).toEqual([1, 2, 0, 3]);
    expect(drawOrderOf(sk, null)).toEqual([0, 1, 2, 3]);
    expect(skeleton('frames').animations[0].events.map((e) => e.payload)).toEqual([false, true]);
  });

  it('not a skeleton → E_SPINE_IMPORT_INPUT', () => {
    expect(() => readSkeleton({ nope: 1 }, 'x')).toThrow(/^E_SPINE_IMPORT_INPUT: /);
  });

  it('interpolation: stepped, linear, bezier; before the first key undefined', () => {
    const k = (t: number, v: number, curve: never) => ({ t, v, curve });
    const a = k(0, 0, { kind: 'stepped' } as never);
    const b = k(1, 10, { kind: 'linear' } as never);
    expect(segmentAt(a, b, 0.99)).toBe(0);
    expect(segmentAt({ ...a, curve: { kind: 'linear' } }, b, 0.25)).toBe(2.5);
    expect(valueAt([b], 0.5)).toBeUndefined();
    expect(valueAt([a, b], 2)).toBe(10);
    const bz = k(0, 0, { kind: 'bezier', cx1: 0.25, cy1: 0, cx2: 0.75, cy2: 10 } as never);
    expect(segmentAt(bz, b, 0.5)).toBeCloseTo(5, 6);
    expect(easeOf(bz, b)).toEqual([0.25, 0, 0.75, 1]);
    // flat value, curved → baked; linear in disguise
    expect(easeOf(k(0, 1, { kind: 'bezier', cx1: 0.3, cy1: 0.2, cx2: 0.7, cy2: 0.2 } as never), k(1, 1, { kind: 'linear' } as never))).toBeNull();
    expect(easeOf(k(0, 0, { kind: 'bezier', cx1: 1 / 3, cy1: 10 / 3, cx2: 2 / 3, cy2: 20 / 3 } as never), b)).toBe('linear');
  });
});

describe('spine-import: the scene', () => {
  it('y flip: translate(x, −y) rotate(−r) scale', () => {
    expect(transformOf(10, 20, 30, 1, 1)).toBe('translate(10 -20) rotate(-30)');
    expect(transformOf(0, 0, 0, 1.5, 1)).toBe('scale(1.5 1)');
    expect(transformOf(0, 0, 0, 1, 1)).toBe('');
  });

  it('scene.svg parses for every skeleton, sterile (no tml:)', () => {
    for (const name of NAMES) {
      const { svg } = transfer(name);
      const tree = parse(svg);
      expect(tree.tag).toBe('svg');
      expect(tree.children[0].attrs.id).toBe(name);
      expect(svg).not.toMatch(/tml:/);
    }
  });

  it('chain: nesting follows the bone tree, slots under their bones', () => {
    const { svg } = transfer('chain');
    expect(svg).toMatch(/<g id="arm" transform="translate\(10 -20\) rotate\(-30\)">\s*<g id="arm-slot">/);
    expect(svg).toMatch(/<g id="forearm" transform="translate\(50 0\) rotate\(45\) scale\(1.5 1\)">/);
    expect(svg).toMatch(/<image id="forearm-img" href="art\/bar.png" x="-20" y="-4" width="40" height="8" transform="translate\(20 0\) rotate\(-10\)"\/>/);
  });

  it('frames: a draw order clone, single (tex) vs multi (alpha) slots, a mesh stub', () => {
    const { rig, svg } = transfer('frames');
    expect(rig.boneIds.get('body')).toEqual(['body', 'body--2']);
    expect([...svg.matchAll(/<g id="([\w-]+)-slot"/g)].map((m) => m[1])).toEqual(['cape', 'body', 'fx', 'overlay', 'head']);
    expect(rig.slots.get('head')!.mode).toBe('single');
    expect(rig.slots.get('head')!.hides).toBe(true);
    expect(rig.slots.get('fx')!.mode).toBe('multi');
    expect(svg).toMatch(/id="fx-img-star"[^>]*opacity="0"/);
    expect(svg).toMatch(/id="overlay-img"[^>]*opacity="0"/);
    const cape = rig.slots.get('cape')!.images[0];
    expect(cape.stub).toBe(true);
    expect([cape.geom.x, cape.geom.y, cape.geom.width, cape.geom.height]).toEqual([2, -14, 24, 32]);
    expect(rig.nonRegion).toEqual(['mesh']);
  });

  it('1.3: slot colour → data-tint, blends → mix-blend-mode, attachment colours on images, dark colour reported', () => {
    const { rig, svg } = transfer('colours');
    expect(svg).toMatch(/<g id="back-slot" data-tint="#80ff40" style="mix-blend-mode: multiply">/);
    expect(svg).toMatch(/<g id="front-slot" style="mix-blend-mode: screen">/);
    expect(svg).toMatch(/<g id="glow-slot" style="mix-blend-mode: plus-lighter">/);
    // paint: attachments of their own colour, the slot colour does not animate → baked into images
    expect(rig.slots.get('paint')!.groupTint).toBe(false);
    expect(svg).toMatch(/id="paint-img-red"[^>]*data-tint="#ff8080"/);
    expect(svg).toMatch(/id="paint-img-blue"[^>]*opacity="0" data-tint="#8080ff"/);
    expect(rig.warnings.some((w) => /glow: a dark colour/.test(w))).toBe(true);
    // the scene mounts on Trempel (the attributes are valid 1.3)
    expect(transfer('steps').svg).toMatch(/opacity="0.8" style="mix-blend-mode: plus-lighter"/);
  });

  it('ids: Spine names become valid unique ids', () => {
    const sk = readSkeleton({ skeleton: { spine: '4.1' }, bones: [{ name: 'root' }, { name: '1 arm/L', parent: 'root' }], slots: [{ name: 'root', bone: 'root' }] }, 'root');
    const rig = buildRig(sk);
    expect(rig.rootId).toBe('root');
    expect(rig.boneIds.get('root')).toEqual(['root_2']);
    expect(rig.boneIds.get('1 arm/L')).toEqual(['_1_arm_L']);
    expect(rig.slots.get('root')!.id).toBe('root-slot');
    parse(sceneSvg(sk, rig));
  });

  it('warnings: inheritance, unknown skin', () => {
    expect(transfer('legacy35').rig.warnings.some((w) => /noRotationOrReflection/.test(w))).toBe(true);
    expect(() => buildRig(skeleton('chain'), { skin: 'red' })).toThrow(/^E_SPINE_IMPORT_USAGE: /);
  });
});

describe('spine-import: clips', () => {
  it('every skeleton compiles with Trempel compileClips against its scene', () => {
    for (const name of NAMES) {
      const { svg, md } = transfer(name);
      const { errors, clips } = compileClipsResult(md, parse(svg), { tex: defaultHref });
      expect(errors, name).toEqual([]);
      expect(Object.keys(clips).length).toBeGreaterThan(0);
    }
  });

  it('chain: rotation negated, bezier ease, step setup key, per-value tables', () => {
    const { md } = transfer('chain');
    const arm = tracks(md, 'arm');
    expect(arm.length).toBe(1);
    expect(arm[0]).toMatch(/\| 0 \| 0 \| \[0\.2, 0, 0\.8, 1\] \|\n\| 1 \| -40 \|  \|\n\| 2 \| 0 \|  \|/);
    const fa = tracks(md, 'forearm');
    expect(fa.some((t) => /\| t \| rotation \| ease \|[\s\S]*\| 0 \| 0 \| step \|\n\| 0\.5 \| 30 \| step \|\n\| 1\.5 \| -20 \|/.test(t))).toBe(true);
    expect(fa.some((t) => /\| t \| scaleX \| ease \|/.test(t))).toBe(true);
    expect(fa.some((t) => /\| t \| scaleY \| ease \|/.test(t))).toBe(true);
    expect(tracks(md, 'root')[0]).toMatch(/\| t \| x \| y \| ease \|[\s\S]*\| 2 \| 100 \| 50 \|/);
  });

  it('steps: split timelines, alpha absolute, a flat overshoot baked, a tint with one ease', () => {
    const { md, stats } = transfer('steps');
    expect(md).toMatch(/## \$track box\n\| t \| x \| ease \|/);
    expect(md).toMatch(/\| 0 \| 1 \| step \|\n\| 0\.25 \| 2 \|/);
    expect(stats.find((s) => s.name === 'pulse')!.baked).toBe(1);
    // r and g share one normalized curve, b is flat: one ease for the tint column, alpha its own table
    expect(stats.find((s) => s.name === 'tint')!.baked).toBe(0);
    expect(md).toMatch(/\| t \| tint \| ease \|\n\| --- \| --- \| --- \|\n\| 0 \| #ff0000 \| \[0\.5, 0, 0\.5, 1\] \|/);
  });

  it('frames: tex on the slot group, visibility on images, events, clone tracks', () => {
    const { md } = transfer('frames');
    expect(tracks(md, 'head-slot')[0]).toMatch(/\| t \| tex \|[\s\S]*\| 0\.2 \| head_b \|/);
    expect(tracks(md, 'head-img')[0]).toMatch(/\| 0\.6 \| 0 \| step \|\n\| 0\.8 \| 1 \| step \|/);
    expect(tracks(md, 'fx-img-star')[0]).toMatch(/\| 0\.5 \| 1 \| step \|/);
    expect(md).toMatch(/## \$events\n\| t \| event \|\n\| --- \| --- \|\n\| 0\.2 \| step \|\n\| 0\.9 \| sound \|/);
    expect(tracks(md, 'body--2').length).toBe(0);
  });

  it('clone groups get the bone tracks', () => {
    const sk = skeleton('frames');
    sk.animations[0].bones.push({ bone: 'body', prop: 'x', keys: [{ t: 0, v: 0, curve: { kind: 'linear' } }, { t: 1, v: 7, curve: { kind: 'linear' } }] });
    const { md } = buildClips(sk, buildRig(sk));
    for (const id of ['body', 'body--2']) expect(tracks(md, id)[0], id).toMatch(/\| 1 \| 7 \|/);
  });

  it('1.3: colour → tint with one ease, draw order → z of siblings, a cross-group reorder reported', () => {
    const { md, stats } = transfer('colours');
    const back = tracks(md, 'back-slot').join('\n');
    expect(back).toMatch(/\| t \| tint \| ease \|\n\| --- \| --- \| --- \|\n\| 0 \| #80ff40 \| \[0\.25, 0, 0\.75, 1\] \|\n\| 1 \| #ffffff \|/);
    expect(tracks(md, 'front-slot').join('\n')).toMatch(/\| 0 \| #ffffff \| step \|\n\| 0\.5 \| #0000ff \|/);
    // z: b before a while back is behind, then the setup order again
    expect(tracks(md, 'a')[0]).toMatch(/\| t \| z \|\n\| --- \| --- \|\n\| 0 \| 0 \|\n\| 0\.4 \| 1 \|\n\| 0\.8 \| 0 \|/);
    expect(tracks(md, 'b')[0]).toMatch(/\| 0 \| 1 \|\n\| 0\.4 \| 0 \|\n\| 0\.8 \| 1 \|/);
    expect(stats[0].drawOrder).toEqual({ keys: 2, z: 2, lost: 0 });
    expect(stats[0].warnings.some((w) => /dark colour/.test(w))).toBe(true);
    const f = transfer('frames').stats[0];
    expect(f.drawOrder).toEqual({ keys: 1, z: 0, lost: 1 });
    expect(f.warnings.some((w) => /not representable/.test(w))).toBe(true);
  });
});

describe('spine-import: verification', () => {
  it('every animation matches the reference sampler (60 points), draw order and colour included', () => {
    for (const name of NAMES) {
      const { sk, rig, svg, md, stats } = transfer(name);
      const r = verify(sk, rig, svg, md, stats);
      expect(r.compileErrors, name).toBeUndefined();
      expect(r.anims.length).toBe(sk.animations.length);
      for (const a of r.anims) expect(a.ok, `${name}/${a.anim}: ${a.examples.join('; ')}`).toBe(true);
    }
    const c = transfer('colours');
    const r = verify(c.sk, c.rig, c.svg, c.md, c.stats).anims[0];
    expect(r.orderBad).toBe(0);
    expect(r.max.color).toBeLessThan(0.01);
    // the not representable reorder shows up as draw order samples off (expected, reported)
    const f = transfer('frames');
    expect(verify(f.sk, f.rig, f.svg, f.md, f.stats).anims[0].orderBad).toBeGreaterThan(0);
  });

  it('legacy: a non-normal inheritance bone is excluded, with the reason', () => {
    const { sk, rig, svg, md, stats } = transfer('legacy35');
    expect(verify(sk, rig, svg, md, stats).excluded).toEqual([{ bone: 'tip', reason: 'inheritance noRotationOrReflection' }]);
  });

  it('the check is not vacuous: a wrong value, sign, lost key, colour, z are caught', () => {
    const { sk, rig, svg, md, stats } = transfer('chain');
    expect(verify(sk, rig, svg, md.replace('| 1 | -40 |', '| 1 | -41 |'), stats).anims[0].ok).toBe(false);
    expect(verify(sk, rig, svg, md.replace('| 2 | 100 | 50 |', '| 2 | 100 | -50 |'), stats).anims[0].ok).toBe(false);
    const f = transfer('frames');
    expect(verify(f.sk, f.rig, f.svg, f.md.replace('| 0.8 | 1 | step |', ''), f.stats).anims[0].attachmentBad).toBeGreaterThan(0);
    const c = transfer('colours');
    expect(verify(c.sk, c.rig, c.svg, c.md.replace('| 1 | #ffffff |', '| 1 | #ff0000 |'), c.stats).anims[0].ok).toBe(false);
    expect(verify(c.sk, c.rig, c.svg, c.md.replace('| 0.4 | 1 |', '| 0.4 | 0 |'), c.stats).anims[0].ok).toBe(false);
  });

  it('compile errors are reported, not thrown', () => {
    const { sk, rig, svg, stats } = transfer('chain');
    const r = verify(sk, rig, svg, '# $clip swing\n## $track nope\n| t | x |\n|---|---|\n| 0 | 1 |\n', stats);
    expect(r.compileErrors!.some((e) => /nope/.test(e))).toBe(true);
  });

  it('baked steep curves stay within tolerance at a coarse fps', () => {
    const sk = readSkeleton(
      {
        skeleton: { spine: '4.1' },
        bones: [{ name: 'root' }, { name: 'p', parent: 'root' }],
        slots: [{ name: 'p', bone: 'p', attachment: 'r' }],
        skins: [{ name: 'default', attachments: { p: { r: { width: 10, height: 10 } } } }],
        animations: {
          a: {
            bones: {
              p: {
                scale: [{ x: 0.3, y: 0.3, curve: [1.2, 0.3, 0.4, 0, 1.2, 0.3, 0.4, 0] }, { time: 1, x: 0, y: 0 }],
                translate: [{ curve: [0.9, 0, 0.95, 300, 0.9, 0, 0.95, 0] }, { time: 1, x: 300 }],
              },
            },
          },
        },
      },
      'steep',
    );
    const rig = buildRig(sk);
    const svg = sceneSvg(sk, rig);
    const { md, stats } = buildClips(sk, rig, { fps: 10 });
    const r = verify(sk, rig, svg, md, stats);
    expect(r.anims[0].ok, r.anims[0].examples.join('; ')).toBe(true);
  });

  it('pose sampler: world matrix with shear, decompose', () => {
    const sk = skeleton('chain');
    const p = samplePose(sk, sk.animations[0], 1);
    const arm = decompose(p.world.get('arm')!);
    expect(arm.rotation).toBeCloseTo(70, 6);
    expect(arm.x).toBeCloseTo(60, 6); // root moved 50 by t = 1
  });
});

/** A tiny RGBA PNG (w × h, pixel (x, y) = [x*10, y*10, 7, 255]). */
function png(w: number, h: number, alpha = 255): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([x * 10, y * 10, 7, alpha], (y * w + x) * 4);
  return encodePng(w, h, px);
}

/** A PNG of another colour type / depth, built by hand. */
function pngRaw(w: number, h: number, depth: number, type: number, rows: number[][], extra: [string, number[]][] = []): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: number[] | Uint8Array) => {
    const d = Uint8Array.from(data);
    const out = new Uint8Array(12 + d.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, d.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(d, 8);
    dv.setUint32(8 + d.length, crc(out.subarray(4, 8 + d.length)));
    return [...out];
  };
  const ihdr = [0, 0, 0, w, 0, 0, 0, h, depth, type, 0, 0, 0];
  const raw = Uint8Array.from(rows.flatMap((r) => [0, ...r]));
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', ihdr), ...extra.flatMap(([t, d]) => chunk(t, d)), ...chunk('IDAT', deflateSync(raw)), ...chunk('IEND', [])]);
}

describe('spine-import: atlas and art', () => {
  it('both atlas dialects, page props, an index', () => {
    const a = parseAtlas(`page.png
size: 64, 32
pma: true
old
  rotate: true
  xy: 2, 4
  size: 6, 8
  orig: 10, 12
  offset: 1, 2
  index: -1
seq
  xy: 0, 0
  size: 1, 1
  index: 3

page2.png
size:32,32
new
bounds:1,2,3,4
offsets:1,1,5,6
rotate:90
`);
    expect(a.pages.map((p) => [p.file, p.width, p.pma])).toEqual([['page.png', 64, true], ['page2.png', 32, false]]);
    const old = a.regions[0];
    expect([old.x, old.y, old.w, old.h, old.origW, old.origH, old.offX, old.offY, old.degrees]).toEqual([2, 4, 6, 8, 10, 12, 1, 2, 90]);
    expect(a.regions[2]).toMatchObject({ name: 'new', x: 1, y: 2, w: 3, h: 4, offX: 1, offY: 1, origW: 5, origH: 6, degrees: 90 });
    expect(regionIndex(a).get('seq3')!.name).toBe('seq');
    expect(() => parseAtlas('p.png\nr\n  xy: a, b\n')).toThrow(/^E_SPINE_IMPORT_ATLAS: /);
  });

  it('PNG: RGBA, palette with tRNS, grey 1-bit, interlace refused only when malformed', () => {
    const img = decodePng(png(3, 2));
    expect([img.width, img.height]).toEqual([3, 2]);
    expect([...img.data.subarray(4 * 4, 4 * 4 + 4)]).toEqual([10, 10, 7, 255]); // (1, 1)
    const pal = decodePng(pngRaw(2, 1, 8, 3, [[0, 1]], [['PLTE', [255, 0, 0, 0, 0, 255]], ['tRNS', [128]]]));
    expect([...pal.data]).toEqual([255, 0, 0, 128, 0, 0, 255, 255]);
    const grey = decodePng(pngRaw(8, 1, 1, 0, [[0b10100000]]));
    expect([...grey.data.subarray(0, 12)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const ga = decodePng(pngRaw(1, 1, 8, 4, [[100, 50]]));
    expect([...ga.data]).toEqual([100, 100, 100, 50]);
    const rgb16 = decodePng(pngRaw(1, 1, 16, 2, [[1, 2, 3, 4, 5, 6]]));
    expect([...rgb16.data]).toEqual([1, 3, 5, 255]);
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/^E_SPINE_IMPORT_ART: /);
  });

  it('crop, clockwise turn, margins, un-premultiply', () => {
    const img = decodePng(png(3, 2));
    const c = crop(img, 1, 0, 2, 2);
    expect([c.width, c.height, c.data[0]]).toEqual([2, 2, 10]);
    const r = rotateCw(img, 90);
    expect([r.width, r.height]).toEqual([2, 3]);
    // top-left after a clockwise turn is the old bottom-left (0, 1)
    expect([...r.data.subarray(0, 4)]).toEqual([0, 10, 7, 255]);
    expect(rotateCw(img, 360).data).toEqual(img.data);
    const e = extend(img, 1, 0, 0, 2);
    expect([e.width, e.height, e.data[3]]).toEqual([5, 3, 0]);
    const p = unpremultiply({ width: 1, height: 1, data: Uint8Array.from([50, 0, 25, 128]) });
    expect([...p.data]).toEqual([100, 0, 50, 128]);
  });

  it('cutRegions: rotated and trimmed regions at their original size, missing listed, no metadata', () => {
    const dir = join(tmp, 'atlas');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.png'), png(8, 8));
    const atlas = parseAtlas('page.png\nsize: 8,8\na\n  xy: 0, 0\n  size: 3, 2\n  orig: 5, 4\n  offset: 1, 1\nb\n  rotate: true\n  xy: 4, 0\n  size: 2, 3\n');
    const r = cutRegions(atlas, dir, ['a', 'b', 'zz'], join(dir, 'out'));
    expect(r.missing).toEqual(['zz']);
    const a = decodePng(new Uint8Array(readFileSync(join(dir, 'out', 'a.png'))));
    expect([a.width, a.height]).toEqual([5, 4]);
    expect(a.data[(1 * 5 + 1) * 4 + 3]).toBe(255); // the trimmed image starts at (1, 4 − 2 − 1 = 1)
    expect(a.data[3]).toBe(0);
    const b = decodePng(new Uint8Array(readFileSync(join(dir, 'out', 'b.png'))));
    expect([b.width, b.height]).toEqual([2, 3]);
    expect(String.fromCharCode(...readFileSync(join(dir, 'out', 'a.png')).subarray(0, 64))).not.toMatch(/tEXt|iTXt|eXIf/);
    expect(() => cutRegions(parseAtlas('none.png\nx\n  xy: 0,0\n  size: 1,1\n'), dir, ['x'], dir)).toThrow(/^E_SPINE_IMPORT_ART: /);
  });
});

describe('spine-import: files and the bin', () => {
  const write = (dir: string, name: string, withAtlas = true) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(SKELETONS[name]));
    if (!withAtlas) return;
    writeFileSync(join(dir, 'page.png'), png(64, 64));
    const regions = name === 'frames' ? ['cape', 'body', 'glow', 'star', 'shine', 'head_a', 'head_b'] : ['bar', 'dot', 'sq', 'w', 'red', 'blue'];
    writeFileSync(join(dir, `${name}.atlas`), `page.png\nsize: 64,64\n${regions.map((r, i) => `${r}\n  xy: ${i * 4}, 0\n  size: 4, 4\n`).join('')}`);
  };

  it('one skeleton: scene, md + json, art, report; frames at times', () => {
    const dir = join(tmp, 'one');
    write(dir, 'frames');
    const out = join(dir, 'out');
    const o = importSkeleton(join(dir, 'frames.json'), { out, frames: [0.3, 0.7], clip: 'talk' });
    for (const f of ['scene.svg', 'frames.anim.md', 'frames.anim.json', 'report.md', 'art/glow.png', 'frames/talk@0.3.svg']) expect(existsSync(join(out, f)), f).toBe(true);
    expect(o.artWritten).toBe(7);
    const report = readFileSync(join(out, 'report.md'), 'utf8');
    expect(report).toMatch(/## Transferred/);
    expect(report).toMatch(/draw order keys reorder across bone groups/);
    const frame = readFileSync(join(out, 'frames/talk@0.7.svg'), 'utf8');
    expect(frame).toMatch(/href="..\/art\/head_a.png"/);
    parse(frame);
    expect(() => importSkeleton(join(dir, 'frames.json'), { out, frames: [0.1], clip: 'nope' })).toThrow(/^E_SPINE_IMPORT_USAGE: /);
  });

  it('a folder: every skeleton, summary.md; a missing atlas fails that skeleton only', () => {
    const dir = join(tmp, 'many');
    for (const n of ['chain', 'colours', 'steps']) write(dir, n);
    write(dir, 'legacy35', false);
    writeFileSync(join(dir, 'other.json'), '{"not": "spine"}');
    writeFileSync(join(dir, 'broken.json'), '{');
    const files = skeletonFiles([dir]);
    expect(files.map((f) => f.split('/').pop())).toEqual(['chain.json', 'colours.json', 'legacy35.json', 'steps.json']);
    const r = importSkeletons(files, { out: join(dir, 'out') });
    expect(r.outcomes.length).toBe(3);
    expect(r.failed.map((f) => f.name)).toEqual(['legacy35']);
    expect(r.failed[0].error).toMatch(/^E_SPINE_IMPORT_INPUT: /);
    const summary = readFileSync(join(dir, 'out', 'summary.md'), 'utf8');
    expect(summary).toMatch(/\| colours \| yes \|/);
    expect(summary).toMatch(/Blend modes: \d+ slots/);
    expect(() => importSkeletons(files, { out: dir, atlas: 'x' })).toThrow(/^E_SPINE_IMPORT_USAGE: /);
    expect(() => skeletonFiles([join(dir, 'nope')])).toThrow(/^E_SPINE_IMPORT_INPUT: /);
  });

  it('the bin: usage errors exit 2, a run exits 0, a failed skeleton 1', () => {
    const dir = join(tmp, 'bin');
    write(dir, 'chain');
    const errs: string[] = [];
    const logs: string[] = [];
    const ce = console.error;
    const cl = console.log;
    console.error = (m: string) => void errs.push(String(m));
    console.log = (m: string) => void logs.push(String(m));
    try {
      expect(main([])).toBe(2);
      expect(main(['--bogus', '1'])).toBe(2);
      expect(main(['x.json', '--fps', '0'])).toBe(2);
      expect(main(['x.json', '--frames', 'a'])).toBe(2);
      expect(main(['--help'])).toBe(0);
      expect(main([join(dir, 'nope.json')])).toBe(2);
      expect(main([join(dir, 'empty-dir-does-not-exist')])).toBe(2);
      expect(main([join(dir, 'chain.json'), '--out', join(dir, 'o'), '--points=10'])).toBe(0);
      expect(main([join(dir, 'chain.json'), '--out', join(dir, 'o2'), '--art', 'false', '--verify', 'false'])).toBe(0);
      write(join(dir, 'f'), 'steps', false);
      expect(main([join(dir, 'f', 'steps.json'), '--out', join(dir, 'o3')])).toBe(1);
      mkdirSync(join(dir, 'empty'), { recursive: true });
      expect(main([join(dir, 'empty')])).toBe(2);
    } finally {
      console.error = ce;
      console.log = cl;
    }
    expect(errs.every((e) => /^(E_[A-Z_]+: |usage: )/.test(e))).toBe(true);
    expect(logs.some((l) => /chain: 4 bones, 3 slots, 1 clips, check 1\/1/.test(l))).toBe(true);
  });
});

// Regression on a real corpus: a local run over a folder of Spine skeletons (with their atlases),
// given by TREMPEL_SPINE_CORPUS — the corpus never enters the repo, nor its outputs.
describe.skipIf(!process.env.TREMPEL_SPINE_CORPUS)('spine-import: corpus (TREMPEL_SPINE_CORPUS)', () => {
  it('every skeleton imports and its animations are checked', () => {
    const dir = process.env.TREMPEL_SPINE_CORPUS!;
    const out = process.env.TREMPEL_SPINE_CORPUS_OUT ?? join(tmp, 'corpus');
    const files = skeletonFiles([dir]);
    expect(files.length).toBeGreaterThan(0);
    const r = importSkeletons(files, { out, art: true });
    expect(r.failed).toEqual([]);
    const anims = r.outcomes.reduce((n, o) => n + o.stats.length, 0);
    const conv = r.outcomes.reduce((n, o) => n + (o.verify?.anims.filter((a) => a.ok).length ?? 0), 0);
    console.log(`corpus: ${r.outcomes.length} skeletons, ${anims} animations, converged ${conv} → ${join(out, 'summary.md')}`);
    expect(conv).toBeGreaterThan(0);
  }, 600_000);
});

// keep the helpers referenced (clipsOf / posedSvg are the frames API)
void clipsOf;
void posedSvg;
