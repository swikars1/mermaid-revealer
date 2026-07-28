import { state } from "./state.js";
import { parseMermaidToSteps } from "./parser.js";
import { buildNav } from "./nav.js";
import { render, resetView } from "./render.js";
import { scheduleSave } from "./persist.js";
import { refreshAnnotations } from "./annotate.js";

/* =========================================================
   Mermaid source editor

   Edits a topic in place rather than replacing it, so the ink drawn
   over it and the boxes highlighted on it survive the edit. Steps are
   re-derived from the new source, and the cached fit is dropped since
   the diagram's dimensions have almost certainly changed.
========================================================= */

let editingIdx = -1;

function els() {
  return {
    modal: document.getElementById("editModal"),
    title: document.getElementById("editTitle"),
    source: document.getElementById("editSource"),
    err: document.getElementById("editErr"),
  };
}

function showError(msg) {
  const { err } = els();
  err.textContent = msg;
  err.hidden = false;
}

export function openEditor(idx) {
  const topic = state.topics[idx];
  if (!topic) return;
  editingIdx = idx;
  const { modal, title, source, err } = els();
  title.value = topic.title;
  source.value = topic.source || [topic.header, ...topic.steps.flatMap((s) => s.add)].join("\n");
  err.hidden = true;
  modal.hidden = false;
  source.focus();
  source.setSelectionRange(0, 0);
}

export function closeEditor() {
  editingIdx = -1;
  els().modal.hidden = true;
}

function saveEditor() {
  if (editingIdx < 0) return;
  const topic = state.topics[editingIdx];
  if (!topic) return closeEditor();

  const { title, source } = els();
  const newSource = source.value;
  const newTitle = title.value.trim() || topic.title;

  const { header, steps } = parseMermaidToSteps(newSource);
  if (steps.length === 0) {
    showError("That source doesn't parse into any reveal steps.");
    return;
  }

  // Captured before closeEditor(), which resets editingIdx.
  const isCurrent = editingIdx === state.currentTopic;

  topic.title = newTitle;
  topic.source = newSource;
  topic.header = header;
  topic.steps = steps;
  // The old fit was measured against the old geometry.
  topic.fitView = null;
  topic.maxSeen = Math.min(topic.maxSeen, steps.length);

  closeEditor();
  buildNav();

  // Editing the diagram on screen means re-rendering it; editing any
  // other one only needs the sidebar refreshed.
  if (isCurrent) {
    state.currentStep = Math.min(Math.max(state.currentStep, 1), steps.length);
    resetView();
    render();
    refreshAnnotations();
  }
  scheduleSave();
}

export function initEditor() {
  const { modal, source } = els();

  document.getElementById("editBtn").addEventListener("click", () => {
    if (state.currentTopic >= 0) openEditor(state.currentTopic);
  });
  document.getElementById("editSave").addEventListener("click", saveEditor);
  document.getElementById("editCancel").addEventListener("click", closeEditor);
  document.getElementById("editClose").addEventListener("click", closeEditor);

  // Clicking the dimmed area outside the dialog dismisses it.
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeEditor();
  });

  source.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      saveEditor();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) {
      e.stopPropagation();
      closeEditor();
    }
  });
}
