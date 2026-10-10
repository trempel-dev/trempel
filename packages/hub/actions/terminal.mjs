// terminal.mjs — a terminal window in the project's folder: TREMPEL_TERMINAL (a command, gets the
// folder as its working directory), else the platform's own.
import { spawn } from 'node:child_process';

export default async (ctx) => {
  const dir = ctx.project.root;
  const custom = process.env.TREMPEL_TERMINAL;
  const [cmd, args] = custom
    ? [custom, []]
    : process.platform === 'darwin'
      ? ['open', ['-a', 'Terminal', dir]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${dir}"`]]
        : [process.env.TERMINAL || 'x-terminal-emulator', []];
  ctx.log(`${cmd} ${args.join(' ')}`.trim());
  await new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd: dir, detached: true, stdio: 'ignore', shell: !!custom });
    c.once('error', rej);
    c.once('spawn', () => {
      c.unref();
      res();
    });
  });
};
