import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  extractVideoId,
  canonicalUrl,
  fetchYouTubeTranscript,
  preprocessTranscript,
  TranscriptError,
} from "./lib/youtube";
import { getProvider, LlmError } from "./lib/llm";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  OUTPUT_SCHEMA,
  buildUserPrompt,
  type GenerationOutput,
} from "./lib/prompt";
import { validateAndRepair, forcedRevealMode } from "./lib/validate";

/** Anonymous abuse ceiling until auth + credits land. */
const DAILY_LIMIT = Number(process.env.DAILY_GENERATION_LIMIT ?? 5);

/** Convex documents cap at 1MB; Gemini free tier has its own ceilings. */
const MAX_TRANSCRIPT_CHARS = 120_000;

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* =========================================================
   Public API
========================================================= */

/**
 * Returns as soon as there is a `generationId` to subscribe to. The pipeline
 * itself runs on the scheduler, so the client can watch `status` update stage
 * by stage. (Doing the work inline here would mean the action only resolved
 * once everything was finished — and the progress trace would never stream.)
 */
export const submit = action({
  args: {
    url: v.string(),
    deviceId: v.string(),
    force: v.optional(v.boolean()),
    /** Escape hatch when YouTube blocks us. Skips fetching entirely. */
    transcript: v.optional(v.string()),
  },
  handler: async (ctx, { url, deviceId, force, transcript }) => {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error("That doesn't look like a YouTube URL.");
    }

    // Fail fast on a missing/invalid API key rather than inside the job.
    const providerCheck = getProvider();

    // 1. Upsert the shared source row -------------------------------
    const sourceId: Id<"sources"> = await ctx.runMutation(
      internal.generate.upsertSource,
      { videoId, url: canonicalUrl(videoId) },
    );

    // 2. Cache probe on whatever transcript we already have ----------
    // A second probe happens after fetching, because the real transcript hash
    // is what the key is actually built from.
    const existingTranscript = await ctx.runQuery(internal.generate.getTranscript, {
      sourceId,
    });

    const provider = providerCheck;

    if (existingTranscript && !force) {
      const key = await sha256(
        [videoId, existingTranscript.contentHash, PROMPT_VERSION, provider.name, provider.model, "en"].join("|"),
      );
      const hit = await ctx.runQuery(internal.generate.getByCacheKey, { cacheKey: key });
      if (hit && hit.status === "complete") {
        const projectId = await ctx.runMutation(internal.generate.forkProject, {
          deviceId,
          generationId: hit._id,
        });
        return { generationId: hit._id, projectId, cached: true };
      }
      if (hit && (hit.status === "queued" || hit.status === "generating" || hit.status === "transcribing")) {
        // In-flight dedup: join the running job instead of starting a second.
        return { generationId: hit._id, projectId: null, cached: false };
      }
    }

    // 3. Rate limit (only for work we're actually going to pay for) --
    const allowed = await ctx.runMutation(internal.generate.consumeQuota, {
      deviceId,
      day: today(),
      limit: DAILY_LIMIT,
    });
    if (!allowed) {
      throw new Error(
        `You've hit the free limit of ${DAILY_LIMIT} new videos per day. Already-mapped videos are still unlimited.`,
      );
    }

    // 4. Create the generation row so the client can subscribe now ---
    const provisionalKey = await sha256(
      [videoId, "pending", PROMPT_VERSION, provider.name, provider.model, "en", force ? Date.now() : ""].join("|"),
    );
    const generationId: Id<"generations"> = await ctx.runMutation(
      internal.generate.createGeneration,
      {
        cacheKey: provisionalKey,
        sourceId,
        provider: provider.name,
        model: provider.model,
        promptVersion: PROMPT_VERSION,
      },
    );

    // 5. Hand the work to the scheduler and return now. The client subscribes
    //    to `status` with this id and watches the stages arrive.
    await ctx.scheduler.runAfter(0, internal.generate.runGeneration, {
      generationId,
      sourceId,
      videoId,
      deviceId,
      force: !!force,
      manualTranscript: transcript,
    });

    return { generationId, projectId: null, cached: false };
  },
});

/** The actual pipeline. Runs detached; all progress goes through the db. */
export const runGeneration = internalAction({
  args: {
    generationId: v.id("generations"),
    sourceId: v.id("sources"),
    videoId: v.string(),
    deviceId: v.string(),
    force: v.boolean(),
    manualTranscript: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const started = Date.now();
    try {
      const existingTranscript = await ctx.runQuery(internal.generate.getTranscript, {
        sourceId: args.sourceId,
      });
      await runPipeline(ctx, { ...args, started, existingTranscript });
      // Fork the private project only once the shared generation is complete.
      await ctx.runMutation(internal.generate.forkProject, {
        deviceId: args.deviceId,
        generationId: args.generationId,
      });
    } catch (e) {
      const code =
        e instanceof TranscriptError || e instanceof LlmError ? e.code : "UNKNOWN";
      const message = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.generate.failGeneration, {
        generationId: args.generationId,
        failureCode: code,
        failureMessage: message,
      });
      // They got nothing, so give the quota back.
      await ctx.runMutation(internal.generate.refundQuota, {
        deviceId: args.deviceId,
        day: today(),
      });
    }
  },
});

async function runPipeline(
  ctx: any,
  args: {
    generationId: Id<"generations">;
    sourceId: Id<"sources">;
    videoId: string;
    deviceId: string;
    force: boolean;
    started: number;
    manualTranscript?: string;
    existingTranscript: { _id: Id<"transcripts">; text: string; contentHash: string } | null;
  },
) {
  const { generationId, sourceId, videoId, started } = args;

  // ---- Stage 1: transcript ----------------------------------------
  let transcriptId: Id<"transcripts">;
  let transcriptText: string;
  let contentHash: string;
  let meta: { title: string; author?: string; durationSec?: number; language: string };

  if (args.manualTranscript?.trim()) {
    // The always-works path. Nothing to block, nothing to rate-limit.
    await ctx.runMutation(internal.generate.setStage, {
      generationId,
      status: "generating",
      stage: "Using the transcript you pasted…",
    });

    const cleaned = preprocessTranscript(args.manualTranscript).slice(
      0,
      MAX_TRANSCRIPT_CHARS,
    );
    if (cleaned.split(/\s+/).filter(Boolean).length < 120) {
      throw new TranscriptError(
        "TRANSCRIPT_TOO_SHORT",
        "That transcript is too short to build diagrams from.",
      );
    }
    contentHash = await sha256(cleaned);
    transcriptId = await ctx.runMutation(internal.generate.saveTranscript, {
      sourceId,
      language: "en",
      text: cleaned,
      contentHash,
      isAutoGenerated: false,
      provider: "user_supplied",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    });
    transcriptText = cleaned;
    const src = await ctx.runQuery(internal.generate.getSource, { sourceId });
    meta = {
      title: src?.title ?? `YouTube ${videoId}`,
      author: src?.author,
      durationSec: src?.durationSec,
      language: "en",
    };
  } else if (args.existingTranscript) {
    await ctx.runMutation(internal.generate.setStage, {
      generationId,
      status: "generating",
      stage: "Using cached transcript…",
    });
    transcriptId = args.existingTranscript._id;
    transcriptText = args.existingTranscript.text;
    contentHash = args.existingTranscript.contentHash;
    const src = await ctx.runQuery(internal.generate.getSource, { sourceId });
    meta = {
      title: src?.title ?? `YouTube ${videoId}`,
      author: src?.author,
      durationSec: src?.durationSec,
      language: "en",
    };
  } else {
    await ctx.runMutation(internal.generate.setStage, {
      generationId,
      status: "transcribing",
      stage: "Fetching the transcript from YouTube…",
    });

    const fetched = await fetchYouTubeTranscript(videoId);
    const cleaned = preprocessTranscript(fetched.text).slice(0, MAX_TRANSCRIPT_CHARS);
    contentHash = await sha256(cleaned);

    transcriptId = await ctx.runMutation(internal.generate.saveTranscript, {
      sourceId,
      language: fetched.language,
      text: cleaned,
      contentHash,
      isAutoGenerated: fetched.isAutoGenerated,
      provider: fetched.provider,
      title: fetched.title,
      author: fetched.author,
      durationSec: fetched.durationSec,
      thumbnailUrl: fetched.thumbnailUrl,
    });
    transcriptText = cleaned;
    meta = {
      title: fetched.title ?? `YouTube ${videoId}`,
      author: fetched.author,
      durationSec: fetched.durationSec,
      language: fetched.language,
    };
  }

  // ---- Stage 2: real cache key, second probe -----------------------
  const provider = getProvider();
  const cacheKey = await sha256(
    [videoId, contentHash, PROMPT_VERSION, provider.name, provider.model, "en"].join("|"),
  );

  if (!args.force) {
    const hit = await ctx.runQuery(internal.generate.getByCacheKey, { cacheKey });
    if (hit && hit.status === "complete" && hit._id !== generationId) {
      await ctx.runMutation(internal.generate.adoptCached, {
        generationId,
        cachedId: hit._id,
      });
      await ctx.runMutation(internal.generate.refundQuota, {
        deviceId: args.deviceId,
        day: today(),
      });
      return;
    }
  }

  // ---- Stage 3: generate -------------------------------------------
  const wordCount = transcriptText.split(/\s+/).length;
  await ctx.runMutation(internal.generate.setStage, {
    generationId,
    status: "generating",
    stage: `Read ${wordCount.toLocaleString()} words. Designing diagrams…`,
    cacheKey,
    transcriptId,
  });

  const { data, usage } = await provider.generateJson<GenerationOutput>({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({
      title: meta.title,
      author: meta.author,
      durationSec: meta.durationSec,
      transcript: transcriptText,
      language: "English",
    }),
    schema: OUTPUT_SCHEMA as any,
  });

  if (!data?.diagrams?.length) {
    throw new Error("The model didn't return any diagrams. Try regenerating.");
  }

  // ---- Stage 4: validate + repair ----------------------------------
  await ctx.runMutation(internal.generate.setStage, {
    generationId,
    status: "validating",
    stage: `Checking ${data.diagrams.length} diagrams…`,
  });

  const finalDiagrams = [];
  for (let i = 0; i < data.diagrams.length; i++) {
    const d = data.diagrams[i];
    const result = validateAndRepair(d.mermaid, d.narration ?? []);
    const revealMode = forcedRevealMode(
      d.diagramType ?? "flowchart",
      result.stepCount > 1 ? (d.revealMode ?? "steps") : "atomic",
    );

    // Fail soft: a broken diagram is dropped, the rest of the set still ships.
    if (!result.ok && result.stepCount < 3) continue;

    finalDiagrams.push({
      index: finalDiagrams.length,
      title: d.title ?? `Diagram ${i + 1}`,
      diagramType: d.diagramType ?? "flowchart",
      revealMode,
      mermaid: result.mermaid,
      narration: result.narration,
      summary: d.summary,
      validated: result.ok,
      repairs: result.repairs,
    });
  }

  if (!finalDiagrams.length) {
    throw new Error("Every generated diagram failed validation. Try regenerating.");
  }

  await ctx.runMutation(internal.generate.completeGeneration, {
    generationId,
    cacheKey,
    transcriptId,
    projectTitle: data.projectTitle ?? meta.title,
    diagrams: finalDiagrams,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs: Date.now() - started,
  });
}

/* =========================================================
   Reactive status — this is what makes progress feel alive
========================================================= */

export const status = query({
  args: { generationId: v.id("generations"), deviceId: v.string() },
  handler: async (ctx, { generationId, deviceId }) => {
    const g = await ctx.db.get(generationId);
    if (!g) return null;

    // Surfaced only once the fork exists, so the client can wait on one
    // subscription instead of polling for the project separately.
    let projectId: Id<"projects"> | null = null;
    if (g.status === "complete") {
      const p = await ctx.db
        .query("projects")
        .withIndex("by_device_generation", (q) =>
          q.eq("deviceId", deviceId).eq("generationId", generationId),
        )
        .first();
      projectId = p?._id ?? null;
    }

    return {
      status: g.status,
      stage: g.stage,
      failureCode: g.failureCode,
      failureMessage: g.failureMessage,
      diagramCount: g.diagrams?.length ?? 0,
      durationMs: g.durationMs,
      projectId,
    };
  },
});

/* =========================================================
   Internal
========================================================= */

export const upsertSource = internalMutation({
  args: { videoId: v.string(), url: v.string() },
  handler: async (ctx, { videoId, url }) => {
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_external", (q) => q.eq("kind", "youtube").eq("externalId", videoId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        requestCount: existing.requestCount + 1,
        lastRequestedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("sources", {
      kind: "youtube",
      externalId: videoId,
      canonicalUrl: url,
      title: `YouTube ${videoId}`,
      requestCount: 1,
      lastRequestedAt: now,
      createdAt: now,
    });
  },
});

export const getSource = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: (ctx, { sourceId }) => ctx.db.get(sourceId),
});

export const getTranscript = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const t = await ctx.db
      .query("transcripts")
      .withIndex("by_source_lang", (q) => q.eq("sourceId", sourceId).eq("language", "en"))
      .first();
    if (t) return { _id: t._id, text: t.text, contentHash: t.contentHash };
    const any = await ctx.db
      .query("transcripts")
      .withIndex("by_source_lang", (q) => q.eq("sourceId", sourceId))
      .first();
    return any ? { _id: any._id, text: any.text, contentHash: any.contentHash } : null;
  },
});

export const saveTranscript = internalMutation({
  args: {
    sourceId: v.id("sources"),
    language: v.string(),
    text: v.string(),
    contentHash: v.string(),
    isAutoGenerated: v.boolean(),
    provider: v.string(),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    thumbnailUrl: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.sourceId, {
      ...(a.title ? { title: a.title } : {}),
      ...(a.author ? { author: a.author } : {}),
      ...(a.durationSec ? { durationSec: a.durationSec } : {}),
      ...(a.thumbnailUrl ? { thumbnailUrl: a.thumbnailUrl } : {}),
    });
    return await ctx.db.insert("transcripts", {
      sourceId: a.sourceId,
      language: a.language,
      text: a.text,
      contentHash: a.contentHash,
      charCount: a.text.length,
      isAutoGenerated: a.isAutoGenerated,
      provider: a.provider,
      createdAt: Date.now(),
    });
  },
});

export const getByCacheKey = internalQuery({
  args: { cacheKey: v.string() },
  handler: (ctx, { cacheKey }) =>
    ctx.db
      .query("generations")
      .withIndex("by_cache_key", (q) => q.eq("cacheKey", cacheKey))
      .first(),
});

export const createGeneration = internalMutation({
  args: {
    cacheKey: v.string(),
    sourceId: v.id("sources"),
    provider: v.string(),
    model: v.string(),
    promptVersion: v.string(),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    return await ctx.db.insert("generations", {
      cacheKey: a.cacheKey,
      sourceId: a.sourceId,
      promptVersion: a.promptVersion,
      provider: a.provider,
      model: a.model,
      status: "queued",
      stage: "Queued…",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      reuseCount: 0,
      lastUsedAt: now,
      createdAt: now,
    });
  },
});

export const setStage = internalMutation({
  args: {
    generationId: v.id("generations"),
    status: v.optional(v.string()),
    stage: v.string(),
    cacheKey: v.optional(v.string()),
    transcriptId: v.optional(v.id("transcripts")),
  },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.generationId, {
      stage: a.stage,
      ...(a.status ? { status: a.status as any } : {}),
      ...(a.cacheKey ? { cacheKey: a.cacheKey } : {}),
      ...(a.transcriptId ? { transcriptId: a.transcriptId } : {}),
    });
  },
});

export const completeGeneration = internalMutation({
  args: {
    generationId: v.id("generations"),
    cacheKey: v.string(),
    transcriptId: v.id("transcripts"),
    projectTitle: v.string(),
    diagrams: v.array(v.any()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    durationMs: v.number(),
  },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.generationId, {
      cacheKey: a.cacheKey,
      transcriptId: a.transcriptId,
      status: "complete",
      stage: `Ready — ${a.diagrams.length} diagrams`,
      diagrams: a.diagrams,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      durationMs: a.durationMs,
      lastUsedAt: Date.now(),
    });
    const gen = await ctx.db.get(a.generationId);
    if (gen) await ctx.db.patch(gen.sourceId, { title: a.projectTitle });
  },
});

/** A late cache hit: point this generation row at the already-built result. */
export const adoptCached = internalMutation({
  args: { generationId: v.id("generations"), cachedId: v.id("generations") },
  handler: async (ctx, { generationId, cachedId }) => {
    const cached = await ctx.db.get(cachedId);
    if (!cached) return;
    await ctx.db.patch(generationId, {
      status: "complete",
      stage: "Ready — this video was already mapped",
      diagrams: cached.diagrams,
      cacheKey: `${cached.cacheKey}#dup${Date.now()}`,
    });
  },
});

export const failGeneration = internalMutation({
  args: {
    generationId: v.id("generations"),
    failureCode: v.string(),
    failureMessage: v.string(),
  },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.generationId, {
      status: "failed",
      stage: "Failed",
      failureCode: a.failureCode,
      failureMessage: a.failureMessage,
    });
  },
});

/**
 * Fork a private, editable project from the shared generation.
 * This is the split that makes caching safe: two users on the same video share
 * one `generations` row but never share a `projects` row.
 */
export const forkProject = internalMutation({
  args: { deviceId: v.string(), generationId: v.id("generations") },
  handler: async (ctx, { deviceId, generationId }) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_device_generation", (q) =>
        q.eq("deviceId", deviceId).eq("generationId", generationId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { lastOpenedAt: Date.now() });
      return existing._id;
    }

    const gen = await ctx.db.get(generationId);
    if (!gen || !gen.diagrams?.length) throw new Error("Generation is not ready.");
    const source = await ctx.db.get(gen.sourceId);
    const now = Date.now();

    const projectId = await ctx.db.insert("projects", {
      deviceId,
      sourceId: gen.sourceId,
      generationId,
      title: source?.title ?? "Untitled",
      thumbnailUrl: source?.thumbnailUrl,
      lastOpenedAt: now,
      createdAt: now,
    });

    for (const d of gen.diagrams) {
      await ctx.db.insert("diagrams", {
        projectId,
        order: d.index,
        title: d.title,
        diagramType: d.diagramType,
        revealMode: d.revealMode,
        mermaid: d.mermaid,
        narration: d.narration,
        summary: d.summary,
        createdAt: now,
      });
    }

    await ctx.db.patch(generationId, {
      reuseCount: gen.reuseCount + 1,
      lastUsedAt: now,
    });
    return projectId;
  },
});

export const consumeQuota = internalMutation({
  args: { deviceId: v.string(), day: v.string(), limit: v.number() },
  handler: async (ctx, { deviceId, day, limit }) => {
    const row = await ctx.db
      .query("usage")
      .withIndex("by_device_day", (q) => q.eq("deviceId", deviceId).eq("day", day))
      .unique();
    if (!row) {
      await ctx.db.insert("usage", { deviceId, day, generations: 1 });
      return true;
    }
    if (row.generations >= limit) return false;
    await ctx.db.patch(row._id, { generations: row.generations + 1 });
    return true;
  },
});

export const refundQuota = internalMutation({
  args: { deviceId: v.string(), day: v.string() },
  handler: async (ctx, { deviceId, day }) => {
    const row = await ctx.db
      .query("usage")
      .withIndex("by_device_day", (q) => q.eq("deviceId", deviceId).eq("day", day))
      .unique();
    if (row && row.generations > 0) {
      await ctx.db.patch(row._id, { generations: row.generations - 1 });
    }
  },
});
