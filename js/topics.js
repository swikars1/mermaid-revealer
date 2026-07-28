import { state } from "./state.js";
import { parseMermaidToSteps } from "./parser.js";
import { buildNav } from "./nav.js";
import { selectTopic } from "./render.js";

export function makeTopic(title, source) {
  const { header, steps } = parseMermaidToSteps(source);
  if (steps.length === 0) return null;
  return {
    title,
    // Raw source is kept alongside the derived header/steps so the
    // topic can be serialized to localStorage and rebuilt on reload.
    source,
    header,
    steps,
    maxSeen: 0,
    // Annotations and highlights are per-diagram, never shared between topics.
    annotations: [],
    annoUndo: [],
    annoRedo: [],
    highlights: [],
  };
}

export function addTopic(title, source) {
  const t = makeTopic(title, source);
  if (!t) {
    return false;
  }
  state.topics.push(t);
  state.lastAddedTopicIdx = state.topics.length - 1;
  buildNav();
  selectTopic(state.topics.length - 1);
  state.lastAddedTopicIdx = -1;
  return true;
}
