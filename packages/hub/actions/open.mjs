// open.mjs — the project's folder in the system's file manager.
export default async (ctx) => {
  await ctx.open(ctx.project.root);
};
