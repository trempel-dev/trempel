// Synthetic Spine skeletons for the trempel-spine-import tests — written here, in code (no Spine
// file of anyone's in the repo): a bone chain with rotation and bezier curves, split timelines and
// steps with alpha and colour, frame changes with a mesh and a draw order clone, a 3.5 skeleton,
// colours / blends / draw order timelines of the 1.3 format.

import { buildClips } from '../../src/spine-import/clips.js';
import { buildRig, sceneSvg } from '../../src/spine-import/rig.js';
import { readSkeleton, type SkeletonData } from '../../src/spine-import/spine.js';

type J = Record<string, unknown>;

export const SKELETONS: Record<string, J> = {
  chain: {
    skeleton: { spine: '4.1.17' },
    bones: [
      { name: 'root' },
      { name: 'arm', parent: 'root', x: 10, y: 20, rotation: 30 },
      { name: 'forearm', parent: 'arm', x: 50, rotation: -45, scaleX: 1.5 },
      { name: 'hand', parent: 'forearm', x: 40, scaleY: 0.5 },
    ],
    slots: [
      { name: 'arm', bone: 'arm', attachment: 'bar' },
      { name: 'forearm', bone: 'forearm', attachment: 'bar' },
      { name: 'hand', bone: 'hand', attachment: 'dot' },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          arm: { bar: { x: 25, width: 50, height: 10 } },
          forearm: { bar: { x: 20, rotation: 10, width: 40, height: 8 } },
          hand: { dot: { width: 12, height: 12 } },
        },
      },
    ],
    animations: {
      swing: {
        bones: {
          arm: { rotate: [{ curve: [0.2, 0, 0.8, 40] }, { time: 1, value: 40 }, { time: 2 }] },
          forearm: {
            rotate: [{ time: 0.5, value: -30, curve: 'stepped' }, { time: 1.5, value: 20 }],
            scale: [{ curve: [0.3, 1.2, 0.6, 1.5, 0.3, 1, 0.6, 0.8] }, { time: 1, x: 1.5, y: 0.8 }, { time: 2 }],
          },
          root: { translate: [{}, { time: 2, x: 100, y: -50 }] },
        },
      },
    },
  },
  frames: {
    skeleton: { spine: '4.1.17' },
    bones: [{ name: 'root' }, { name: 'body', parent: 'root', y: 10 }, { name: 'head', parent: 'body', y: 50 }, { name: 'fx', parent: 'root', x: 30 }],
    slots: [
      { name: 'cape', bone: 'body', attachment: 'cape' },
      { name: 'body', bone: 'body', attachment: 'body' },
      { name: 'fx', bone: 'fx', attachment: 'glow' },
      { name: 'overlay', bone: 'body' },
      { name: 'head', bone: 'head', attachment: 'head_a' },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          cape: { cape: { type: 'mesh', uvs: [0, 1, 1, 1, 1, 0, 0, 0], triangles: [0, 1, 2, 2, 3, 0], vertices: [-10, -30, 14, -30, 14, 2, -10, 2], hull: 4, width: 24, height: 32 } },
          body: { body: { width: 30, height: 50 } },
          fx: { glow: { width: 20, height: 20 }, star: { rotation: 45, width: 30, height: 30 } },
          overlay: { shine: { width: 10, height: 60 } },
          head: { head_a: { y: 10, width: 40, height: 40 }, head_b: { y: 10, width: 40, height: 40 } },
        },
      },
    ],
    events: { step: {}, sound: { string: 'a' } },
    animations: {
      talk: {
        slots: {
          head: { attachment: [{ time: 0.2, name: 'head_b' }, { time: 0.4, name: 'head_a' }, { time: 0.6, name: null }, { time: 0.8, name: 'head_b' }] },
          fx: { attachment: [{ time: 0.5, name: 'star' }, { time: 1, name: 'glow' }] },
          overlay: { attachment: [{ time: 0.3, name: 'shine' }] },
        },
        bones: { head: { rotate: [{}, { time: 0.5, value: 15 }, { time: 1 }] } },
        events: [{ time: 0.2, name: 'step' }, { time: 0.9, name: 'sound', string: 'boom' }],
        // fx moves between overlay and head — across the clone body--2: not representable by sibling z
        drawOrder: [{ time: 0.5, offsets: [{ slot: 'fx', offset: 1 }] }],
      },
    },
  },
  steps: {
    skeleton: { spine: '4.1.17' },
    bones: [{ name: 'root' }, { name: 'box', parent: 'root', y: 30 }],
    slots: [{ name: 'box', bone: 'box', attachment: 'sq', color: 'ffffffcc', blend: 'additive' }],
    skins: [{ name: 'default', attachments: { box: { sq: { width: 20, height: 20 } } } }],
    animations: {
      blink: {
        bones: { box: { translatex: [{}, { time: 0.5, value: 20, curve: 'stepped' }, { time: 1, value: -20 }], scaley: [{ time: 0.25, value: 2 }, { time: 0.75, value: 0.5 }] } },
        slots: { box: { alpha: [{ value: 1 }, { time: 1 }] } },
      },
      tint: {
        slots: {
          box: {
            rgba: [
              // r falls, g rises on one normalized curve, b flat → one tint ease; alpha has its own
              { color: 'ff0000ff', curve: [0.5, 1, 0.5, 0, 0.5, 0, 0.5, 1, 0.5, 0, 0.5, 0, 0.5, 1, 0.5, 0.502] },
              { time: 1, color: '00ff0080' },
            ],
          },
        },
      },
      pulse: { slots: { box: { alpha: [{ value: 1, curve: [0.3, 0.2, 0.7, 0.2] }, { time: 1, value: 1 }] } } },
    },
  },
  legacy35: {
    skeleton: { spine: '3.5.51' },
    bones: [{ name: 'root' }, { name: 'wing', parent: 'root', x: 5, y: 5, rotation: 20 }, { name: 'tip', parent: 'wing', x: 30, inheritRotation: false }],
    slots: [{ name: 'wing', bone: 'wing', attachment: 'w', color: 'ffffff80' }],
    skins: { default: { wing: { w: { x: 15, width: 30, height: 6 } } } },
    animations: {
      flap: {
        bones: {
          wing: {
            rotate: [{ time: 0, angle: 0, curve: [0.25, 0, 0.75, 1] }, { time: 0.5, angle: 45 }, { time: 1, angle: 0 }],
            translate: [{ time: 0, x: 0, y: 0, curve: 'stepped' }, { time: 0.5, x: 0, y: 10 }, { time: 1, x: 0, y: 0 }],
          },
        },
        slots: { wing: { color: [{ time: 0, color: 'ffffff80' }, { time: 1, color: 'ffffffff' }] } },
      },
      glide: { bones: { wing: { rotate: [{ time: 0, angle: 10, curve: 0.25, c3: 0.75 }, { time: 1, angle: -10 }] } } },
    },
  },
  // 1.3: slot colour in the setup pose and animated with one ease, blend modes, attachment colours,
  // a draw order timeline that swaps siblings (representable with z), a two-colour slot.
  colours: {
    skeleton: { spine: '4.2.0' },
    bones: [{ name: 'root' }, { name: 'a', parent: 'root', x: -20 }, { name: 'b', parent: 'root', x: 20 }],
    slots: [
      { name: 'back', bone: 'a', attachment: 'sq', color: '80ff40ff', blend: 'multiply' },
      { name: 'front', bone: 'b', attachment: 'sq', blend: 'screen' },
      { name: 'glow', bone: 'b', attachment: 'dot', blend: 'additive', dark: '000000' },
      { name: 'paint', bone: 'a', attachment: 'red' },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          back: { sq: { width: 20, height: 20 } },
          front: { sq: { width: 20, height: 20 } },
          glow: { dot: { width: 8, height: 8 } },
          paint: { red: { width: 10, height: 10, color: 'ff8080ff' }, blue: { width: 10, height: 10, color: '8080ffff' } },
        },
      },
    ],
    animations: {
      fade: {
        slots: {
          back: { rgba: [{ color: '80ff40ff', curve: [0.25, 128 / 255, 0.75, 1, 0.25, 1, 0.75, 1, 0.25, 64 / 255, 0.75, 1, 0.25, 1, 0.75, 1] }, { time: 1, color: 'ffffffff' }] },
          front: { rgb: [{ color: 'ffffff', curve: 'stepped' }, { time: 0.5, color: '0000ff' }] },
          glow: { rgba2: [{ light: 'ffffffff', dark: '000000' }, { time: 1, light: 'ff0000ff', dark: '00ff00' }] },
          paint: { attachment: [{ time: 0.5, name: 'blue' }] },
        },
        // back goes behind the b slots: root's children a, b reorder (siblings) → z; then back to setup
        drawOrder: [{ time: 0.4, offsets: [{ slot: 'back', offset: 2 }] }, { time: 0.8 }],
      },
    },
  },
};

export const NAMES = Object.keys(SKELETONS);

export function skeleton(name: string): SkeletonData {
  return readSkeleton(structuredClone(SKELETONS[name]), name);
}

/** Skeleton → rig, scene.svg, clips — the whole transfer without files. */
export function transfer(name: string, fps = 30) {
  const sk = skeleton(name);
  const rig = buildRig(sk);
  const svg = sceneSvg(sk, rig);
  const { md, stats } = buildClips(sk, rig, { fps });
  return { sk, rig, svg, md, stats };
}
