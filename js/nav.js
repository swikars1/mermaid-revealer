import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { selectTopic, renderEmpty } from "./render.js";

/* =========================================================
   Sidebar + drag reorder
========================================================= */
function createNavItem(t, i) {
  const el = document.createElement("div");
  el.className = "nav-item";
  if (i === state.lastAddedTopicIdx) el.classList.add("nav-enter");
  el.id = "nav-" + i;
  el.dataset.idx = String(i);
  el.innerHTML = `<span class="drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
    <span class="nav-num">${String(i + 1).padStart(2, "0")}</span>
    <div style="flex:1; min-width:0;">
      <div class="nav-label">${escapeHtml(t.title)}</div>
      <div class="nav-progress" id="prog-${i}"></div>
    </div>
    <span class="nav-del" data-idx="${i}" title="Remove">&times;</span>`;

  el.addEventListener("click", (e) => {
    if (e.target.closest(".nav-del") || e.target.closest(".drag-handle"))
      return;
    selectTopic(i);
  });
  el.querySelector(".nav-del").addEventListener("click", (e) => {
    e.stopPropagation();
    removeTopic(i);
  });

  const handle = el.querySelector(".drag-handle");
  handle.addEventListener("mousedown", (e) => e.stopPropagation());
  handle.addEventListener("click", (e) => e.stopPropagation());

  handle.addEventListener("dragstart", (e) => {
    state.dragNavIdx = i;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
  });
  handle.addEventListener("dragend", () => {
    state.dragNavIdx = null;
    el.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
    document
      .querySelectorAll(".nav-item")
      .forEach((n) => n.classList.remove("drag-over-top", "drag-over-bottom"));
  });
  handle.setAttribute("draggable", "true");

  el.addEventListener("dragover", (e) => {
    if (state.dragNavIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = el.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    el.classList.toggle("drag-over-top", before);
    el.classList.toggle("drag-over-bottom", !before);
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("drag-over-top", "drag-over-bottom");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over-top", "drag-over-bottom");
    const from = state.dragNavIdx;
    if (from === null || from === i) return;
    const rect = el.getBoundingClientRect();
    let to = e.clientY < rect.top + rect.height / 2 ? i : i + 1;
    reorderTopic(from, to);
  });

  return el;
}

export function reorderTopic(fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx === toIdx - 1) return;
  const [item] = state.topics.splice(fromIdx, 1);
  if (fromIdx < toIdx) toIdx--;
  state.topics.splice(toIdx, 0, item);
  if (state.currentTopic === fromIdx) state.currentTopic = toIdx;
  else if (fromIdx < state.currentTopic && toIdx >= state.currentTopic)
    state.currentTopic--;
  else if (fromIdx > state.currentTopic && toIdx <= state.currentTopic)
    state.currentTopic++;
  buildNav();
  updateNavState();
}

export function buildNav() {
  const list = document.getElementById("topicList");
  list.innerHTML = "";
  if (state.topics.length === 0) {
    list.innerHTML =
      '<div class="empty-note">No diagrams loaded yet.<br><br>Drop one or more <b>.mmd</b> files, a <b>.md</b> file containing ```mermaid fences, or use "Paste diagram" above.</div>';
    return;
  }
  state.topics.forEach((t, i) => list.appendChild(createNavItem(t, i)));
}

export function removeTopic(i) {
  const el = document.getElementById("nav-" + i);
  if (el) {
    el.classList.add("nav-leave");
    setTimeout(() => finishRemoveTopic(i), 260);
  } else {
    finishRemoveTopic(i);
  }
}

function finishRemoveTopic(i) {
  state.topics.splice(i, 1);
  if (state.topics.length === 0) {
    state.currentTopic = -1;
    buildNav();
    renderEmpty();
    return;
  }
  if (state.currentTopic >= state.topics.length)
    state.currentTopic = state.topics.length - 1;
  else if (i < state.currentTopic) state.currentTopic--;
  else if (i === state.currentTopic)
    state.currentTopic = Math.min(state.currentTopic, state.topics.length - 1);
  buildNav();
  selectTopic(state.currentTopic);
}

export function updateNavState() {
  state.topics.forEach((t, i) => {
    const el = document.getElementById("nav-" + i);
    if (!el) return;
    el.classList.toggle("active", i === state.currentTopic);
    const steps = i === state.currentTopic ? state.currentStep : t.maxSeen;
    const total = t.steps.length;
    el.classList.toggle("done", steps >= total && steps > 0);
    document.getElementById("prog-" + i).textContent =
      steps > 0 ? `${steps}/${total}` : "";
  });
}
