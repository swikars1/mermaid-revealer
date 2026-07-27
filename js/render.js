import { state } from "./state.js";
import { wait } from "./utils.js";
import { updateNavState } from "./nav.js";
import { syncAnnoTransform, resetAnnotationView } from "./annotate.js";
import { scheduleSave } from "./persist.js";

/* =========================================================
   Stable element keys (for detecting which nodes/edges are new
   between one incremental step and the next, since Mermaid
   re-lays out the whole graph from scratch on every render).
========================================================= */
function stableKeyFromId(id) {
  if (!id) return null;
  return id.replace(/-\d+$/, "");
}

function stableEdgeKey(pathEl) {
  const cls = pathEl.getAttribute("class") || "";
  const ls = /\bLS-([\w:.]+)/.exec(cls);
  const le = /\bLE-([\w:.]+)/.exec(cls);
  if (ls && le) return "edge:" + ls[1] + "->" + le[1];
  return pathEl.id ? "edge:" + stableKeyFromId(pathEl.id) : null;
}

function collectRenderKeys(svgEl) {
  const keys = new Set();
  svgEl
    .querySelectorAll(".node[id]")
    .forEach((n) => keys.add("node:" + stableKeyFromId(n.id)));
  svgEl
    .querySelectorAll(".clusters > g[id]")
    .forEach((n) => keys.add("cluster:" + stableKeyFromId(n.id)));
  svgEl.querySelectorAll(".edgePaths > path").forEach((p) => {
    const k = stableEdgeKey(p);
    if (k) keys.add(k);
  });
  return keys;
}

/* Tags only the elements that are new since prevKeys with an
   entrance animation, staggered slightly so a multi-line step
   (e.g. a whole subgraph block) reveals node by node instead of
   popping in as one flat block. Elements that already existed are
   left untouched so they don't flash/redraw. */
function markNewElements(svgEl, prevKeys) {
  const fresh = [];
  svgEl.querySelectorAll(".node[id]").forEach((n) => {
    if (!prevKeys.has("node:" + stableKeyFromId(n.id)))
      fresh.push([n, "mmd-enter-node"]);
  });
  svgEl.querySelectorAll(".clusters > g[id]").forEach((n) => {
    if (!prevKeys.has("cluster:" + stableKeyFromId(n.id)))
      fresh.push([n, "mmd-enter-node"]);
  });
  svgEl.querySelectorAll(".edgePaths > path").forEach((p) => {
    const k = stableEdgeKey(p);
    if (k && !prevKeys.has(k)) fresh.push([p, "mmd-enter-edge"]);
  });
  fresh.forEach(([el, cls], i) => {
    el.classList.add(cls);
    el.style.animationDelay = Math.min(i * 40, 300) + "ms";
  });
}

/* Mermaid emits width="100%" with no height, which (since .canvas
   has no intrinsic width) makes browsers fall back to a default
   replaced-element size instead of the SVG's real viewBox geometry.
   That default is unrelated to the scale we compute in ensureTopicFit,
   so the diagram visibly shrinks as the viewBox grows across steps.
   Pin width/height to the viewBox so 1 unit == 1px, matching our math. */
function normalizeSvgSize(svgEl) {
  if (!svgEl) return;
  const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
  if (vb && vb.width && vb.height) {
    svgEl.setAttribute("width", vb.width);
    svgEl.setAttribute("height", vb.height);
  }
  svgEl.style.maxWidth = "none";
}

/* =========================================================
   Render
========================================================= */
export function resetView() {
  state.view = { scale: 1, tx: 0, ty: 0 };
  state.hasAutoFitThisTopic = false;
}

export function applyTransform() {
  document.getElementById("canvas").style.transform =
    `translate(${state.view.tx}px, ${state.view.ty}px) scale(${state.view.scale})`;
  document.getElementById("zoomPct").textContent =
    Math.round(state.view.scale * 100) + "%";
  syncAnnoTransform();
}

export function fitToView() {
  const svg = document.querySelector("#canvas svg");
  const vp = document.getElementById("viewport");
  if (!svg) return;
  let bw, bh;
  try {
    const bbox = svg.getBBox();
    bw = bbox.width;
    bh = bbox.height;
  } catch (e) {
    const r = svg.getBoundingClientRect();
    bw = r.width;
    bh = r.height;
  }
  if (!bw || !bh) return;
  const vw = vp.clientWidth,
    vh = vp.clientHeight;
  const scale = Math.min(vw / bw, vh / bh, 1.4) * 0.9;
  state.view.scale = Math.max(scale, 0.1);
  state.view.tx = (vw - bw * state.view.scale) / 2;
  state.view.ty = (vh - bh * state.view.scale) / 2;
  applyTransform();
}

/* Compute one fixed scale/pan for a topic, sized to fit its FULLY revealed
   diagram, so the zoom level doesn't shift as steps are incrementally added. */
export async function ensureTopicFit(topic) {
  if (topic.fitView) return topic.fitView;
  const fullDef = [topic.header, ...topic.steps.flatMap((s) => s.add)].join(
    "\n",
  );
  const hidden = document.createElement("div");
  hidden.style.cssText =
    "position:absolute; top:-99999px; left:-99999px; visibility:hidden;";
  document.body.appendChild(hidden);
  try {
    const id =
      "mmd-fit-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
    const { svg } = await mermaid.render(id, fullDef);
    hidden.innerHTML = svg;
    const svgEl = hidden.querySelector("svg");
    let bw, bh;
    try {
      const bbox = svgEl.getBBox();
      bw = bbox.width;
      bh = bbox.height;
    } catch (e) {
      const r = svgEl.getBoundingClientRect();
      bw = r.width;
      bh = r.height;
    }
    const vp = document.getElementById("viewport");
    const vw = vp.clientWidth,
      vh = vp.clientHeight;
    if (bw && bh && vw && vh) {
      const scale = Math.max(Math.min(vw / bw, vh / bh, 1.4) * 0.9, 0.1);
      topic.fitView = {
        scale,
        tx: (vw - bw * scale) / 2,
        ty: (vh - bh * scale) / 2,
      };
    }
  } catch (e) {
    console.error("Could not precompute fit for topic", e);
  } finally {
    hidden.remove();
  }
  return topic.fitView;
}

export function renderEmpty() {
  document.getElementById("topicTitle").textContent = "No diagram loaded";
  document.getElementById("stepTag").textContent = "—";
  const cap = document.getElementById("caption");
  if (cap) {
    cap.textContent =
      "Load a .mmd file, drop a .md with mermaid code fences, or paste a diagram to begin.";
    cap.classList.add("empty");
  }
  document.getElementById("canvas").innerHTML = "";
  resetAnnotationView();
  document.getElementById("placeholder").style.display = "flex";
  document.getElementById("placeholder").textContent =
    "// nothing to show yet — load a diagram from the left panel";
  document.getElementById("prevBtn").disabled = true;
  document.getElementById("nextBtn").disabled = true;
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("progressLabel").textContent = "0/0";
}

export async function render(direction) {
  if (state.currentTopic < 0 || !state.topics[state.currentTopic]) {
    renderEmpty();
    return;
  }
  const topic = state.topics[state.currentTopic];
  topic.maxSeen = Math.max(topic.maxSeen, state.currentStep);
  scheduleSave();

  document.getElementById("topicTitle").textContent = topic.title;
  document.getElementById("stepTag").textContent =
    `${state.currentStep} / ${topic.steps.length}`;

  const hasPrevTopic = state.currentTopic > 0;
  const hasNextTopic = state.currentTopic < state.topics.length - 1;
  const done = state.currentStep >= topic.steps.length;

  const prevBtnEl = document.getElementById("prevBtn");
  prevBtnEl.disabled = state.currentStep <= 1 && !hasPrevTopic;
  prevBtnEl.title =
    state.currentStep <= 1 && hasPrevTopic
      ? `Previous diagram (${state.topics[state.currentTopic - 1].title})`
      : "Previous step";

  const nextBtnEl = document.getElementById("nextBtn");
  nextBtnEl.disabled = done && !hasNextTopic;
  nextBtnEl.title = done
    ? hasNextTopic
      ? `Next diagram (${state.topics[state.currentTopic + 1].title})`
      : "Diagram complete"
    : "Reveal next";

  const pct = topic.steps.length
    ? Math.round((state.currentStep / topic.steps.length) * 100)
    : 0;
  document.getElementById("progressFill").style.width = pct + "%";
  document.getElementById("progressLabel").textContent =
    `${state.currentStep}/${topic.steps.length}`;

  updateNavState();

  const canvas = document.getElementById("canvas");
  const placeholder = document.getElementById("placeholder");
  const stageWrap = document.querySelector(".stage-wrap");
  const oldWarn = stageWrap.querySelector(".warn-banner");
  if (oldWarn) oldWarn.remove();

  if (state.currentStep === 0) {
    canvas.classList.add("reveal-out");
    await wait(200);
    canvas.innerHTML = "";
    canvas.classList.remove("reveal-out");
    canvas.classList.add("reveal-in");
    placeholder.style.display = "flex";
    placeholder.style.opacity = "0";
    placeholder.textContent = "// nothing revealed yet";
    requestAnimationFrame(() => {
      placeholder.style.transition = "opacity .35s ease";
      placeholder.style.opacity = "1";
    });
    return;
  }
  placeholder.style.display = "none";

  const lines = [topic.header];
  for (let i = 0; i < state.currentStep; i++) lines.push(...topic.steps[i].add);
  const def = lines.join("\n");

  const myToken = ++state.renderToken;
  const isStep = direction === "forward" || direction === "back";
  const prevSvgEl = canvas.querySelector("svg");
  const prevKeys = direction === "forward" ? collectRenderKeys(canvas) : null;

  if (!isStep && prevSvgEl) {
    // Topic switch / theme change: a full crossfade is fine here,
    // it's a genuinely different diagram, not an incremental step.
    canvas.classList.add("reveal-out");
    await wait(220);
  }

  if (!state.hasAutoFitThisTopic) {
    await ensureTopicFit(topic);
    if (myToken !== state.renderToken) return;
  }

  const id = "mmd-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
  try {
    const { svg } = await mermaid.render(id, def);
    if (myToken !== state.renderToken) return;
    canvas.innerHTML = svg;
    const svgEl = canvas.querySelector("svg");
    normalizeSvgSize(svgEl);
    canvas.classList.remove("reveal-out");
    canvas.classList.add("reveal-in");
    requestAnimationFrame(() => canvas.classList.remove("reveal-in"));
    if (prevKeys) markNewElements(svgEl, prevKeys);
    if (!state.hasAutoFitThisTopic) {
      if (topic.fitView) state.view = { ...topic.fitView };
      else fitToView();
      state.hasAutoFitThisTopic = true;
      applyTransform();
    } else {
      applyTransform();
    }
  } catch (e) {
    if (myToken !== state.renderToken) return;
    canvas.classList.remove("reveal-out");
    const warn = document.createElement("div");
    warn.className = "warn-banner";
    warn.textContent =
      "This step doesn't form valid Mermaid on its own — showing the last valid render.";
    stageWrap.insertBefore(warn, stageWrap.firstChild.nextSibling);
    console.error(e, def);
  }
}

export function selectTopic(i) {
  state.currentTopic = i;
  const topic = state.topics[i];
  state.currentStep = topic && topic.steps.length > 0 ? 1 : 0;
  resetView();
  resetAnnotationView();
  render();
}

/* Crosses from one diagram to the adjacent one (used once the
   current diagram is fully revealed and Next is pressed again, or
   Prev is pressed at its very first step). Arriving via Next starts
   the new diagram from scratch; arriving via Prev shows it already
   fully revealed, matching the direction you're stepping through it. */
export function goToAdjacentTopic(delta) {
  const newIdx = state.currentTopic + delta;
  if (newIdx < 0 || newIdx >= state.topics.length) return;
  state.currentTopic = newIdx;
  const topic = state.topics[newIdx];
  state.currentStep = delta > 0 ? (topic.steps.length > 0 ? 1 : 0) : topic.steps.length;
  resetView();
  resetAnnotationView();
  render();
}
