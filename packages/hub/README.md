# @trempel/hub

One control panel per machine for Trempel projects (like Unity Hub or Cocos Dashboard): it finds
the projects, shows their engine versions and git state, runs their **actions** and keeps track of
long-running services (ports, URLs, logs, stop by process tree). A local web page and the
`trempel` CLI over the same engine: an agent or a pipeline calls exactly what a person presses.

```bash
npm i -g @trempel/hub        # or npx @trempel/hub …
trempel hub                  # the page (http://localhost:5170/)
trempel run dev              # the project's dev server on a free port; prints the URL
trempel run --list           # the project's actions by layer
```

The hub doesn't depend on the engine's version. Anything that does (the dev server, builds, gates,
the editor) comes from the project's `node_modules/@trempel/kit/hub/actions.mdz` — an old project
gets the actions of its own kit.

## Actions

Everything is an action — the built-in buttons too. Actions live in mdz files under one
`## actions` heading, one `### <id>` heading each, fields as `$field: value` lines (the md of
`@trempel/scene`):

```md
## actions

### levels
$title: Generate levels
$icon: sparkles
$group: content
$input.world: { type: "select", options: [1, 2, 3, 4, 5, 6, 7] }
$input.count: { type: "text", default: 5 }
$shell: node tools/gen-levels.js --world ${input.world} --count ${input.count}
$confirm: Spends API credits

### agent-port
$title: Agent: port by the skill
$icon: robot
$group: agents
$kind: service
$input.task: text
$js: tools/hub/agent.js
```

| field | what |
|---|---|
| `### <id>` | unique in the project; a higher layer replaces an action with the same id |
| `$title`, `$icon` | the button's text; an icon name or a path to an svg/png |
| `$group` | the section on the project page (`run`, `build`, `gates`, `content`, `agents`, …); the last results of `gates` show on the project's card |
| `$pin: true` | a quick button on the project's card |
| `$shell` | a command, or a list `$[npm ci, npm test]` (in order; the first failure stops). A fenced ` ```sh ` block in the action's text is the same as a list of its lines |
| `$js` | a module (from the project root, or the declaring file's folder for the other layers): `export default async (ctx) => …` |
| `$kind` | `once` (default) or `service` — long-running: a port, a URL once it answers, Stop |
| `$input.<name>` | a field asked before the run: `text`, `select` (`options`), `file`, `bool`; `{ type, default, options, label, required }` or just the type |
| `$confirm` | the text of a confirmation (the CLI wants `--yes` off a terminal) |
| `$port` | a service's port: `auto` (default — a free one) or a number |
| `$url` | the service's URL (default `http://localhost:${port}/`) |
| `$when` | conditions, all must hold (a list or one): `git`, `git.dirty`, `git.upstream`, `git.ahead`, `git.behind`, `file:<path>`, `dep:<package>`, `script:<npm script>`, `running:<service id>`, `platform:<darwin\|linux\|win32>`; `!` negates |
| `$cwd`, `$env` | the working folder from the project root; `{ NAME: "value" }` |

Text under the heading is the action's description. Broken actions are left out with an
`E_HUB_ACTION: <file>:<line>` line (`trempel run --list` prints them); the rest stay.

### `${…}`

`${input.<name>}`, `${port}`, `${url}`, `${project.root|name|kit|scene}`, `${pkg:<package>}` (the
package's folder as the project resolves it), `${services.<id>.port|url}` (a running service of the
project), `${env.<NAME>}`, `${here}` (the declaring file's folder). In a shell command the values
are quoted for the shell — an input can't add a command. Any other `${…}` (`${HOME}`) is left to the
shell.

### ctx of a js action

```js
export default async (ctx) => {
  ctx.project;                       // { root, name, kit, scene, id }
  ctx.input;                         // typed, defaults applied
  ctx.port; ctx.url;                 // a service's
  await ctx.exec('npm test');        // → { code, stdout, stderr }; output into the log; non-zero throws unless { check: false }
  ctx.log('…');
  await ctx.open('http://…');        // the system opener (TREMPEL_HUB_OPEN replaces it)
  const r = await ctx.run('test', { … });   // another action: a once one is waited for, a service — until it answers
  await ctx.actions();               // the project's actions shown now
  ctx.signal;                        // aborted when the run is stopped
  return 0;                          // optional: the exit code
};
```

A js action runs in its own Node process under the run's supervisor (in the run's process group).
A `once` action it runs joins that group; a service it starts stops when it ends.

## Layers (bottom up)

1. **hub** — this package's `actions.mdz`: open folder, open in IDE (`TREMPEL_IDE`, default `code`),
   terminal here (`TREMPEL_TERMINAL`), git status / pull / commit (`message` input), `kit:update`.
2. **user** — `~/.trempel/actions.mdz`: for every project (e.g. "an agent here").
3. **kit** — `node_modules/@trempel/kit/hub/actions.mdz` of the project's kit: `dev` (service, auto
   port), `build:web`, `build:yt` (+ the Playables gates), `test`, `e2e`, `editor` (the scene editor
   of that version; while it runs — `editor:eval` / `editor:save` / `editor:state` / `editor:mcp`
   through its agent bridge `trempel-edit`), `view:shot`. A kit older than 2.4 has no such file: the
   hub's `legacy-kit.mdz` stands in over the project's npm scripts.
4. **project** — `## actions` of `.trempel/project.mdz` and/or `.trempel/actions.mdz` (the latter
   wins on a repeated id): the project's pipelines, and overrides of anything below.

## Runs and services

Every run is a folder `~/.trempel/hub/runs/<id>/` (`meta.json`, `log.txt`, `ready.json`,
`exit.json`) and a supervisor process that leads its own process group. Services outlive the hub
and the CLI that started them; the hub and `trempel ps` read them back. Stop signals the run's
process group and every descendant (also one that left the group), SIGTERM then SIGKILL — never a
process by name. The newest 300 finished runs are kept.

## CLI

```
trempel hub [--port 5170] [--host 127.0.0.1] [--no-open] [--root <dir>]…
trempel run <action> [--project <dir>] [--input k=v]… [--detach] [--yes] [--force]
trempel run --list [--project <dir>] [--json]
trempel ps [--json]  |  stop <run id | action>  |  log <run id> [--follow]
trempel projects [--json]  |  add <dir>  |  remove <dir>  |  roots [<dir>…]
trempel new <template> <dir> [--name n] [--install]  |  templates
```

`--project` defaults to the nearest project from the current folder up. `run` in the foreground
streams the log (a service prints `[hub] ready: <url>`; Ctrl+C stops its tree) and exits with the
action's code; `--detach` prints a service's URL (or the run id) and leaves it running. `stop <action>`
outside any project (and without `--project`) stops the action in the one project that runs it; when
several do, it stops nothing and lists their run ids (`E_HUB_AMBIGUOUS`). Exit codes:
2 — usage (a missing input, an unknown action, a confirmation without `--yes`, an ambiguous stop),
3 — already running.

## Projects

Found under the roots (default: `Studio/Projects` in the home folder; `trempel roots`,
`TREMPEL_HUB_ROOTS`, Settings on the page; two levels deep) — a folder is a project when it depends
on `@trempel/kit` or `@trempel/scene` or has `.trempel/project.mdz` — plus the ones added by hand.
A card: name (a name two projects share — a game and its live copy — gets the folder:
`name · folder`), kit and scene versions (installed, else declared), git (branch, clean/dirty,
ahead/behind), the last results of the `gates` actions, the pinned actions, running services.

**A new project** — `trempel new casual ~/games/my-game` (or the page): a template shipped with this
release of the hub (`casual`, `slot`) with the engine of this release, `git init` and a first commit.
**Update the kit** — the `kit:update` action: raises `@trempel/kit` (and `@trempel/scene` to the
range that kit needs), runs every gate of the new kit, prints the result; roll back with git.

## The page

`trempel hub` — projects, a project's actions by group (with their layer; what is off or overridden
— folded), the runs with logs and exit codes, all running services (URL, uptime, Stop, log), a new
project, roots. It answers on 127.0.0.1 only; requests that change something need the
`X-Trempel-Hub: 1` header and a local Host.

## Files

`TREMPEL_HOME` (default `~/.trempel`) — `actions.mdz` (the user's layer), `hub/config.json` (roots,
projects added by hand, `depth`), `hub/runs/`.
