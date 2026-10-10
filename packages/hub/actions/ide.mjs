// ide.mjs — the project in an IDE: TREMPEL_IDE (a command; default `code`) with the folder.
export default async (ctx) => {
  const ide = process.env.TREMPEL_IDE || 'code';
  ctx.log(`${ide} ${ctx.project.root}`);
  await ctx.exec([ide, ctx.project.root]);
};
