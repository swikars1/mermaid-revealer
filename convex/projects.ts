import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const listRecent = query({
  args: { deviceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { deviceId, limit }) => {
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .order("desc")
      .take(limit ?? 20);
    return rows.map((p) => ({
      _id: p._id,
      title: p.title,
      thumbnailUrl: p.thumbnailUrl,
      lastOpenedAt: p.lastOpenedAt,
    }));
  },
});

/** Everything the client needs to hydrate the revealer for one project. */
export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (!project) return null;

    const diagrams = await ctx.db
      .query("diagrams")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    diagrams.sort((a, b) => a.order - b.order);

    const source = await ctx.db.get(project.sourceId);

    return {
      _id: project._id,
      title: project.title,
      sourceUrl: source?.canonicalUrl,
      thumbnailUrl: project.thumbnailUrl,
      diagrams: diagrams.map((d) => ({
        _id: d._id,
        order: d.order,
        title: d.title,
        diagramType: d.diagramType,
        revealMode: d.revealMode,
        mermaid: d.mermaid,
        narration: d.narration,
        summary: d.summary,
      })),
    };
  },
});

export const touch = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const p = await ctx.db.get(projectId);
    if (p) await ctx.db.patch(projectId, { lastOpenedAt: Date.now() });
  },
});

export const rename = mutation({
  args: { projectId: v.id("projects"), title: v.string() },
  handler: async (ctx, { projectId, title }) => {
    await ctx.db.patch(projectId, { title: title.slice(0, 200) });
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const diagrams = await ctx.db
      .query("diagrams")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const d of diagrams) await ctx.db.delete(d._id);
    await ctx.db.delete(projectId);
  },
});
