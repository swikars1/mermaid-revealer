import { state } from "./state.js";
import { parseMermaidToSteps } from "./parser.js";
import { buildNav } from "./nav.js";
import { selectTopic } from "./render.js";

/**
 * @param {string} title
 * @param {string} source            raw mermaid, may contain `%% >` narration
 * @param {object} [opts]
 * @param {"steps"|"atomic"} [opts.revealMode]
 * @param {string[]} [opts.narration] server-side narration; overrides inline
 * @param {string} [opts.summary]
 */
export function makeTopic(title, source, opts = {}) {
  const { header, directives, steps } = parseMermaidToSteps(source);
  if (steps.length === 0) return null;

  // Server-provided narration wins — it survived validation and is guaranteed
  // aligned. Inline `%% >` comments are the fallback for pasted diagrams.
  if (Array.isArray(opts.narration) && opts.narration.length) {
    steps.forEach((s, i) => {
      if (opts.narration[i]) s.narration = opts.narration[i];
    });
  }

  // Some diagram types (pie, quadrantChart) are invalid or meaningless as
  // partial prefixes, so they render in one frame. docs/ENGINE_CHANGES.md §5.
  if (opts.revealMode === "atomic") {
    return {
      title,
      header,
      directives,
      revealMode: "atomic",
      steps: [
        {
          add: steps.flatMap((s) => s.add),
          label: title,
          narration: opts.summary ?? steps[0]?.narration ?? null,
        },
      ],
      maxSeen: 0,
    };
  }

  return { title, header, directives, revealMode: "steps", steps, maxSeen: 0 };
}

export function addTopic(title, source, opts = {}) {
  const t = makeTopic(title, source, opts);
  if (!t) return false;
  state.topics.push(t);
  state.lastAddedTopicIdx = state.topics.length - 1;
  buildNav();
  selectTopic(state.topics.length - 1);
  state.lastAddedTopicIdx = -1;
  return true;
}

/** Replace every loaded diagram in one shot (used when a project loads). */
export function setTopics(list) {
  state.topics = [];
  for (const d of list) {
    const t = makeTopic(d.title, d.mermaid, {
      revealMode: d.revealMode,
      narration: d.narration,
      summary: d.summary,
    });
    if (t) state.topics.push(t);
  }
  buildNav();
  if (state.topics.length) selectTopic(0);
  return state.topics.length;
}
