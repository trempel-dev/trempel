# Changelog — @trempel/hub

## 2.4.0

The first release (versions follow the kit's).

- **Actions in mdz** — `## actions` / `### <id>` / `$field: value`: shell (one command, a list, a
  ```sh block) or a js module with `ctx` (`exec`, `log`, `open`, `run`, `actions`, `signal`), `once` or
  `service` (auto port, URL once it answers), inputs (`text`, `select`, `file`, `bool`), `confirm`,
  `when` (`git`, `git.dirty`, `file:`, `dep:`, `script:`, `running:`, `platform:`), `${…}` quoted for
  the shell.
- **Four layers** — the hub's, the user's (`~/.trempel/actions.mdz`), the project's kit version
  (`@trempel/kit/hub/actions.mdz`; an older kit — `legacy-kit.mdz` over the npm scripts), the
  project's (`.trempel/project.mdz`, `.trempel/actions.mdz`); override by id.
- **Runs** — a supervisor per run in its own process group, the log, the exit, `ready` of a service
  on disk (`~/.trempel/hub/runs/`): services outlive the hub; stop by process group and descendants.
- **`trempel`** — `hub`, `run` (+ `--list`, `--detach`, `--input`, `--yes`), `ps`, `stop`, `log`,
  `projects`, `add`/`remove`, `roots`, `new`, `templates`.
- **The page** — projects (versions, git, gates, pins, services), a project's actions and runs with
  logs, processes, a new project from a template (git init + a first commit), roots.
