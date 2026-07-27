import { state } from "./state.js";
import { parseMermaidToSteps } from "./parser.js";

/* =========================================================
   Library persistence

   Saves the raw Mermaid source (not the derived header/steps —
   those are cheap to re-parse) plus per-topic annotations and
   progress, so a reload brings back exactly what was loaded and
   drawn. Undo/redo history and pan/zoom are intentionally left
   out: they're session-scoped, not part of "what was loaded".
========================================================= */

const LIBRARY_STORAGE_KEY = "mermaid-reveal-library";
const SAVE_DEBOUNCE_MS = 400;

let saveTimer = null;
let restoring = false;

function serializeTopic(t) {
  return {
    title: t.title,
    source: t.source,
    maxSeen: t.maxSeen || 0,
    annotations: t.annotations || [],
  };
}

function writeNow() {
  try {
    const snapshot = {
      version: 1,
      currentTopic: state.currentTopic,
      currentStep: state.currentStep,
      topics: state.topics.map(serializeTopic),
    };
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (e) {
    // Quota exceeded, storage disabled (private browsing), etc. The
    // app keeps working — it just won't survive a reload this time.
    console.warn("Could not save diagram library", e);
  }
}

/* Debounced: a freehand stroke refreshes the annotation layer on
   every point added, so saving on every call here would serialize
   the whole library dozens of times a second while drawing. */
export function scheduleSave() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
}

function buildTopicFromSource(title, source) {
  const { header, steps } = parseMermaidToSteps(source);
  if (steps.length === 0) return null;
  return {
    title,
    source,
    header,
    steps,
    maxSeen: 0,
    annotations: [],
    annoUndo: [],
    annoRedo: [],
  };
}

/* Restores whatever was last saved. Returns true if at least one
   topic came back, so the caller can skip loading the starter sample. */
export function loadLibrary() {
  restoring = true;
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.topics)) return false;

    const topics = [];
    for (const t of data.topics) {
      if (!t || typeof t.source !== "string") continue;
      const topic = buildTopicFromSource(t.title || "Untitled", t.source);
      if (!topic) continue;
      topic.maxSeen = Number.isFinite(t.maxSeen) ? t.maxSeen : 0;
      if (Array.isArray(t.annotations)) topic.annotations = t.annotations;
      topics.push(topic);
    }
    if (!topics.length) return false;

    state.topics = topics;
    state.currentTopic = Math.min(
      Math.max(Number(data.currentTopic) || 0, 0),
      topics.length - 1,
    );
    state.currentStep = Math.max(
      0,
      Math.min(
        Number(data.currentStep) || 0,
        topics[state.currentTopic].steps.length,
      ),
    );
    return true;
  } catch (e) {
    console.warn("Could not restore saved diagrams", e);
    return false;
  } finally {
    restoring = false;
  }
}
