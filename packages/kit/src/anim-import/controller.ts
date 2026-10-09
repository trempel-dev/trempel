// controller.ts — an AnimatorController (.controller, classID 91) read for its states: every layer's
// state machine (sub-state machines included) → states (AnimatorState 1102: name, speed, motion — a
// clip in a .anim by GUID, a clip stored in the controller itself, a BlendTree, a clip of a model
// file), the default state, and the transitions (AnimatorStateTransition 1101 / AnimatorTransition
// 1109) as text for the report: the importer never runs them. An AnimatorOverrideController
// (classID 221) is its base controller with clips swapped.

import type { UnityDoc } from '../fx-import/yaml.js';
import { list, map, num, ref, type Ref } from '../fx-import/yaml.js';

export interface UState {
  name: string;
  layer: string;
  speed: number;
  /** The motion: a clip reference (guid absent — a document of the controller's file), or null. */
  motion: Ref | null;
  isDefault: boolean;
}

export interface UController {
  name: string;
  states: UState[];
  /** 'Idle → Run: if Speed > 0.1; exit time 0.9; duration 0.25 s' … */
  transitions: string[];
  parameters: string[];
  layers: string[];
  /** Override controllers: the base controller's GUID and the clip swaps (original → override). */
  base?: Ref | null;
  overrides?: { original: Ref | null; override: Ref | null }[];
}

const MODES: Record<string, string> = { '1': 'if', '2': 'if not', '3': '>', '4': '<', '6': '==', '7': '!=' };

/** The controller of a .controller / .overrideController file's documents. Throws `E_ANIM_IMPORT_CONTROLLER` when there is none. */
export function readController(docs: UnityDoc[], file: string): UController {
  const byId = new Map(docs.map((d) => [d.fileID, d]));
  const over = docs.find((d) => d.classId === 221);
  if (over) {
    return {
      name: str(over.body.m_Name) || file,
      states: [],
      transitions: [],
      parameters: [],
      layers: [],
      base: ref(over.body.m_Controller),
      overrides: list(over.body.m_Clips).map((c) => ({ original: ref(map(c).m_OriginalClip), override: ref(map(c).m_OverrideClip) })),
    };
  }
  const ctl = docs.find((d) => d.classId === 91);
  if (!ctl) throw new Error(`E_ANIM_IMPORT_CONTROLLER: ${file}: no AnimatorController in the file`);
  const states: UState[] = [];
  const transitions: string[] = [];
  const stateName = (r: Ref | null): string => (r ? str(byId.get(r.fileID)?.body.m_Name) || `#${r.fileID}` : '');
  const describe = (from: string, id: string): void => {
    const t = byId.get(id);
    if (!t) return;
    const b = t.body;
    const dst = ref(b.m_DstState);
    const dstSm = ref(b.m_DstStateMachine);
    const to = b.m_IsExit === '1' ? 'Exit' : dst ? stateName(dst) : dstSm ? `${stateName(dstSm)} (state machine)` : '?';
    const conds = list(b.m_Conditions).map((c) => {
      const m = map(c);
      const mode = MODES[str(m.m_ConditionMode)] ?? `mode ${str(m.m_ConditionMode)}`;
      const p = str(m.m_ConditionEvent);
      return mode === 'if' || mode === 'if not' ? `${mode} ${p}` : `${p} ${mode} ${num(m.m_EventTreshold)}`;
    });
    const parts = [conds.length ? conds.join(' and ') : 'no condition'];
    if (b.m_HasExitTime === '1') parts.push(`exit time ${num(b.m_ExitTime)}`);
    if (b.m_TransitionDuration !== undefined && num(b.m_TransitionDuration) > 0) parts.push(`blend ${num(b.m_TransitionDuration)}${b.m_HasFixedDuration === '0' ? ' (normalized)' : ' s'}`);
    if (b.m_Solo === '1') parts.push('solo');
    if (b.m_Mute === '1') parts.push('muted');
    transitions.push(`${from} → ${to}: ${parts.join('; ')}`);
  };
  const layers: string[] = [];
  const walk = (smId: string, layer: string, seen: Set<string>): void => {
    if (seen.has(smId)) return;
    seen.add(smId);
    const sm = byId.get(smId);
    if (!sm) return;
    const def = ref(sm.body.m_DefaultState)?.fileID;
    for (const cs of list(sm.body.m_ChildStates)) {
      const sr = ref(map(cs).m_State);
      const s = sr && byId.get(sr.fileID);
      if (!s) continue;
      const name = str(s.body.m_Name);
      states.push({ name, layer, speed: num(s.body.m_Speed, 1), motion: ref(s.body.m_Motion), isDefault: sr.fileID === def });
      for (const tr of list(s.body.m_Transitions)) {
        const r = ref(tr);
        if (r) describe(name, r.fileID);
      }
    }
    for (const tr of list(sm.body.m_AnyStateTransitions)) {
      const r = ref(tr);
      if (r) describe('Any State', r.fileID);
    }
    for (const tr of list(sm.body.m_EntryTransitions)) {
      const r = ref(tr);
      if (r) describe('Entry', r.fileID);
    }
    for (const c of list(sm.body.m_ChildStateMachines)) {
      const r = ref(map(c).m_StateMachine);
      if (r) walk(r.fileID, layer, seen);
    }
  };
  for (const l of list(ctl.body.m_AnimatorLayers)) {
    const lm = map(l);
    const name = str(lm.m_Name) || `layer ${layers.length}`;
    layers.push(name);
    const sm = ref(lm.m_StateMachine);
    if (sm) walk(sm.fileID, name, new Set());
  }
  const parameters = list(ctl.body.m_AnimatorParameters).map((p) => str(map(p).m_Name));
  return { name: str(ctl.body.m_Name) || file, states, transitions, parameters, layers };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
