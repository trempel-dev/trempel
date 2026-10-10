// layers.ts — the actions of a project, gathered from four layers (bottom up): the hub's
// (`actions.mdz` of this package), the user's (`~/.trempel/actions.mdz`), the project's kit version
// (`node_modules/@trempel/kit/hub/actions.mdz`; a kit older than that — `legacy-kit.mdz` of the hub,
// over the project's npm scripts), the project's (`## actions` of `.trempel/project.mdz`,
// `.trempel/actions.mdz`). A higher layer replaces an action with the same id.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseActions, type Action, type Layer } from './actions.js';
import { userActionsFile } from './home.js';
import { PROJECT_FILE, type ProjectInfo } from './project.js';

/** This package's folder (the hub layer, the legacy kit layer, templates, the page). */
export const HUB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface LayerSource {
  layer: Layer;
  file: string;
  /** The hub's stand-in for a kit without `hub/actions.mdz`. */
  legacy?: boolean;
}

export interface ResolvedActions {
  /** id → the action that wins. */
  actions: Map<string, Action>;
  /** Every declared action, in layer order (what `trempel run --list` shows). */
  all: Action[];
  sources: LayerSource[];
  errors: string[];
}

/** The files of each layer that exist for this project. */
export function layerSources(project: Pick<ProjectInfo, 'root' | 'kitDir'>): LayerSource[] {
  const out: LayerSource[] = [{ layer: 'hub', file: join(HUB_PACKAGE, 'actions.mdz') }];
  const user = userActionsFile();
  if (existsSync(user)) out.push({ layer: 'user', file: user });
  const kitFile = project.kitDir ? join(project.kitDir, 'hub', 'actions.mdz') : null;
  if (kitFile && existsSync(kitFile)) out.push({ layer: 'kit', file: kitFile });
  else out.push({ layer: 'kit', file: join(HUB_PACKAGE, 'legacy-kit.mdz'), legacy: true });
  const pf = join(project.root, PROJECT_FILE);
  if (existsSync(pf)) out.push({ layer: 'project', file: pf });
  const af = join(project.root, '.trempel', 'actions.mdz');
  if (existsSync(af)) out.push({ layer: 'project', file: af });
  return out;
}

export function resolveActions(project: Pick<ProjectInfo, 'root' | 'kitDir'>): ResolvedActions {
  const sources = layerSources(project);
  const out: ResolvedActions = { actions: new Map(), all: [], sources, errors: [] };
  const projectIds = new Map<string, string>();
  for (const s of sources) {
    let src: string;
    try {
      src = readFileSync(s.file, 'utf8');
    } catch (e) {
      out.errors.push(`E_HUB_ACTION: ${s.file}: ${(e as Error).message}`);
      continue;
    }
    const base = s.layer === 'project' ? project.root : dirname(s.file);
    const parsed = parseActions(src, { layer: s.layer, source: s.file, base });
    out.errors.push(...parsed.errors);
    for (const a of parsed.actions) {
      if (s.layer === 'project') {
        const prev = projectIds.get(a.id);
        if (prev) out.errors.push(`E_HUB_ACTION: ${s.file}: the action "${a.id}" is also declared in ${prev} — this one wins.`);
        projectIds.set(a.id, s.file);
      }
      out.all.push(a);
      out.actions.set(a.id, a);
    }
  }
  return out;
}
