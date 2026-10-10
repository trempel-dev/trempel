// js-runner-types.ts — what a `$js` action's default export receives (js-runner.ts builds it).

import type { Action } from './actions.js';
import type { InputValues, JsContextData } from './engine.js';
import type { RunState } from './runs.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ActionContext {
  project: JsContextData['project'];
  input: InputValues;
  port?: number;
  url?: string;
  services: JsContextData['services'];
  runId: string;
  signal: AbortSignal;
  exec(cmd: string | string[], opts?: { cwd?: string; env?: Record<string, string>; check?: boolean }): Promise<ExecResult>;
  log(...args: unknown[]): void;
  open(target: string): Promise<void>;
  run(actionId: string, input?: Record<string, unknown>): Promise<RunState>;
  actions(): Promise<Action[]>;
}

