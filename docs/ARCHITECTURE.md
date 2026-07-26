# Mermaid Revealer — Technical Architecture

**Companion docs:** [PRODUCT_SPEC.md](PRODUCT_SPEC.md) · [AI_PIPELINE.md](AI_PIPELINE.md) · [ENGINE_CHANGES.md](ENGINE_CHANGES.md)

---

## 1. Is Convex the right choice?

**Yes — with one important caveat: Convex alone is not sufficient. You need one small container sidecar.**

### 1.1 Why Convex fits this product unusually well

| Requirement | How Convex handles it |
|---|---|
| Live generation progress without polling | Reactive queries. The client subscribes to a `generations` row; every stage update pushes automatically. In any other stack this is a websocket server, a pub/sub layer, and a reconnection story. Here it's a `useQuery`. |
| Multi-stage async pipeline with retries | `@convex-dev/workflow` gives durable, resumable, retryable multi-step workflows with typed state. This is exactly your generation pipeline and it's the single strongest argument for Convex. |
| Job queue | Built-in scheduler (`ctx.scheduler.runAfter`) + crons. No Redis, no BullMQ, no separate worker fleet. |
| Rate limiting | `@convex-dev/rate-limiter` — token-bucket and fixed-window, transactional. |
| LLM response caching | `@convex-dev/action-cache` — keyed, TTL'd caching of action results. |
| Credits / usage counters | Transactional mutations mean the debit-and-record is atomic. In a Postgres+queue stack you'd hand-roll this and get it subtly wrong. |
| Auth | Convex Auth with Google OAuth, or Clerk if you want the hosted UI. |
| File storage | Built-in `_storage` for transcripts, exports, and generated images. |
| RAG for the AI tutor | Native vector search over `transcriptChunks`. No Pinecone. |
| Payments | `@convex-dev/polar` component exists. |
| Type safety | End-to-end TS from schema to React with no codegen step you maintain. |

For a solo founder shipping in 8 weeks, this is a genuinely large amount of infrastructure you don't have to build or operate.

### 1.2 Where Convex will actually hurt you

These are real, and you should plan for them now rather than discovering them in week 6:

1. **1MB document size limit.** A 3-hour transcript is ~1.5MB of text. **Transcripts must live in `_storage`, with only metadata in the document.** Same for very large annotation logs — compact them into snapshot files.

2. **No headless browser.** Mermaid needs a DOM to render. You cannot render Mermaid → SVG → PNG/PDF/PPTX inside a Convex action without heroic jsdom hacks that will break on every Mermaid upgrade. **This is the reason you need a sidecar** (§2.3).

3. **No SQL, weak analytics.** You cannot do `SELECT date_trunc('day', ...) GROUP BY` over millions of rows. Ship events to PostHog (product) and Tinybird or BigQuery (cost/usage) from day one. Do not try to build dashboards on Convex queries.

4. **Read amplification via reactivity.** A reactive query re-runs and re-sends the whole result whenever any read document changes. If a client subscribes to a fat `projects` document that also holds a frequently-updating `progress` field, you re-transmit everything on every tick. **Split hot and cold fields into separate documents.** The schema below does this deliberately (`generations` is separate from `projects`; `generationProgress` is separate from `generations`).

5. **Action time limits.** Actions cap at ~10 minutes. A 3-hour video's generation must be decomposed into per-section actions orchestrated by a workflow — which you want anyway for retries and streaming.

6. **Cost shape at scale.** Convex bills function calls, bandwidth, and storage. High-frequency writes (annotation ink at 60fps) will show up on the bill. Batch annotation writes on `pointerup`, not per-pointer-move.

7. **Vendor concentration.** Mitigated by Convex being open-source and self-hostable, and by keeping your domain logic in plain TS modules that the Convex functions merely call.

### 1.3 The honest alternative, and why I'd still pick Convex

| | Convex + sidecar | Next.js + Neon/Postgres + Inngest + Clerk + S3 |
|---|---|---|
| Time to MVP | ~8 weeks solo | ~14 weeks solo |
| Real-time progress | Free | Build it (SSE or Pusher) |
| Durable workflows | Component | Inngest (good, but another vendor) |
| Analytics/SQL | ❌ external | ✅ native |
| Headless render | ❌ sidecar | ❌ sidecar (same problem) |
| Cost at 10k MAU | Higher | Lower |
| Ops burden | Near zero | Real |

The sidecar is required either way. Convex wins on time-to-market, which at your stage dominates every other consideration. **Choose Convex. Revisit only if you hit a hard limit, and by then you'll have revenue to pay for the migration.**

One structural discipline to keep the option open: put all business logic in `convex/lib/*.ts` as pure functions taking plain data. Convex functions become thin adapters. If you ever migrate, you're rewriting adapters, not the product.

---

## 2. System architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ CLIENT — React + Vite + TS                                         │
│  ├─ Revealer engine (ported from js/*.js, see ENGINE_CHANGES.md)   │
│  ├─ Mermaid 11.x, npm-pinned, securityLevel: 'strict'              │
│  ├─ Annotation overlay (SVG, diagram-space coords)                 │
│  ├─ Convex React client — reactive subscriptions + optimistic mut. │
│  └─ Zustand for ephemeral view state (zoom, current step, tool)    │
└──────────────┬─────────────────────────────────────────────────────┘
               │ Convex WS + HTTP
┌──────────────▼─────────────────────────────────────────────────────┐
│ CONVEX                                                             │
│  queries/     projects, diagrams, credits, search, share            │
│  mutations/   fork, edit, annotate, reorder, entitlements           │
│  actions/     LLM calls, transcript fetch, Polar API, sidecar calls │
│  workflows/   generationWorkflow (durable, retryable, resumable)    │
│  crons/       monthly credit reset · cache GC · Polar reconcile ·   │
│               trending pre-generation · nightly cost rollup         │
│  http/        Polar webhooks · public share pages · OG images       │
│  components/  workflow · rate-limiter · action-cache · polar ·      │
│               aggregate · migrations                                │
│  storage/     transcripts · exports · rendered assets               │
│  vector/      transcriptChunks embeddings (AI tutor RAG)            │
└───┬──────────────┬───────────────┬──────────────┬──────────────────┘
    │              │               │              │
┌───▼────────┐ ┌───▼───────────┐ ┌─▼──────────┐ ┌─▼─────────────────┐
│ Anthropic  │ │ Transcript    │ │ RENDER     │ │ Polar.sh          │
│ Claude API │ │ providers     │ │ SIDECAR    │ │ (MoR billing)     │
│            │ │ (chain, §7)   │ │ (§2.3)     │ │                   │
└────────────┘ └───────────────┘ └────────────┘ └───────────────────┘
                                       │
                            ┌──────────▼──────────┐
                            │ Deepgram / Whisper  │
                            │ (ASR fallback only) │
                            └─────────────────────┘

Observability: Sentry (errors) · Axiom or Betterstack (logs) ·
               PostHog (product analytics) · Tinybird (cost/usage)
```

### 2.1 Frontend

React + Vite + TypeScript. The existing vanilla engine ports cleanly: `parser.js`, `render.js`, and `viewport.js` are already pure-ish modules; wrap `state.js` in a Zustand store and turn `nav.js`/`fileLoader.js` into components.

**Do not put ephemeral view state (zoom, pan, current step) in Convex.** It changes at 60fps and belongs entirely client-side. Persist only "last viewed step" on a debounce.

Route structure:
```
/                      landing + URL input
/app                   workspace (projects grid, recents, favorites)
/app/p/:projectId      the studio (canvas + sidebars)
/present/:projectId    fullscreen presentation
/d/:slug               public share page (SSR'd via Convex HTTP action, indexable)
/embed/:token          sandboxed iframe embed
```

### 2.2 Backend organization

```
convex/
  schema.ts
  auth.config.ts
  lib/                    ← pure domain logic, no Convex imports
    mermaid/validate.ts   ← prefix-validity + syntax checks (parser-only, no DOM)
    mermaid/repair.ts     ← deterministic fixes before falling back to the LLM
    mermaid/steps.ts      ← the step parser, SHARED with the client
    cache/key.ts          ← canonical cache key derivation
    credits/policy.ts     ← duration → credits, tier limits
    youtube/normalize.ts  ← URL → canonical videoId
  queries/  mutations/  actions/  workflows/  crons/  http/
```

**`lib/mermaid/steps.ts` must be the same code the client uses.** If the server's idea of "step 4" differs from the client's, narration attaches to the wrong step and everything looks subtly broken. Share it via a workspace package.

### 2.3 The render sidecar (required)

A single small container — Fly.io, Cloud Run, or Railway — running Node + Playwright.

**Responsibilities:**
1. `POST /render` — Mermaid source → SVG/PNG (for OG images, exports, thumbnails)
2. `POST /validate` — authoritative render check for every prefix of a diagram
3. `POST /export/pdf` — one page per reveal step
4. `POST /export/pptx` — one slide per step (via `pptxgenjs` + rendered SVGs)
5. `POST /export/mp4` — (Phase 3) frame capture + TTS audio via ffmpeg
6. `GET /transcript` — proxied transcript fetch through residential egress IPs

**Why validation belongs here and not in Convex:** the only way to *know* a Mermaid prefix renders is to render it. A parser-only check (using `@mermaid-js/parser`) catches syntax errors but not layout failures. Run the cheap parser check in Convex first (fast, free, catches ~85%), and only escalate the survivors to the sidecar.

Keep the sidecar **stateless and idempotent**. It holds no data. If it dies, Convex retries.

**Cost:** one shared-CPU instance handles hundreds of renders/minute. ~$10–20/month.

---

## 3. Database schema

Convex, but the shape translates to Postgres directly.

### 3.1 The core relational idea

Read this before the tables — it's the design that makes caching work:

```
        ┌──────────┐
        │  source  │  global, deduped: one row per YouTube video / doc
        └────┬─────┘
             │ 1:N (per language)
        ┌────▼──────────┐
        │  transcript   │  global, cached forever. Text in _storage.
        └────┬──────────┘
             │ 1:N (per promptVersion × model × depth)
        ┌────▼──────────┐
        │  generation   │  ← THE CACHE UNIT. Expensive. Shared by all users.
        └────┬──────────┘   Holds the AI output: sections + mermaid + narration.
             │ 1:N  ── fork (copy-on-write)
        ┌────▼──────────┐
        │   project     │  ← per-user, private, editable, annotatable
        └────┬──────────┘
             │ 1:N
        ┌────▼──────────┐
        │   diagram     │  materialized copy; user edits live here
        └────┬──────────┘
             ├─ diagramVersions (history)
             └─ annotationLayers → annotationOps
```

**The single most important line in this document:** *generations are shared and immutable; projects are forked and mutable.* Everything about cost, correctness, and privacy follows from that split.

### 3.2 Tables

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({

  // ─── Identity ────────────────────────────────────────────────────
  users: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    googleId: v.string(),
    defaultWorkspaceId: v.optional(v.id("workspaces")),
    preferences: v.object({
      theme: v.union(v.literal("dark"), v.literal("light"), v.literal("system")),
      accent: v.string(),                     // matches ACCENT_STORAGE_KEY values
      revealSpeed: v.number(),                // autoplay ms/step
      autoPlayFirst: v.boolean(),
      language: v.string(),                   // BCP-47, target output language
      reducedMotion: v.boolean(),
    }),
    onboardedAt: v.optional(v.number()),
    createdAt: v.number(),
    lastActiveAt: v.number(),
  }).index("by_google", ["googleId"])
    .index("by_email", ["email"]),

  workspaces: defineTable({
    name: v.string(),
    slug: v.string(),
    type: v.union(v.literal("personal"), v.literal("team")),
    ownerId: v.id("users"),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("studio")),
    branding: v.optional(v.object({            // Studio
      logoStorageId: v.optional(v.id("_storage")),
      palette: v.optional(v.array(v.string())),
      fontFamily: v.optional(v.string()),
      hideWatermark: v.boolean(),
    })),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"])
    .index("by_slug", ["slug"]),

  workspaceMembers: defineTable({              // Phase 3
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"),
                  v.literal("editor"), v.literal("viewer")),
    invitedBy: v.optional(v.id("users")),
    joinedAt: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),


  // ─── Global, deduped content layer ───────────────────────────────
  // NOT "videos" — see PRODUCT_SPEC §1.1. Sources are polymorphic.
  sources: defineTable({
    kind: v.union(v.literal("youtube"), v.literal("upload"),
                  v.literal("paste"), v.literal("url"), v.literal("pdf")),
    externalId: v.string(),        // youtube videoId | sha256 of pasted text | url hash
    canonicalUrl: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    author: v.optional(v.string()),
    authorUrl: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    language: v.optional(v.string()),
    // popularity — drives pre-generation and the trending page
    requestCount: v.number(),
    lastRequestedAt: v.number(),
    // moderation
    blocked: v.boolean(),
    blockedReason: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_kind_external", ["kind", "externalId"])   // ← dedup key
    .index("by_popularity", ["requestCount"])
    .searchIndex("search_title", { searchField: "title" }),

  transcripts: defineTable({
    sourceId: v.id("sources"),
    language: v.string(),
    // Text lives in file storage — a 3h transcript exceeds Convex's 1MB doc limit.
    storageId: v.id("_storage"),
    contentHash: v.string(),                  // sha256 of normalized text
    charCount: v.number(),
    tokenCountEstimate: v.number(),
    // segments enable timestamp grounding; may also be offloaded when huge
    segments: v.optional(v.array(v.object({
      startSec: v.number(), endSec: v.number(), text: v.string(),
    }))),
    segmentsStorageId: v.optional(v.id("_storage")),
    provider: v.union(v.literal("youtube_captions"), v.literal("api_supadata"),
                      v.literal("api_alt"), v.literal("ytdlp_proxy"),
                      v.literal("asr_deepgram"), v.literal("asr_whisper"),
                      v.literal("user_supplied")),
    isAutoGenerated: v.boolean(),
    qualityScore: v.optional(v.number()),     // 0-1; punctuation, WPM sanity, etc.
    costUsd: v.number(),                      // ASR is expensive — track it
    createdAt: v.number(),
  }).index("by_source_lang", ["sourceId", "language"])
    .index("by_hash", ["contentHash"]),


  // ─── THE CACHE UNIT ──────────────────────────────────────────────
  generations: defineTable({
    cacheKey: v.string(),   // sha256(sourceId|transcriptHash|promptVersion|model|depth|lang)
    sourceId: v.id("sources"),
    transcriptId: v.id("transcripts"),

    // Everything in the key, stored explicitly so cache invalidation is auditable
    promptVersion: v.string(),                // "v3.1"
    model: v.string(),                        // "claude-sonnet-5"
    depth: v.union(v.literal("overview"), v.literal("standard"), v.literal("deep")),
    outputLanguage: v.string(),

    status: v.union(v.literal("queued"), v.literal("transcribing"),
                    v.literal("outlining"), v.literal("generating"),
                    v.literal("validating"), v.literal("complete"),
                    v.literal("failed"), v.literal("partial")),
    failureCode: v.optional(v.string()),
    failureMessage: v.optional(v.string()),

    outline: v.optional(v.array(v.object({    // Stage-2 output
      index: v.number(),
      title: v.string(),
      summary: v.string(),
      diagramType: v.string(),
      revealMode: v.union(v.literal("steps"), v.literal("atomic")),
      startSec: v.optional(v.number()),
      endSec: v.optional(v.number()),
    }))),

    // Immutable AI output. Projects fork FROM here.
    diagrams: v.optional(v.array(v.object({
      index: v.number(),
      title: v.string(),
      diagramType: v.string(),
      revealMode: v.union(v.literal("steps"), v.literal("atomic")),
      mermaid: v.string(),
      narration: v.array(v.string()),         // one per reveal step
      stepTimestamps: v.optional(v.array(v.number())),
      summary: v.optional(v.string()),
      validated: v.boolean(),
      repairAttempts: v.number(),
      confidence: v.optional(v.number()),
    }))),

    // Economics — this table IS your cost dashboard
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    usedBatchApi: v.boolean(),

    reuseCount: v.number(),                   // how many projects forked from this
    lastUsedAt: v.number(),
    createdAt: v.number(),
  }).index("by_cache_key", ["cacheKey"])      // ← THE hot lookup
    .index("by_source", ["sourceId"])
    .index("by_status", ["status"])
    .index("by_last_used", ["lastUsedAt"]),   // GC of never-reused generations

  // Split out because it updates many times per generation and would otherwise
  // re-transmit the whole (large) generation document to every subscriber.
  generationProgress: defineTable({
    generationId: v.id("generations"),
    stage: v.string(),
    stageIndex: v.number(),
    totalStages: v.number(),
    message: v.string(),                      // user-facing: "Building diagram 3 of 5"
    diagramsReady: v.number(),
    updatedAt: v.number(),
  }).index("by_generation", ["generationId"]),


  // ─── Per-user, mutable ───────────────────────────────────────────
  projects: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    sourceId: v.id("sources"),
    generationId: v.optional(v.id("generations")),   // provenance
    title: v.string(),
    description: v.optional(v.string()),
    coverStorageId: v.optional(v.id("_storage")),
    tags: v.array(v.string()),
    isFavorite: v.boolean(),
    isArchived: v.boolean(),
    visibility: v.union(v.literal("private"), v.literal("workspace"),
                        v.literal("unlisted"), v.literal("public")),
    publicSlug: v.optional(v.string()),
    diagramOrder: v.array(v.id("diagrams")),         // user-reorderable (nav.js)
    lastOpenedAt: v.number(),
    lastPosition: v.optional(v.object({
      diagramIndex: v.number(), stepIndex: v.number(),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId", "isArchived"])
    .index("by_owner_recent", ["ownerId", "lastOpenedAt"])
    .index("by_public_slug", ["publicSlug"])
    .index("by_source", ["sourceId"])
    .searchIndex("search", { searchField: "title",
                             filterFields: ["workspaceId", "isArchived"] }),

  diagrams: defineTable({
    projectId: v.id("projects"),
    order: v.number(),
    title: v.string(),
    diagramType: v.string(),
    revealMode: v.union(v.literal("steps"), v.literal("atomic")),
    mermaid: v.string(),                      // full source, user-editable
    narration: v.array(v.string()),
    stepCount: v.number(),                    // denormalized from the parser
    stepTimestamps: v.optional(v.array(v.number())),
    summary: v.optional(v.string()),
    theme: v.optional(v.object({ accent: v.string(), preset: v.string() })),
    currentVersion: v.number(),
    isUserEdited: v.boolean(),                // signal: AI output wasn't good enough
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId", "order"]),

  diagramVersions: defineTable({
    diagramId: v.id("diagrams"),
    version: v.number(),
    mermaid: v.string(),
    narration: v.array(v.string()),
    authorId: v.optional(v.id("users")),      // null = AI
    changeKind: v.union(v.literal("ai_generated"), v.literal("ai_regenerated"),
                        v.literal("ai_repaired"), v.literal("user_edit"),
                        v.literal("revert")),
    changeNote: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_diagram", ["diagramId", "version"]),


  // ─── Annotations ─────────────────────────────────────────────────
  annotationLayers: defineTable({
    projectId: v.id("projects"),
    diagramId: v.id("diagrams"),
    name: v.string(),
    order: v.number(),
    visible: v.boolean(),
    locked: v.boolean(),
    opacity: v.number(),
    ownerId: v.id("users"),
    lastSeq: v.number(),                      // op counter
    undoPointer: v.number(),                  // undo/redo = moving this
    snapshotStorageId: v.optional(v.id("_storage")),  // compaction
    snapshotSeq: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_diagram", ["diagramId", "order"]),

  // Append-only. Undo/redo is a pointer move, not a diff. See PRODUCT_SPEC §6.
  annotationOps: defineTable({
    layerId: v.id("annotationLayers"),
    diagramId: v.id("diagrams"),
    seq: v.number(),
    op: v.union(v.literal("add"), v.literal("update"), v.literal("delete")),
    shapeId: v.string(),
    shape: v.optional(v.object({
      kind: v.union(v.literal("ink"), v.literal("highlight"), v.literal("arrow"),
                    v.literal("ellipse"), v.literal("rect"), v.literal("text")),
      // ALL coordinates in diagram space (SVG viewBox units), never screen px
      points: v.optional(v.array(v.number())),   // flat [x,y,x,y,…]
      from: v.optional(v.array(v.number())),
      to: v.optional(v.array(v.number())),
      bbox: v.optional(v.array(v.number())),
      text: v.optional(v.string()),
      color: v.string(),
      width: v.number(),
      opacity: v.number(),
    })),
    stepIndex: v.number(),                    // reveal step it was created at
    visibility: v.union(v.literal("from-step"), v.literal("pinned"),
                        v.literal("step-only")),
    authorId: v.id("users"),
    createdAt: v.number(),
  }).index("by_layer_seq", ["layerId", "seq"]),


  // ─── Study layer ─────────────────────────────────────────────────
  flashcards: defineTable({
    projectId: v.id("projects"),
    diagramId: v.optional(v.id("diagrams")),
    stepIndex: v.optional(v.number()),        // deep-link target
    front: v.string(),
    back: v.string(),
    source: v.union(v.literal("ai"), v.literal("user")),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),

  reviewStates: defineTable({                 // FSRS
    userId: v.id("users"),
    flashcardId: v.id("flashcards"),
    stability: v.number(),
    difficulty: v.number(),
    reps: v.number(),
    lapses: v.number(),
    lastReviewedAt: v.number(),
    dueAt: v.number(),
  }).index("by_user_due", ["userId", "dueAt"])
    .index("by_user_card", ["userId", "flashcardId"]),

  quizzes: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    questions: v.array(v.object({
      id: v.string(),
      kind: v.union(v.literal("mcq"), v.literal("short"), v.literal("order")),
      prompt: v.string(),
      options: v.optional(v.array(v.string())),
      answer: v.string(),
      explanation: v.string(),
      diagramId: v.optional(v.id("diagrams")),
      stepIndex: v.optional(v.number()),      // ← wrong answer deep-links here
    })),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),

  quizAttempts: defineTable({
    quizId: v.id("quizzes"),
    userId: v.id("users"),
    answers: v.array(v.object({ questionId: v.string(), given: v.string(),
                                correct: v.boolean() })),
    score: v.number(),
    completedAt: v.number(),
  }).index("by_user_quiz", ["userId", "quizId"]),


  // ─── AI tutor / RAG ──────────────────────────────────────────────
  transcriptChunks: defineTable({
    transcriptId: v.id("transcripts"),
    sourceId: v.id("sources"),
    chunkIndex: v.number(),
    text: v.string(),
    startSec: v.number(),
    endSec: v.number(),
    embedding: v.array(v.float64()),
  }).index("by_transcript", ["transcriptId", "chunkIndex"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding", dimensions: 1536,
      filterFields: ["sourceId"],
    }),

  chatThreads: defineTable({
    projectId: v.id("projects"),
    userId: v.id("users"),
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project_user", ["projectId", "userId"]),

  chatMessages: defineTable({
    threadId: v.id("chatThreads"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    citations: v.optional(v.array(v.object({
      chunkIndex: v.number(), startSec: v.number(), quote: v.string(),
    }))),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_thread", ["threadId", "createdAt"]),


  // ─── Sharing ─────────────────────────────────────────────────────
  shareLinks: defineTable({
    projectId: v.id("projects"),
    token: v.string(),
    kind: v.union(v.literal("view"), v.literal("embed"), v.literal("present")),
    createdBy: v.id("users"),
    passwordHash: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    allowedDomains: v.optional(v.array(v.string())),   // embed allowlist
    allowExport: v.boolean(),
    viewCount: v.number(),
    lastViewedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_token", ["token"])
    .index("by_project", ["projectId"]),

  // Live-follow presentation sessions (reactive query = ~free with Convex)
  presentSessions: defineTable({
    projectId: v.id("projects"),
    presenterId: v.id("users"),
    code: v.string(),                         // short join code
    diagramIndex: v.number(),
    stepIndex: v.number(),
    active: v.boolean(),
    startedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_code", ["code"]),


  // ─── Billing & metering ──────────────────────────────────────────
  subscriptions: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    provider: v.literal("polar"),
    polarCustomerId: v.string(),
    polarSubscriptionId: v.string(),
    productId: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("studio")),
    interval: v.union(v.literal("month"), v.literal("year")),
    status: v.union(v.literal("active"), v.literal("trialing"),
                    v.literal("past_due"), v.literal("canceled"),
                    v.literal("incomplete")),
    seats: v.number(),
    currentPeriodStart: v.number(),
    currentPeriodEnd: v.number(),
    cancelAtPeriodEnd: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"])
    .index("by_polar_sub", ["polarSubscriptionId"]),

  // Entitlements are DERIVED from subscriptions but stored separately so the
  // request path never calls Polar and never joins. Recomputed on webhook.
  entitlements: defineTable({
    workspaceId: v.id("workspaces"),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("studio")),
    creditsPerPeriod: v.number(),
    creditBalance: v.number(),                // authoritative, matches ledger sum
    rolloverCap: v.number(),
    periodStart: v.number(),
    periodEnd: v.number(),
    maxProjects: v.number(),                  // -1 = unlimited
    maxDiagramsPerProject: v.number(),
    maxAnnotationLayers: v.number(),
    tutorMessagesPerPeriod: v.number(),
    tutorMessagesUsed: v.number(),
    allowAsrFallback: v.boolean(),
    allowDeepMode: v.boolean(),
    allowExportPdf: v.boolean(),
    allowExportPptx: v.boolean(),
    allowVideoExport: v.boolean(),
    allowPublicShare: v.boolean(),
    allowApi: v.boolean(),
    hideWatermark: v.boolean(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // Append-only. Never mutate a row. creditBalance must equal the sum.
  creditLedger: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.optional(v.id("users")),
    delta: v.number(),                        // + grant, − spend
    balanceAfter: v.number(),
    reason: v.union(v.literal("period_grant"), v.literal("rollover"),
                    v.literal("purchase"), v.literal("generation"),
                    v.literal("asr_surcharge"), v.literal("deep_mode"),
                    v.literal("refund"), v.literal("admin_adjust")),
    generationId: v.optional(v.id("generations")),
    idempotencyKey: v.string(),               // prevents double-debit on retry
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId", "createdAt"])
    .index("by_idempotency", ["idempotencyKey"]),

  payments: defineTable({
    workspaceId: v.id("workspaces"),
    polarOrderId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    kind: v.union(v.literal("subscription"), v.literal("topup")),
    status: v.string(),
    creditsGranted: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"])
    .index("by_polar_order", ["polarOrderId"]),

  // Webhook idempotency — Polar WILL deliver duplicates.
  webhookEvents: defineTable({
    provider: v.literal("polar"),
    eventId: v.string(),
    eventType: v.string(),
    payload: v.string(),
    processedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    receivedAt: v.number(),
  }).index("by_event_id", ["provider", "eventId"]),


  // ─── Ops ─────────────────────────────────────────────────────────
  aiCalls: defineTable({                      // one row per LLM request
    generationId: v.optional(v.id("generations")),
    workspaceId: v.optional(v.id("workspaces")),
    purpose: v.string(),                      // outline | diagram | repair | tutor | quiz
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    cacheWriteTokens: v.number(),
    costUsd: v.number(),
    latencyMs: v.number(),
    batched: v.boolean(),
    ok: v.boolean(),
    errorType: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_generation", ["generationId"])
    .index("by_created", ["createdAt"]),

  events: defineTable({                       // buffer; forwarded to PostHog
    userId: v.optional(v.id("users")),
    anonymousId: v.optional(v.string()),
    name: v.string(),
    props: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
});
```

### 3.3 Relationship notes

- **`sources` is deduped on `(kind, externalId)`.** Every `youtu.be/x`, `youtube.com/watch?v=x&t=90`, `youtube.com/shorts/x`, and `youtube.com/live/x` must normalize to the same `externalId`. Get this right or your cache hit rate silently halves.
- **`transcripts` is keyed by `(sourceId, language)`** and cached *forever*. Transcripts are the most fragile and (for ASR) most expensive artifact. Never expire them.
- **`generations.cacheKey` is the whole caching strategy in one field.** Bumping `promptVersion` invalidates the world safely; old rows keep serving existing projects while new requests generate fresh.
- **`projects` fork from `generations`.** The fork copies `generation.diagrams[]` into `diagrams` rows. ~5KB per project. Trivial.
- **`entitlements` is derived state.** Recompute it in the Polar webhook handler, never in a query. The request path reads one document.
- **`creditLedger` is the source of truth**; `entitlements.creditBalance` is a cache of its sum. A nightly cron asserts they agree and alerts if not.
- **`annotationOps` is append-only** — undo/redo moves `annotationLayers.undoPointer`; redo is possible until a new op truncates the tail.

---

## 4. Caching & cost optimization

Ordered by impact.

### L0 — Don't call the model at all

| Technique | Effect |
|---|---|
| **Content-hash cache** (`generations.cacheKey`) | The big one. 35–50% of requests at scale become 0-cost, ~200ms responses. |
| **Pre-generate the top 2,000 educational videos** | Turns the cold-start problem into a warm cache and 2,000 SEO pages for ~$200. Do this before launch. |
| **In-flight deduplication** | If two users submit the same video within the same second, the second one *subscribes to the first job* rather than starting a second. A `generations` row in `status: "queued"` with a matching `cacheKey` is a join point, not a miss. Without this, a Reddit link produces 500 identical concurrent jobs. |
| **Transcript cache, permanent** | Transcript acquisition is the flakiest and (via ASR) most expensive stage. Cache it forever, independent of `promptVersion`. |
| **Reject junk early** | No captions + music-only + <60s of speech → refuse before any LLM call and refund. |

### L1 — Call a cheaper model

| Technique | Effect |
|---|---|
| **Model tiering by stage** | Outline & segmentation → Haiku 4.5 ($1/$5). Diagram generation → Sonnet 5 ($3/$15). "Deep" mode → Opus 5 ($5/$25). Repair → Haiku. Roughly a 60% cost reduction versus running everything on the top model. |
| **Effort tuning** | Use `output_config: { effort }`. Outline is a `low`-effort task; diagram generation is `high`. Don't pay for reasoning depth on structured extraction. |
| **Batch API (50% off)** | Expose as "Queue it — ready in ~10 min, half the credits." Also use it for all pre-generation and all background regeneration. |

### L2 — Send fewer tokens

| Technique | Effect |
|---|---|
| **Prompt caching on the transcript** | The transcript is the bulk of the input and it's reused across every section call. Cache-write is 1.25×, cache-read is **0.1×**. For a 5-section generation this cuts input cost ~70%. Note the minimum cacheable prefix: **512 tokens on Opus 5, 1024 on Sonnet 5, 4096 on Haiku 4.5** — a short transcript won't cache on Haiku, so put the *system prompt + transcript* together behind one breakpoint. |
| **Stable prompt prefix** | Caching is a prefix match. Never interpolate a timestamp, request ID, or user name into the system prompt — it invalidates everything after it. Order: `[frozen system prompt] [transcript] ← breakpoint [varying section instruction]`. Verify with `usage.cache_read_input_tokens`; if it's zero across repeated calls, something is invalidating silently. |
| **Transcript compression** | Strip filler ("um", "you know", "so basically"), collapse repeated phrases, drop sponsor segments (SponsorBlock API is free and public). Typically 15–25% fewer tokens at no quality cost. |
| **Section-scoped generation** | For a 3-hour video, don't feed the whole transcript for every diagram. Feed the full transcript once for the outline, then per-section calls get only that section plus a short global summary. |
| **Structured outputs** | `output_config.format` with a JSON schema removes retry-on-malformed-output entirely. Free reliability. |

### L3 — Do less work

| Technique | Effect |
|---|---|
| **Deterministic repair before LLM repair** | ~70% of Mermaid failures are mechanical: unquoted labels containing `(`, reserved words as node IDs, `end` casing, missing subgraph terminators. Fix these in code (`lib/mermaid/repair.ts`) for $0. Only escalate the rest. |
| **Parser-only validation first** | Run `@mermaid-js/parser` in Convex (fast, free) to catch syntax errors; only send survivors to the sidecar for a real render check. |
| **Incremental regeneration** | "Regenerate diagram 3" should cost one section call, not a full re-run. |
| **Cheap derived artifacts** | Flashcards and quizzes generate from the *narration strings*, not the transcript. ~1K input tokens instead of 12K. |
| **Debounced writes** | Annotation ink batched on `pointerup`; view position on a 2s debounce. Protects the Convex bill. |

### L4 — Operational

- **Per-workspace cost dashboard** with alerts at 3× expected spend.
- **Circuit breaker** — if hourly spend exceeds a threshold, degrade to batch-only and notify.
- **Cache GC** — a monthly cron deletes generations with `reuseCount === 0` and `lastUsedAt` older than 90 days *that no project references*.
- **Cost per generation** tracked in `generations.costUsd` and `aiCalls`; rolled up nightly to Tinybird.

---

## 5. Generation pipeline

Implemented as a `@convex-dev/workflow` — durable, resumable, retryable per step.

```
submitSource(url, opts)                                       [mutation]
  ├─ normalize URL → (kind, externalId)
  ├─ upsert sources row, bump requestCount
  ├─ compute provisional cacheKey
  ├─ IF a complete generation exists       → fork project, return. 0 credits.
  ├─ IF a queued/running generation exists → attach, return. 0 credits.
  ├─ check entitlements + credit balance
  ├─ debit credits (idempotencyKey = cacheKey + workspaceId + attempt)
  └─ start generationWorkflow

generationWorkflow(generationId)                              [workflow]
  │
  ├─ 1. ACQUIRE TRANSCRIPT                          retry: 4, backoff
  │     provider chain (§7); on total failure → refund + fail
  │     → transcripts row, storageId, contentHash
  │
  ├─ 2. RECOMPUTE cacheKey with the real transcriptHash
  │     second cache probe (a different URL form may map here)
  │     → possible late cache hit; refund and fork
  │
  ├─ 3. OUTLINE                                     Haiku 4.5, effort: low
  │     transcript → sections[] {title, summary, diagramType,
  │                              revealMode, startSec, endSec}
  │     structured output, JSON schema enforced
  │
  ├─ 4. GENERATE  (parallel, max 4 concurrent)      Sonnet 5, effort: high
  │     per section: prompt-cached transcript prefix + section instruction
  │     → { mermaid, narration[], stepTimestamps[] }
  │     each completion writes to generations.diagrams AND bumps
  │     generationProgress → the client sees diagrams appear one by one
  │
  ├─ 5. VALIDATE + REPAIR   (per diagram, see AI_PIPELINE §6)
  │     a. parse into steps (SHARED parser)
  │     b. parser-only check on every prefix
  │     c. deterministic repair
  │     d. sidecar render check on every prefix
  │     e. LLM repair (Haiku), max 2 attempts
  │     f. still broken → mark diagram failed, KEEP THE REST
  │
  ├─ 6. MATERIALIZE
  │     generations.status = complete | partial
  │     fork project + diagrams for the requesting workspace
  │     enqueue: embeddings, flashcards, OG image, thumbnail
  │
  └─ ON FAILURE: refund credits, set failureCode, notify client reactively
```

**Streaming is the UX difference.** Because step 4 writes each diagram as it completes and the client holds a reactive subscription, the first diagram is interactive while diagram 5 is still generating. This is nearly free in Convex and is the thing that makes a 60-second job feel like a 15-second one.

---

## 6. Rate limiting, security, reliability

### 6.1 Rate limits (`@convex-dev/rate-limiter`)

| Scope | Limit |
|---|---|
| Anonymous generation | 1 per IP per 24h + Cloudflare Turnstile |
| Free generation | 5/hour, 20/day (below the credit cap — stops runaway loops) |
| Pro / Studio generation | 20/hour, 100/day |
| AI tutor | 10/min per user |
| Export | 30/hour |
| Share-link creation | 20/hour |
| Public share page view | 100/min per IP (Cloudflare) |
| Polar webhook | signature-verified, replay-protected by `eventId` |

### 6.2 Security

**Mermaid injection is your most under-appreciated risk.** You render model-generated and user-pasted Mermaid, then serve it on public pages. Mitigations (all required before public sharing ships):

- `mermaid.initialize({ securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } })`
- Server-side strip of `click`, `href`, `callback`, `%%{init:` directives from any stored Mermaid
- Sanitize node labels: reject `<`, `>`, `javascript:`, `data:` in label text
- Render `/embed/*` and `/d/*` inside a sandboxed iframe with a strict CSP (`script-src 'self'`, no `unsafe-inline`)
- Pin Mermaid via npm with an exact version and Subresource Integrity — **not the CDN `<script>` tag you have today** (`index.html:6` loads Mermaid 10.9.1 from cdnjs with no SRI; a CDN compromise is arbitrary JS on every page)

Other:
- Every query/mutation checks workspace membership. No exceptions, no "internal" helpers that skip it.
- Share tokens: 32 bytes of CSPRNG, constant-time compare, revocable.
- Uploaded files: size cap, MIME sniffing, extension allowlist.
- Sidecar: authenticated with a shared secret, not publicly routable, per-request timeout, no network egress except the transcript proxy.
- Never log transcripts or full prompts at info level.
- PII: transcripts may contain personal content. Document retention (default: keep forever for cache value, but honor deletion requests, which means a `sources` → cascade delete path must exist).

### 6.3 Error recovery

| Failure | Handling |
|---|---|
| Transcript provider down | Chain to next provider; only the full chain failing surfaces to the user |
| Anthropic 429 / 529 | SDK retries with backoff; workflow-level retry with jitter; after 3, degrade to batch |
| One diagram fails validation | Ship the project with that diagram marked; never fail the whole job |
| Sidecar down | Skip render-validation (parser check still runs); queue exports for retry |
| Convex action timeout | Workflow resumes from the last completed step |
| Polar webhook missed | Nightly reconciliation cron pulls subscription state from Polar |
| Credit debited, job failed | Automatic refund via ledger entry with `reason: "refund"` |
| Duplicate webhook | `webhookEvents.by_event_id` uniqueness |
| Double-debit on retry | `creditLedger.idempotencyKey` |

### 6.4 Observability

| Concern | Tool | Notes |
|---|---|---|
| Errors | Sentry | Client + Convex + sidecar, with release tagging |
| Logs | Axiom / Betterstack | Convex log stream export |
| Product analytics | PostHog | Funnels, retention, session replay on the studio page |
| Cost & usage | Tinybird (or BigQuery) | Stream `aiCalls` nightly; this is where you answer "which users are unprofitable" |
| Uptime | Betterstack | Ping the sidecar and a synthetic generation every 15 min |
| Business | Convex dashboard + a weekly digest cron | MRR, credits burned, cache hit rate, cost/generation |

**Key alerts:** cache hit rate < 25% · cost/generation > $0.25 · validation failure rate > 15% · p95 generation time > 3 min · transcript provider chain failure rate > 10% · daily spend > 3× the 7-day average.

### 6.5 Scalability

Convex scales the read/write path for you. The parts that need attention:

- **The sidecar** is the only thing you scale manually. It's stateless — scale horizontally behind a load balancer; add a queue if render latency becomes visible.
- **Anthropic rate limits** are the real ceiling on concurrent generations. Cap workflow concurrency, queue the overflow, and communicate queue position. Batch API has separate limits — use it as a pressure valve.
- **Reactive fan-out on public share pages** — a viral diagram with 50k concurrent viewers subscribing to a reactive query is expensive. Serve public pages as **static SSR'd HTML from a Convex HTTP action with a CDN cache**, not as a reactive client app. Only the authenticated studio is reactive.

---

## 7. Transcript acquisition (the part that will bite you)

A provider chain, tried in order, with the result cached permanently.

```
1. YouTube timedtext, direct           free, ~40% success from cloud IPs
2. Commercial transcript API           ~$0.001–0.01/video, ~90% success
   (Supadata, youtube-transcript.io, Dumpling, or similar)
3. Second commercial API               vendor redundancy — do not single-source
4. yt-dlp via sidecar + residential proxy   ~$0.005/video of proxy bandwidth
5. ASR fallback: audio → Deepgram Nova/Whisper   ~$0.25–0.40/hour  ⚠️ paid tiers only
6. Manual: "paste your own transcript"  always available, always free
```

Rules:
- Record which provider succeeded (`transcripts.provider`) and its cost. Track per-provider success rates and reorder the chain by observed reliability, not by assumption.
- Never call ASR without an explicit credit charge and user consent.
- Cache the transcript against `(sourceId, language)` forever — it is independent of `promptVersion`.
- Score transcript quality (punctuation density, words-per-minute sanity, ALL-CAPS ratio) and warn the user when the input is poor rather than shipping a bad diagram silently.
- **Have a plan for total failure of options 1–4.** If YouTube tightens further, the product becomes "upload your video / paste your transcript" plus documents. Building the `source` abstraction now (PRODUCT_SPEC §1.1) is what makes that a bad week instead of a rewrite.
