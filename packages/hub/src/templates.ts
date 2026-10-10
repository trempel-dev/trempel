// templates.ts — a new project from a template: the hub ships the monorepo's templates
// (`templates/<name>/`, copied at build with the engine versions of this release), a new project
// is a copy with its own name, `git init` and a first commit.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { HubError } from './engine.js';
import { HUB_PACKAGE } from './layers.js';

export interface TemplateInfo {
  name: string;
  description: string;
  dir: string;
}

export const templatesDir = (): string => process.env.TREMPEL_HUB_TEMPLATES ?? join(HUB_PACKAGE, 'templates');

export function listTemplates(): TemplateInfo[] {
  const dir = templatesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json')))
    .map((e) => {
      const pj = JSON.parse(readFileSync(join(dir, e.name, 'package.json'), 'utf8')) as { description?: string };
      return { name: e.name, description: pj.description ?? '', dir: join(dir, e.name) };
    });
}

const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export interface NewProjectOptions {
  template: string;
  dest: string;
  /** The package name (default — the folder's name). */
  name?: string;
  /** Run `npm install` after the copy. */
  install?: boolean;
  log?: (line: string) => void;
}

/** Copy a template, name it, `git init` + the first commit. @throws HubError */
export function createProject(opts: NewProjectOptions): string {
  const log = opts.log ?? (() => {});
  const tpl = listTemplates().find((t) => t.name === opts.template);
  if (!tpl) throw new HubError(`E_HUB_TEMPLATE: no template "${opts.template}" (${listTemplates().map((t) => t.name).join(', ') || 'none — build the hub'}).`, 2);
  const dest = resolve(opts.dest);
  if (existsSync(dest) && readdirSync(dest).length) throw new HubError(`E_HUB_NEW: ${dest} exists and is not empty.`, 2);
  const name = opts.name ?? basename(dest).toLowerCase().replace(/[^a-z0-9-._~]+/g, '-');
  if (!NAME.test(name)) throw new HubError(`E_HUB_NEW: "${name}" is not a package name.`, 2);
  cpSync(tpl.dir, dest, { recursive: true });
  const pjFile = join(dest, 'package.json');
  const pj = JSON.parse(readFileSync(pjFile, 'utf8')) as Record<string, unknown>;
  pj.name = name;
  pj.version = '0.1.0';
  writeFileSync(pjFile, JSON.stringify(pj, null, 2) + '\n');
  log(`copied ${tpl.name} → ${dest}`);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dest, stdio: 'pipe' });
  };
  try {
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', `New project from the ${tpl.name} template`);
    log('git: initialised, first commit');
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    throw new HubError(`E_HUB_GIT: ${dest}: ${err.stderr?.toString().trim() || err.message}`, 1);
  }
  if (opts.install) {
    log('npm install …');
    execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: dest, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  return dest;
}
