# Mermaid Reveal

Paste a YouTube URL, get a set of Mermaid diagrams that reveal themselves one
idea at a time, each step narrated in plain English.

Full product/architecture design lives in [`docs/`](docs/). This README covers
running the MVP.

---

## What works today

- Paste a YouTube URL → transcript → AI-generated diagram set → step-by-step reveal
- Per-step narration captions (`%% >` comments the AI emits, parsed into steps)
- Autoplay on first open — the diagram assembles itself, then hands over control
- Generation caching: the same video for a second person is instant and free
- Reactive progress ("Fetching transcript… Read 4,812 words. Designing diagrams…")
- Recent projects list, delete, deep-link via `?p=<projectId>`
- The original offline mode: drop `.mmd`/`.md`, paste raw Mermaid

## What's deliberately not here yet

Auth (anonymous `deviceId` in localStorage stands in for a user), credits and
billing, annotations, export, sharing, AI tutor, flashcards. The schema is
shaped so these are additive — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Get a Gemini API key

Free tier, no card: <https://aistudio.google.com/apikey>

### 3. Provision Convex

```bash
npx convex dev
```

First run prompts you to log in and create a project, then generates
`convex/_generated/` and writes `VITE_CONVEX_URL` into `.env.local`.
**Leave this running** — it's the backend dev server and it hot-reloads.

### 4. Set backend env vars

In a second terminal:

```bash
npx convex env set GEMINI_API_KEY your-key-here
```

Optional overrides:

```bash
npx convex env set LLM_MODEL gemini-2.5-flash
npx convex env set LLM_PROVIDER gemini
npx convex env set DAILY_GENERATION_LIMIT 5
```

### 5. Set up transcripts — pick one

YouTube no longer serves captions to a plain server fetch (details in
[Transcripts](#transcripts) below). Two options:

**A. Local proxy (automatic, free).** Runs on your machine so YouTube sees
your residential IP, and uses yt-dlp, which is maintained against YouTube's
countermeasures.

```bash
brew install yt-dlp
node scripts/transcript-proxy.mjs
```

In another terminal, expose it and point Convex at it:

```bash
cloudflared tunnel --url http://localhost:8799
```

```bash
npx convex env set TRANSCRIPT_PROXY_URL https://your-tunnel-host.trycloudflare.com
```

```bash
npx convex env set TRANSCRIPT_PROXY_TOKEN <token the script printed>
```

**B. Paste the transcript (no setup).** Skip the above. In the app, click
**✎ Paste transcript**, or wait for a fetch to fail and the panel appears
automatically. On YouTube: **…more → Show transcript**, copy, paste. This path
can't be blocked.

### 6. Run the frontend

```bash
npm run dev
```

<http://localhost:8791>

Without `VITE_CONVEX_URL` the app still runs as the original offline diagram
viewer; only the generate panel is disabled.

---

## Swapping the LLM provider

Everything goes through the `LlmProvider` interface in
[`convex/lib/llm.ts`](convex/lib/llm.ts). Adding Claude or OpenAI is one
function plus a case in `getProvider()`:

```ts
export type LlmProvider = {
  readonly name: string;
  readonly model: string;
  generateJson<T>(args: {
    system: string; user: string; schema: JsonSchema;
    maxOutputTokens?: number; temperature?: number;
  }): Promise<{ data: T; usage: LlmUsage; raw: string }>;
};
```

Nothing in the pipeline, prompt, schema, or client knows which model is behind it.

Note the provider name and model are part of the generation cache key, so
switching providers doesn't serve stale output — it generates fresh and caches
separately.

---

## Layout

```
index.html            app shell
js/                   the reveal engine (vanilla ES modules, Vite-bundled)
  parser.js           re-exports shared/mermaidSteps.js
  render.js           incremental render, fit, autoplay, captions
  topics.js           mermaid source -> topic model (steps + narration)
  generate.js         URL submit, reactive progress, project loading
  convexClient.js     Convex browser client (null when unconfigured)
  nav.js viewport.js theme.js fileLoader.js state.js utils.js

shared/
  mermaidSteps.js     THE step parser. Imported by client AND backend.
                      They must agree on step boundaries or narration
                      lands on the wrong frame.

convex/
  schema.ts           sources · transcripts · generations · projects ·
                      diagrams · usage
  generate.ts         the pipeline: transcript -> LLM -> validate -> fork
  projects.ts         list / get / rename / delete
  lib/
    youtube.ts        URL normalization, caption scrape, preprocessing
    llm.ts            provider abstraction + Gemini
    prompt.ts         master prompt, output schema, PROMPT_VERSION
    validate.ts       static lint + deterministic repair

docs/                 full product + architecture + AI design
```

---

## How generation works

```
submit(url)
 ├─ normalize URL -> canonical video id
 ├─ cache probe on (videoId, transcriptHash, promptVersion, provider, model)
 │    HIT      -> fork a project. ~200ms, no quota consumed.
 │    IN-FLIGHT-> attach to the running job instead of starting a second
 ├─ consume daily quota
 ├─ fetch transcript (cached forever per source+language)
 ├─ second cache probe with the real transcript hash
 ├─ one LLM call -> { projectTitle, diagrams[] } via structured output
 ├─ per diagram: static lint + deterministic repair
 │    a diagram that can't be fixed is dropped; the rest still ship
 └─ fork a private project + diagram rows for this device
```

The split that makes this safe: **generations are shared and immutable,
projects are forked and mutable.** Two people who submit the same video share
one expensive `generations` row but never share a `projects` row, so edits and
(later) annotations stay private.

---

## Known limitations

See [Transcripts](#transcripts) — it's the one part of this that is genuinely
hard, and worth reading before you debug a failure.

**No render-level validation.** Validation is static lint + repair only.
Confirming that *every prefix actually lays out* needs a headless browser,
which Convex can't run. Until the sidecar exists, the client's existing error
banner catches the remainder and falls back to the last valid render.

**Transcript capped at 120k characters** (~2.5h of speech) and stored inline.
Convex documents cap at 1MB; longer transcripts belong in file storage.

**Single-call generation.** Outline and diagrams come from one request rather
than the two-stage pipeline in the design doc. Fine for Gemini's context
window; revisit when moving to a per-token-priced model where prompt-caching
the transcript across section calls pays for itself.

---

## Transcripts

The hardest part of this product, and not for the reason you'd expect.

### What was measured

| Approach | From Convex (cloud IP) | From a residential IP | From the browser |
|---|---|---|---|
| Watch-page scrape → `captionTracks` | **429** rate-limited | 200, tracks present | **CORS blocked** |
| InnerTube `youtubei/v1/player` | **400** (ANDROID/IOS), `UNPLAYABLE` (WEB) | same | **CORS blocked** |
| `timedtext` with the signed `baseUrl` | — | **200 with 0 bytes** | CORS ok, same 0 bytes |
| yt-dlp | n/a (no binary) | ✅ works | n/a |
| Pasted transcript | ✅ | ✅ | ✅ |

The decisive finding is row 3. Scraping the watch page still yields a signed
caption URL, but fetching that URL returns **HTTP 200 with an empty body** —
verified from a clean residential IP across `json3`, `srv3` and XML formats,
with and without session cookies and a `Referer`. YouTube now requires a PO
token there.

So the widely-circulated "scrape `captionTracks`, fetch `baseUrl`" recipe is
dead everywhere, not merely rate-limited on cloud IPs. Cloud IPs just fail
earlier and more visibly.

InnerTube was implemented, measured, and removed: with the public web key it
returns 400 for the ANDROID/IOS clients and `UNPLAYABLE` for WEB even from a
clean residential IP. It only added two guaranteed-failing round trips ahead
of the provider chain.

### What actually works

**yt-dlp**, because it implements PO token acquisition and is patched whenever
YouTube changes something. It has to run somewhere with a residential IP,
hence [`scripts/transcript-proxy.mjs`](scripts/transcript-proxy.mjs) — a
dependency-free Node server that shells out to yt-dlp and returns
`{ text, language, isAutoGenerated, title, author, durationSec }`.

Convex calls it when `TRANSCRIPT_PROXY_URL` is set, falls back to a direct
scrape (cheap, occasionally succeeds), then surfaces the paste panel.

Keep it current with `yt-dlp -U`. When YouTube changes something, yt-dlp is
what gets patched — neither the proxy nor Convex needs to.

### For production

The local proxy is an MVP unblock: it dies when your laptop sleeps. Real
options, in order of cost:

1. **Commercial caption API** (~$0.001–0.01/video) — they absorb the
   PO-token arms race. Drop-in: point `TRANSCRIPT_PROXY_URL` at an adapter.
2. **yt-dlp on a small VPS with residential proxy egress** — cheaper at volume,
   you own the maintenance.
3. **Paste-only** — zero infrastructure, more user friction. Viable if you
   pivot toward "bring your own transcript / docs" (`docs/PRODUCT_SPEC.md` §1.1).

Transcripts are cached forever per `(sourceId, language)`, so each video only
has to succeed once, ever — for every user.

## Testing the reveal engine offline

No backend needed. Open the app, expand "Load your own diagram", paste:

```
flowchart LR
%% > Every program starts with the CPU, which does the actual computation.
CPU["CPU core"]
%% > Main memory holds all your data, but it is physically far from the CPU.
RAM["Main memory (RAM)"]
%% > Reaching RAM takes roughly 100 nanoseconds, an eternity for a CPU.
CPU -.->|"~100 ns"| RAM
```

Arrow keys step, Space autoplays, the caption bar shows the narration.
