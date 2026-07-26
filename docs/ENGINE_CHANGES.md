# Engine Changes Required

Findings from reading the current codebase, and the specific changes the SaaS product needs. This is the part of the spec that is grounded in your actual code rather than in general architecture.

**Companion docs:** [PRODUCT_SPEC.md](PRODUCT_SPEC.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AI_PIPELINE.md](AI_PIPELINE.md)

---

## Summary

| # | Item | Severity | Effort |
|---|---|---|---|
| 1 | `renderEmpty()` throws — `#caption` element doesn't exist | 🔴 Bug | 5 min |
| 2 | `%%{init}%%` directives are silently dropped by header detection | 🟠 Bug | 15 min |
| 3 | Narration comments discarded — needed for captions/TTS/flashcards | 🔴 Blocker | 1 h |
| 4 | Non-visual lines consume reveal steps | 🟠 Quality | 1 h |
| 5 | No `revealMode: "atomic"` — several diagram types can't be supported | 🔴 Blocker | 2 h |
| 6 | Mermaid loaded from CDN, unpinned, no SRI | 🔴 Security | 30 min |
| 7 | `securityLevel` not configured — XSS on public share pages | 🔴 Security | 15 min |
| 8 | Step parser must be shared with the server | 🔴 Blocker | 2 h |
| 9 | State is in-memory only; no persistence shape | 🔴 Blocker | 4 h |
| 10 | No autoplay | 🟡 Product | 2 h |
| 11 | `prefers-reduced-motion` unhandled | 🟡 A11y | 30 min |
| 12 | `ensureTopicFit` renders the full diagram on a hidden node | 🟡 Perf | 1 h |
| 13 | Annotation overlay needs a transformed container | 🟠 Feature | included in annotations work |
| 14 | Nav uses index-based IDs — breaks with async loading | 🟠 Bug | 1 h |

---

## 1. `renderEmpty()` throws a TypeError

**`js/render.js:167`**

```js
const cap = document.getElementById("caption");
cap.textContent = "Load a .mmd file, drop a .md ...";   // ← cap is null
cap.classList.add("empty");
```

There is no element with `id="caption"` in `index.html` or referenced anywhere in `css/style.css`. `renderEmpty()` is called from `fileLoader.js` ("Clear all") and `nav.js` (`finishRemoveTopic` when the last diagram is removed). **Both paths currently throw**, leaving the UI in a half-cleared state.

The fix is also the fix for item 3 — add the caption element, because you need it for narration anyway:

```html
<div class="caption" id="caption" aria-live="polite"></div>
```

Placed between `.stage-wrap` and `.controls`. This element was clearly planned; it just never landed.

---

## 2. `%%{init}%%` directives are silently swallowed

**`js/parser.js:10-16`**

```js
while (idx < rawLines.length &&
       (rawLines[idx].trim() === "" || rawLines[idx].trim().startsWith("%%")))
  idx++;
const header = rawLines[idx] !== undefined ? rawLines[idx] : "graph TD";
```

Header detection skips leading `%%` lines. A Mermaid init directive at the top of a file —

```
%%{init: {'theme':'dark'}}%%
graph TD
```

— is skipped as a comment and then **never re-emitted**, because the reveal loop also skips `%%` lines. The directive silently vanishes and the theme doesn't apply.

Two options:
- **Recommended:** forbid init directives entirely (the AI prompt already does — AI_PIPELINE §6.1) and apply theming via `mermaid.initialize()` from application state. Strip them server-side on ingest.
- If you want to support user-pasted diagrams with directives: capture leading `%%{...}%%` lines into a `directives` array and prepend them to the header on every render.

Take the first option. Application-controlled theming is what you want for branded exports anyway.

---

## 3. Narration comments are discarded — the highest-value change in this document

**`js/parser.js:26`**

```js
if (trimmed === "" || trimmed.startsWith("%%")) continue;
```

Every comment is dropped. Per PRODUCT_SPEC §1.4 and AI_PIPELINE §6.1, the AI emits a narration line before each reveal line:

```
%% > A cache is a small, fast copy of memory that sits next to the CPU.
Cache["Cache — small, fast copy"]
```

Capture it:

```js
const NARRATION = /^%%\s*>\s?(.*)$/;

let pendingNarration = null;

for (const line of rest) {
  const trimmed = line.trim();
  if (trimmed === "") continue;

  const narr = NARRATION.exec(trimmed);
  if (narr) { pendingNarration = narr[1].trim(); continue; }
  if (trimmed.startsWith("%%")) continue;      // ordinary comment

  // ... existing block-grouping logic, but every steps.push() becomes:
  steps.push({
    add: [...],
    label: ...,
    narration: pendingNarration,               // ← attach
  });
  pendingNarration = null;
}
```

For grouped blocks (subgraph, alt/opt/loop), attach the narration captured *before the opening line* to the whole block, and ignore narrations that appear inside the block — or, better, let the AI emit only one narration per block. State this in the prompt (it already does: "exactly one narration line per reveal line").

Then in `render()`:

```js
const cap = document.getElementById("caption");
const step = topic.steps[state.currentStep - 1];
cap.textContent = step?.narration ?? "";
cap.classList.toggle("empty", !step?.narration);
```

This single change unlocks captions, presenter notes, TTS voice narration, MP4 export, flashcard generation, and screen-reader accessibility. Nothing else in this document has a comparable ratio of effort to value.

---

## 4. Non-visual lines consume reveal steps

`parser.js` makes **every** non-comment line a step, including lines that produce no visible change:

```
classDef highlight fill:#f96      ← a step where nothing happens
style A fill:#bbf                 ← another dead step
linkStyle 0 stroke:#f00           ← another
direction LR                      ← another
accTitle: My diagram              ← another
```

From the learner's perspective these are broken frames — they press → and nothing moves.

The AI prompt forbids emitting them, which handles generated content. But user-pasted and user-edited diagrams will contain them. Treat them as **attachments to the following step** rather than steps of their own:

```js
const NON_VISUAL = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i;

let attachments = [];
// ...
if (NON_VISUAL.test(trimmed)) { attachments.push(line); continue; }
// on the next real step:
steps.push({ add: [...attachments, ...lines], label, narration });
attachments = [];
```

Any attachments left over at EOF get appended to the final step.

---

## 5. `revealMode: "atomic"` is required

Per PRODUCT_SPEC §1.3 and AI_PIPELINE §2, several Mermaid types cannot be revealed line by line:

- `quadrantChart` — a prefix with only some axis declarations **errors**
- `pie` — every step rescales the chart; a one-slice pie reads as 100%
- `sankey-beta` — layout thrashes on every added row
- `xychart-beta` — needs the full axis config before any data

Without atomic mode, the AI either can't use these types at all or produces runtime errors. Add it to the topic model:

```js
export function makeTopic(title, source, opts = {}) {
  const revealMode = opts.revealMode ?? "steps";
  const { header, steps, directives } = parseMermaidToSteps(source);

  if (revealMode === "atomic") {
    return {
      title, header, revealMode,
      steps: [{
        add: steps.flatMap(s => s.add),
        label: title,
        narration: opts.summary ?? null,
      }],
      maxSeen: 0,
    };
  }
  return { title, header, revealMode, steps, maxSeen: 0 };
}
```

One step, everything revealed at once. The rest of the engine — progress bar, nav, fit — works unchanged, and the UI can hide the step counter when `steps.length === 1`.

---

## 6. Mermaid is loaded from a CDN with no integrity check

**`index.html:6`**

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js"></script>
```

Three problems for a commercial product:

1. **No Subresource Integrity.** A CDN compromise means arbitrary JavaScript on every page, including authenticated sessions.
2. **The version is a runtime dependency you can't test against.** Your server-side validator must render with the *exact* same Mermaid version as the client, or diagrams that validate will fail in the browser.
3. **10.9.1 excludes several diagram types** — `block-beta` and `architecture-beta` need 11.x. You should decide the version deliberately rather than inheriting it.

Fix: `npm install mermaid@<exact>`, bundle it, and export the version string as a constant used by the prompt template, the validator, and the sidecar. Upgrading Mermaid becomes a deliberate, testable change and a `promptVersion` bump.

---

## 7. Mermaid `securityLevel` is not configured

Nothing in `theme.js` or elsewhere calls `mermaid.initialize()` with security options. This is fine for a local tool where you author your own diagrams. It is **a live vulnerability the moment you render AI-generated or other-user-generated Mermaid on a public share page.**

```js
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',      // blocks click handlers and inline scripts
  htmlLabels: false,            // labels are text, not parsed HTML
  flowchart: { htmlLabels: false },
  theme: 'base',
  themeVariables: { /* driven by theme.js */ },
});
```

Plus, defence in depth (ARCHITECTURE.md §6.2):
- Strip `click` / `href` / `callback` / `%%{init:` from Mermaid source **server-side on ingest**, not just in the prompt
- Reject `<`, `>`, `javascript:`, `data:` in label text
- Serve `/d/*` and `/embed/*` with a strict CSP and inside a sandboxed iframe

Do all of this before public sharing ships, not after.

---

## 8. The step parser must be shared between client and server

The server validates that every prefix renders, generates `stepTimestamps`, and aligns narration to steps. It must compute **byte-identical step boundaries** to the client. If the server thinks a subgraph is 1 step and the client thinks it's 4, narration attaches to the wrong frames and the whole experience quietly degrades in a way that's very hard to debug.

Extract `parseMermaidToSteps` into a shared workspace package:

```
packages/mermaid-steps/
  src/index.ts       ← the single source of truth
  src/index.test.ts  ← golden tests: source in, step boundaries out
```

Imported by the React client, by Convex (`lib/mermaid/steps.ts`), and by the render sidecar. Version it, and add a golden-file test suite so a refactor can't silently shift boundaries.

While extracting, port it to TypeScript with a real return type:

```ts
type Step = { add: string[]; label: string; narration: string | null };
type Parsed = { header: string; directives: string[]; steps: Step[] };
```

---

## 9. State is in-memory only

`js/state.js` is a module-level object. The SaaS version needs:

- Projects loaded from Convex, not from `FileReader`
- `lastPosition` persisted (debounced) so reopening a project resumes where you left off
- Diagram reordering persisted (`nav.js:reorderTopic` currently mutates the array in place with no write-back)
- Optimistic updates so reorder/rename feel instant

Split the state cleanly:

| State | Home |
|---|---|
| `topics`, titles, order | Convex (`diagrams`, `projects.diagramOrder`) |
| `currentTopic`, `currentStep` | Zustand + debounced write to `projects.lastPosition` |
| `view` (scale, tx, ty), `renderToken`, `hasAutoFitThisTopic` | Zustand only — **never** persisted, changes at 60fps |
| `currentTheme`, `currentAccent` | Convex `users.preferences` + localStorage mirror for instant first paint |

The existing `THEME_STORAGE_KEY` / `ACCENT_STORAGE_KEY` localStorage approach stays as the fast-path cache; Convex is the source of truth across devices.

---

## 10. No autoplay

The single highest-impact product change in the engine, and it's small.

```js
export function startAutoPlay(msPerStep = 2200) {
  stopAutoPlay();
  state.autoplayTimer = setInterval(() => {
    const topic = state.topics[state.currentTopic];
    if (!topic || state.currentStep >= topic.steps.length) return stopAutoPlay();
    state.currentStep++;
    render("forward");
  }, msPerStep);
}
```

Then: on first open of a project, autoplay through diagram 1 once, with captions showing, then reset to step 1 and hand over control. This is the difference between "here is a diagram" and "watch this idea assemble itself." It's the demo.

Pair it with a speed control (0.5× / 1× / 2×) and a play/pause on `Space`. When narration TTS ships (Phase 3), the step duration should derive from the audio length rather than a fixed interval.

---

## 11. `prefers-reduced-motion` is unhandled

`css/style.css` and `render.js:markNewElements` apply entrance animations unconditionally. Users with vestibular sensitivity get no relief, and this will come up in any accessibility review during an education-sector sale.

```css
@media (prefers-reduced-motion: reduce) {
  .mmd-enter-node, .mmd-enter-edge { animation: none !important; }
  .canvas { transition: none !important; }
}
```

Plus a user preference that overrides the media query in both directions, stored in `users.preferences.reducedMotion`. **The reveal itself stays** — stepping through content is not motion, it's pacing. Only the entrance animations and crossfades are suppressed.

---

## 12. `ensureTopicFit` renders the whole diagram into a hidden node

**`js/render.js:120-162`**

Before the first step of every topic, the full diagram is rendered off-screen to compute a stable fit scale. This is a smart design — it's why the zoom level doesn't shift as steps are added, which is a detail most implementations get wrong.

Two improvements for the SaaS version:

1. **Cache `fitView` server-side.** The sidecar already renders the final diagram during validation (AI_PIPELINE §7 stage E). Have it return the final `viewBox` dimensions and store them on the `diagrams` row. The client then computes the fit from stored dimensions and viewport size, skipping the hidden render entirely. Saves ~200–400ms per diagram switch on large diagrams.

2. **Handle viewport resize.** `topic.fitView` is computed once against the viewport size at that moment (`vp.clientWidth`). Rotating a tablet or opening the AI tutor panel invalidates it, and nothing recomputes. Store the *scale* relative to diagram dimensions rather than absolute pan values, and recompute translation on resize.

---

## 13. Annotation overlay needs a transformed container

The canvas applies `translate(tx,ty) scale(s)` to `#canvas` (`render.js:applyTransform`). For annotations to track zoom and pan without any code, the annotation SVG must be a **sibling inside the same transformed container**:

```html
<div class="viewport" id="viewport">
  <div class="canvas" id="canvas">      <!-- transform applied here -->
    <svg class="mermaid-svg"></svg>      <!-- Mermaid output -->
    <svg class="annotation-layer"></svg> <!-- overlay, same coord space -->
  </div>
</div>
```

With `.annotation-layer` sized to the Mermaid SVG's `viewBox`, annotation coordinates are automatically in diagram space (PRODUCT_SPEC §6). Pointer events convert screen → diagram coords once, via the inverse of the current transform:

```js
function toDiagramSpace(clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  return {
    x: (clientX - r.left - state.view.tx) / state.view.scale,
    y: (clientY - r.top  - state.view.ty) / state.view.scale,
  };
}
```

One caveat: `normalizeSvgSize()` (`render.js:69`) pins width/height to the viewBox so 1 unit == 1px. Keep that — the annotation layer depends on it.

---

## 14. Nav uses index-based element IDs

**`js/nav.js`** builds DOM ids as `nav-${i}` and looks them up by index (`updateNavState`, `removeTopic`). With diagrams arriving asynchronously from a streaming generation, indices shift while the user is interacting. Switch to stable `diagramId`s from Convex as both the React key and the DOM id.

Same for `state.dragNavIdx` — the reorder logic (`reorderTopic`) is index-based and correct today because everything is synchronous. It won't be.

---

## Suggested port order

Roughly the order that keeps the app runnable at every step:

1. **Extract & TypeScript-ify the parser** into `packages/mermaid-steps` with golden tests (item 8) — everything else depends on it
2. Fix the `#caption` bug, add narration capture, add the caption element (items 1, 3)
3. Non-visual line attachment + directive handling (items 2, 4)
4. `revealMode: "atomic"` (item 5)
5. npm-pin Mermaid, set `securityLevel` (items 6, 7)
6. Port to React + Zustand, wire Convex persistence (items 9, 14)
7. Autoplay + reduced motion (items 10, 11)
8. Server-side fit caching (item 12)
9. Annotation layer (item 13)

Steps 1–5 are a good week of work and leave you with an engine the AI pipeline can actually target. Do them before writing the generation code, not after — the prompt and the parser have to agree, and it's much easier to write the prompt against a parser whose behaviour is pinned by tests.
