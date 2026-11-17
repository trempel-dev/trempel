// clip.ts — an AnimationClip (classID 74) as Unity serializes it in a .anim: every curve as a float
// binding (path, attribute, classID, script) — the vector curves split into their components under
// the attributes Unity's float curves use (m_PositionCurves → m_LocalPosition.x|y|z, m_EulerCurves →
// localEulerAnglesRaw.x|y|z, m_RotationCurves → m_LocalRotation.x|y|z|w, m_ScaleCurves →
// m_LocalScale.x|y|z), the object reference curves (m_PPtrCurves: sprites), the events and the
// settings (m_StartTime / m_StopTime → the length, m_LoopTime → loop). m_EditorCurves are the
// editor's duplicates of the same curves — not read. Times are moved so the clip starts at 0.

import { list, map, num, ref, type Ref, type YamlMap } from '../fx-import/yaml.js';
import { readCurve, type UCurve } from './curve.js';

export interface Binding {
  path: string;
  attribute: string;
  classID: number;
  /** The script GUID of a MonoBehaviour binding (Image, Text, CanvasGroup is native). */
  script?: string;
  curve: UCurve;
}

export interface PBinding {
  path: string;
  attribute: string;
  classID: number;
  script?: string;
  keys: { t: number; ref: Ref | null }[];
}

export interface UEvent {
  t: number;
  name: string;
  data: string;
  float: number;
  int: number;
  object: Ref | null;
}

export interface UClip {
  name: string;
  /** m_StopTime − m_StartTime (seconds). */
  duration: number;
  start: number;
  loop: boolean;
  legacy: boolean;
  wrapMode: number;
  sampleRate: number;
  floats: Binding[];
  pptr: PBinding[];
  events: UEvent[];
  /** What the clip has that is not curves of objects (compressed curves, root motion flags…). */
  notes: string[];
}

const VECTORS: [key: string, attr: string, comps: string[]][] = [
  ['m_PositionCurves', 'm_LocalPosition', ['x', 'y', 'z']],
  ['m_EulerCurves', 'localEulerAnglesRaw', ['x', 'y', 'z']],
  ['m_RotationCurves', 'm_LocalRotation', ['x', 'y', 'z', 'w']],
  ['m_ScaleCurves', 'm_LocalScale', ['x', 'y', 'z']],
];

const pathOf = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Read the clip of an AnimationClip document body. Throws an `E_ANIM_IMPORT_CLIP` on a body that is not a clip. */
export function readClip(body: YamlMap, name?: string): UClip {
  if (!('m_FloatCurves' in body) && !('m_PositionCurves' in body) && !('m_AnimationClipSettings' in body)) {
    throw new Error(`E_ANIM_IMPORT_CLIP: ${name ?? '?'}: not an AnimationClip (no curves, no m_AnimationClipSettings)`);
  }
  const settings = map(body.m_AnimationClipSettings);
  const start = num(settings.m_StartTime);
  const stop = num(settings.m_StopTime);
  const floats: Binding[] = [];
  const notes: string[] = [];
  for (const [key, attr, comps] of VECTORS) {
    for (const raw of list(body[key])) {
      const b = map(raw);
      for (const c of comps) floats.push({ path: pathOf(b.path), attribute: `${attr}.${c}`, classID: 4, curve: shift(readCurve(b.curve, c), start) });
    }
  }
  for (const raw of list(body.m_FloatCurves)) {
    const b = map(raw);
    floats.push({ path: pathOf(b.path), attribute: typeof b.attribute === 'string' ? b.attribute : '', classID: num(b.classID), script: ref(b.script)?.guid, curve: shift(readCurve(b.curve), start) });
  }
  const pptr: PBinding[] = [];
  for (const raw of list(body.m_PPtrCurves)) {
    const b = map(raw);
    const keys = list(b.curve)
      .map((k) => ({ t: num(map(k).time) - start, ref: ref(map(k).value) }))
      .sort((x, y) => x.t - y.t);
    pptr.push({ path: pathOf(b.path), attribute: typeof b.attribute === 'string' ? b.attribute : '', classID: num(b.classID), script: ref(b.script)?.guid, keys });
  }
  const events: UEvent[] = list(body.m_Events).map((raw) => {
    const e = map(raw);
    return {
      t: num(e.time) - start,
      name: typeof e.functionName === 'string' ? e.functionName : '',
      data: typeof e.data === 'string' ? e.data : '',
      float: num(e.floatParameter),
      int: num(e.intParameter),
      object: ref(e.objectReferenceParameter),
    };
  });
  if (list(body.m_CompressedRotationCurves).length) notes.push('m_CompressedRotationCurves: compressed rotation curves are not read');
  if (body.m_Compressed === '1') notes.push('m_Compressed: the clip is stored compressed — only its plain curves are read');
  if (start !== 0) notes.push(`m_StartTime ${start}: times moved to start at 0`);
  const clipName = typeof body.m_Name === 'string' && body.m_Name ? body.m_Name : (name ?? 'clip');
  return {
    name: clipName,
    duration: Math.max(0, stop - start),
    start,
    loop: settings.m_LoopTime === '1',
    legacy: body.m_Legacy === '1',
    wrapMode: num(body.m_WrapMode),
    sampleRate: num(body.m_SampleRate, 60),
    floats,
    pptr,
    events,
    notes,
  };
}

function shift(c: UCurve, start: number): UCurve {
  if (!start) return c;
  return { ...c, keys: c.keys.map((k) => ({ ...k, t: k.t - start })) };
}
