// page-leaf.ts — a page leaf (2.1): one Mesh with its own GLSL (WebGL2). The vertex shader rolls
// the grid around a cylinder from the spine and adds perspective; the fragment shader picks the face
// (front / back) and shades it. One draw call, no depth buffer: indices go in columns from the spine
// to the free edge (the height never decreases along s), which is the right painter's order.
// `bend = 0` — a hard leaf (a cover, a card). Front / back by the sign of the final matrix's
// determinant (`vDet`): the screen's projection flips Y, a RenderTexture's does not, and
// gl_FrontFacing alone swaps the faces there (the same holds under a mirrored parent).
//
// Genre-agnostic: an album page, a book, a card turned over (bend 0). The kit turns screens with it
// (ui/transitions.ts: game.screens.show(name, { transition: { leaf } }), page turns and drag inside a
// screen).
//
// Portrait: the spine is the left edge of the column, the left page is off screen — the leaf is
// wholly gone at some phase < 1 (goneAt: ~0.5 for a hard leaf, ~0.7 for a soft one); a forward turn
// ends there, a backward one starts there. Left of the spine is cut off in the shader (uClip), not
// by a mask: on a desktop the column is narrower than the window.

import { Container, Geometry, Matrix, Mesh, Shader, Sprite, Texture, UniformGroup } from 'pixi.js';

// ── the model (pure; the shader computes the same) ─────────────────────────────────────────────

const PI = Math.PI;
const cl = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * The leaf's cross-section at `s` (0 spine … 1 free edge) for phase `t` (0 lies right … 1 lies left),
 * in leaf widths: x along the page, z up. Tangent angle phi(s) = clamp(PI·(t·(1+bend) − bend·(1−s)), 0, PI):
 * the edge leads, the spine lags; lies right — an arc of radius 1/(PI·bend) — lies left.
 */
export function profile(s: number, t: number, bend: number): { x: number; z: number; phi: number } {
  const A = PI * (t * (1 + bend) - bend);
  const K = PI * bend;
  if (K < 0.001) return { x: s * Math.cos(PI * t), z: s * Math.sin(PI * t), phi: PI * t };
  const u0 = cl(-A / K, 0, 1);
  const u1 = cl((PI - A) / K, 0, 1);
  const b = cl(s, u0, u1);
  const p0 = cl(A + K * u0, 0, PI);
  const p1 = cl(A + K * b, 0, PI);
  return { x: Math.min(s, u0) + (Math.sin(p1) - Math.sin(p0)) / K - Math.max(s - u1, 0), z: (Math.cos(p0) - Math.cos(p1)) / K, phi: cl(A + K * s, 0, PI) };
}

/** Screen x (px from the spine) of a point of the leaf: perspective from `cx` with the camera `cam` px high. */
export const screenX = (pt: { x: number; z: number }, width: number, cx: number, cam: number): number => cx + (pt.x * width - cx) * (cam / (cam - pt.z * width));

/** The phase of row v (twist: the bottom corner leads), as the shader has it. */
export const twisted = (t: number, twist: number, v: number): number => cl(t + twist * (v - 0.5) * Math.sin(PI * t), 0, 1);

/**
 * Portrait: from which phase the leaf is wholly left of the spine (off screen) — a forward turn ends
 * there, a backward one starts there. The slowest row is the top one (v = 0).
 */
export function goneAt(bend: number, twist: number, width: number, cx: number, cam: number): number {
  for (let t = 0.3; t < 1; t += 0.01) {
    const lag = twisted(t, twist, 0);
    let max = -1e9;
    for (let k = 1; k <= 24; k++) max = Math.max(max, screenX(profile(k / 24, lag, bend), width, cx, cam));
    if (max <= 0) return Math.min(1, t + 0.02);
  }
  return 1;
}

/** Determinant of the 2×2 part of a 2D affine matrix (Pixi Matrix a b c d) — its orientation. */
export const det2 = (m: { a: number; b: number; c: number; d: number }): number => m.a * m.d - m.b * m.c;

/** The face the fragment shader shows: front iff (det < 0) ≠ gl_FrontFacing. */
export const showsFront = (det: number, frontFacing: boolean): boolean => det < 0 !== frontFacing;

/**
 * Pixi's projection to a target of w×h px (calculateProjection): the screen flips Y (flipY), a
 * RenderTexture does not. Its determinant's sign is what vDet carries into the fragment shader.
 */
export function projection(w: number, h: number, flipY: boolean): Matrix {
  const sign = flipY ? -1 : 1;
  return new Matrix(2 / w, 0, 0, (sign * 2) / h, -1, -sign);
}

/**
 * Winding of the leaf's first triangle in clip space, the way the GPU decides gl_FrontFacing
 * (counter-clockwise = front facing, y up): the leaf lying right (t = 0) through `mvp`.
 */
export function frontFacingAt(mvp: Matrix, t: number, bend: number, size: { w: number; h: number }): boolean {
  const pt = (s: number, v: number) => {
    const p = profile(s, t, bend);
    return mvp.apply({ x: p.x * size.w, y: v * size.h });
  };
  // Triangle a, b, a+1 of leafGeometry: (s0, v0), (s1, v0), (s0, v1).
  const a = pt(0.25, 0.25);
  const b = pt(0.5, 0.25);
  const c = pt(0.25, 0.5);
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
}

// ── the leaf ───────────────────────────────────────────────────────────────────────────────────

const VERT = `
  in vec2 aPosition;
  out vec2 vUV;
  out float vPhi;
  out float vDet;
  out float vX;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  uniform vec2 uSize;
  uniform float uT;
  uniform float uBend;
  uniform float uTwist;
  uniform vec3 uCam;
  const float PI = 3.141592653589793;
  void main() {
    float s = aPosition.x, v = aPosition.y;
    float t = clamp(uT + uTwist * (v - 0.5) * sin(PI * uT), 0.0, 1.0);
    float A = PI * (t * (1.0 + uBend) - uBend);
    float K = PI * uBend;
    float x, z, phi;
    if (K < 0.001) { phi = PI * t; x = s * cos(phi); z = s * sin(phi); }
    else {
      float u0 = clamp(-A / K, 0.0, 1.0);
      float u1 = clamp((PI - A) / K, 0.0, 1.0);
      float b = clamp(s, u0, u1);
      float p0 = clamp(A + K * u0, 0.0, PI), p1 = clamp(A + K * b, 0.0, PI);
      x = min(s, u0) + (sin(p1) - sin(p0)) / K - max(s - u1, 0.0);
      z = (cos(p0) - cos(p1)) / K;
      phi = clamp(A + K * s, 0.0, PI);
    }
    vec2 p = vec2(x * uSize.x, v * uSize.y);
    float f = uCam.z / (uCam.z - z * uSize.x);
    p = uCam.xy + (p - uCam.xy) * f;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
    vUV = aPosition;
    vPhi = phi;
    vX = p.x;
    vDet = mvp[0][0] * mvp[1][1] - mvp[0][1] * mvp[1][0];
  }`;
const FRAG = `
  in vec2 vUV;
  in float vPhi;
  in float vDet;
  in float vX;
  out vec4 finalColor;
  uniform sampler2D uFront;
  uniform sampler2D uBack;
  uniform vec2 uClip;
  void main() {
    if (vX < uClip.x || vX > uClip.y) discard;      // the column: left of the spine is off the page
    vec3 n = vec3(-sin(vPhi), 0.0, cos(vPhi));
    vec3 L = normalize(vec3(-0.35, 0.0, 0.94));
    vec4 c; float d;
    bool front = (vDet < 0.0) != gl_FrontFacing;
    if (front) { c = texture(uFront, vUV); d = dot(n, L); }
    else { c = texture(uBack, vec2(1.0 - vUV.x, vUV.y)); d = dot(-n, L); }
    float shade = mix(0.45, 1.0, clamp(d / 0.94, 0.0, 1.0));
    finalColor = vec4(c.rgb * shade, c.a);
  }`;

/** The grid (s, v) in columns from the spine to the edge: the painter's order, no depth needed. */
export function leafIndices(cols: number, rows: number): Uint16Array {
  const idx = new Uint16Array(cols * rows * 6);
  for (let c = 0, i = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const a = c * (rows + 1) + r;
      const b = a + rows + 1;
      idx[i++] = a;
      idx[i++] = b;
      idx[i++] = a + 1;
      idx[i++] = a + 1;
      idx[i++] = b;
      idx[i++] = b + 1;
    }
  return idx;
}

function leafGeometry(cols: number, rows: number): Geometry {
  const pos = new Float32Array((cols + 1) * (rows + 1) * 2);
  for (let c = 0, i = 0; c <= cols; c++)
    for (let r = 0; r <= rows; r++) {
      pos[i++] = c / cols;
      pos[i++] = r / rows;
    }
  return new Geometry({ attributes: { aPosition: pos }, indexBuffer: leafIndices(cols, rows) });
}

/** Leaf look: bend 0 = hard (a cover), the stand's soft page = 0.7 / twist 0.15; camera = 4 page widths. */
export interface LeafLook {
  bend: number;
  twist: number;
}
export const LEAF_HARD: LeafLook = { bend: 0, twist: 0 };
export const LEAF_SOFT: LeafLook = { bend: 0.7, twist: 0.15 };
/** Named looks of the transitions. */
export const LEAF_LOOKS = { hard: LEAF_HARD, soft: LEAF_SOFT } as const;
export type LeafLookName = keyof typeof LEAF_LOOKS;
/** Camera height, page widths. */
export const LEAF_CAM = 4;

/** One leaf (spine at x = 0 of its container) with its shadow on the page under it. */
export class PageLeaf extends Container {
  private readonly uniforms = new UniformGroup({
    uSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uT: { value: 0, type: 'f32' },
    uBend: { value: 0, type: 'f32' },
    uTwist: { value: 0, type: 'f32' },
    uCam: { value: new Float32Array([0.5, 0.5, 4]), type: 'vec3<f32>' },
    uClip: { value: new Float32Array([0, 1]), type: 'vec2<f32>' },
  });
  private readonly shader: Shader;
  readonly mesh: Mesh<Geometry, Shader>;
  readonly shadow: Sprite;
  private w = 1;
  private h = 1;
  look: LeafLook = LEAF_SOFT;
  t = 0;

  constructor() {
    super();
    this.shader = Shader.from({ gl: { vertex: VERT, fragment: FRAG }, resources: { uFront: Texture.WHITE.source, uBack: Texture.WHITE.source, leaf: this.uniforms } });
    this.mesh = new Mesh({ geometry: leafGeometry(48, 10), shader: this.shader });
    this.shadow = new Sprite(shadowTexture());
    this.shadow.visible = false;
    this.addChild(this.shadow, this.mesh);
    this.eventMode = 'none';
  }

  /** The front (the page as it lies right) and the back (seen once turned; drawn mirrored). */
  setFaces(front: Texture, back: Texture): void {
    this.shader.resources.uFront = front.source;
    this.shader.resources.uBack = back.source;
  }

  /** The page size, px of its container. */
  setSize(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }

  /** The phase where the leaf is wholly off screen (portrait). */
  gone(): number {
    return goneAt(this.look.bend, this.look.twist, this.w, this.w / 2, this.w * LEAF_CAM);
  }

  /** Apply the phase `t` (0 lies right … 1 lies left). */
  set(t: number): void {
    this.t = t;
    const u = this.uniforms.uniforms;
    const { bend, twist } = this.look;
    u.uSize[0] = this.w;
    u.uSize[1] = this.h;
    u.uT = t;
    u.uBend = bend;
    u.uTwist = twist;
    u.uCam[0] = this.w / 2;
    u.uCam[1] = this.h / 2;
    u.uCam[2] = this.w * LEAF_CAM;
    u.uClip[0] = 0;
    u.uClip[1] = this.w;
    this.uniforms.update();
    // Shadow: from the spine towards the free edge, a bit beyond the leaf itself.
    const e = profile(1, t, bend);
    const sx = screenX(e, this.w, this.w / 2, this.w * LEAF_CAM);
    const reach = sx + Math.sign(sx || 1) * (0.3 * e.z * this.w + 10);
    const sh = this.shadow;
    sh.visible = t > 0.001 && t < 0.999 && reach > 0; // left of the spine is off the page
    sh.alpha = 0.55 * Math.pow(Math.sin(PI * t), 0.6);
    sh.height = this.h;
    sh.width = Math.min(Math.abs(reach), this.w) + 1;
    sh.scale.x = Math.abs(sh.scale.x) * (reach < 0 ? -1 : 1);
  }
}

let shadowTex: Texture | null = null;
function shadowTexture(): Texture {
  if (shadowTex) return shadowTex;
  if (typeof document === 'undefined') return Texture.WHITE; // headless
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 4;
  const g = c.getContext('2d');
  if (!g) return Texture.WHITE;
  const gr = g.createLinearGradient(0, 0, 64, 0);
  gr.addColorStop(0, 'rgba(0,0,0,.9)');
  gr.addColorStop(0.55, 'rgba(0,0,0,.5)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 4);
  return (shadowTex = Texture.from(c));
}
