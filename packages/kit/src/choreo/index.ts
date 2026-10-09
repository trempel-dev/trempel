// choreo/ — choreography as data (2.2): named steps over different objects with formula times, row
// references, instances, speed modes, skip rules and nested sequences (model.ts), played by the
// Director on the game loop's logical time (director.ts) with the kit's actions (actions.ts) and the
// game's own, logged, and verified against a reference timeline (verify.ts).

export { compile, evaluate, evalNum, scopeOf, type Value, type Scope } from './expr.js';
export { loadChoreo, parseValue, tableOf, COLUMNS, KIT_EASES, MODES, type Choreo, type Sequence, type Row, type SpeedMode, type Sync, type ValueItem, type EachSpec, type SkipRule, type LoadOptions } from './model.js';
export { Director, type Action, type ChoreoEvent, type DirectorOptions, type EventKind, type EventProp, type RowCtl, type RunOptions, type Sink } from './director.js';
export { kitActions, type KitActionDeps } from './actions.js';
export {
  verifyLog,
  verifyLive,
  formatFindings,
  locate,
  stepTicks,
  tickGrid,
  isLiveRef,
  FRAME_KINDS,
  type VerifyOptions,
  type VerifyResult,
  type Finding,
  type TimelineDoc,
  type TimelineSeq,
  type TimelineStep,
  type LiveDoc,
  type LiveProbe,
  type LiveStats,
  type LiveSample,
  type LiveMeasure,
  type LiveMapping,
  type LiveRow,
  type LiveFinding,
} from './verify.js';
