import { state } from "./state.js";
import { stableKeyFromId } from "./utils.js";
import { isToolArmed } from "./annotate.js";
import { scheduleSave } from "./persist.js";

/* =========================================================
   Click-to-highlight

   Clicking a node paints its background with the accent colour and
   marches a dashed border around it, so you can call attention to one
   box while talking over the diagram.

   Mermaid throws away and rebuilds the entire SVG on every step, so
   highlights can't live on the DOM — they're stored per topic as a set
   of stable node keys and re-applied after each render.
========================================================= */

const HIGHLIGHT_CLASS = "mmd-highlight";
const DRAG_SLOP = 5; // px of pointer travel still counted as a click

function currentTopic() {
  if (state.currentTopic < 0) return null;
  return state.topics[state.currentTopic] || null;
}

function highlightsOf(topic) {
  if (!topic) return null;
  if (!Array.isArray(topic.highlights)) topic.highlights = [];
  return topic.highlights;
}

/* Re-applies the topic's highlights to a freshly rendered SVG. */
export function applyHighlights(svgEl, topic) {
  if (!svgEl || !topic) return;
  const keys = new Set(highlightsOf(topic));
  svgEl.querySelectorAll(".node[id]").forEach((n) => {
    n.classList.toggle(HIGHLIGHT_CLASS, keys.has(stableKeyFromId(n.id)));
  });
}

export function refreshHighlights() {
  applyHighlights(document.querySelector("#canvas svg"), currentTopic());
}

function toggleHighlight(key) {
  const topic = currentTopic();
  if (!topic || !key) return;
  const keys = highlightsOf(topic);
  const at = keys.indexOf(key);
  if (at === -1) keys.push(key);
  else keys.splice(at, 1);
  refreshHighlights();
  scheduleSave();
}

export function clearHighlights() {
  const topic = currentTopic();
  if (!topic || !highlightsOf(topic).length) return;
  topic.highlights = [];
  refreshHighlights();
  scheduleSave();
}

export function initHighlight() {
  const viewport = document.getElementById("viewport");

  // A press that turns into a drag is a pan, not a click, so the node
  // under the pointer is only remembered until we know which it was.
  let downKey = null;
  let downX = 0;
  let downY = 0;

  viewport.addEventListener("pointerdown", (e) => {
    downKey = null;
    // While a drawing tool is armed the annotation layer swallows the
    // event anyway; bailing here keeps the two modes from overlapping.
    if (isToolArmed() || e.button !== 0) return;
    const nodeEl = e.target.closest && e.target.closest(".node[id]");
    if (!nodeEl) return;
    downKey = stableKeyFromId(nodeEl.id);
    downX = e.clientX;
    downY = e.clientY;
  });

  viewport.addEventListener("pointerup", (e) => {
    const key = downKey;
    downKey = null;
    if (!key) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP) return;
    toggleHighlight(key);
  });

  viewport.addEventListener("pointercancel", () => {
    downKey = null;
  });
}
