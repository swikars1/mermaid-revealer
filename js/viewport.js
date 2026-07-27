import { state } from "./state.js";
import { applyTransform, fitToView, ensureTopicFit } from "./render.js";
import { isToolArmed } from "./annotate.js";

/* =========================================================
   Zoom / Pan / Full screen
========================================================= */
function zoomAtCenter(viewport, factor) {
  if (!document.querySelector("#canvas svg")) return;
  const rect = viewport.getBoundingClientRect();
  const mx = rect.width / 2,
    my = rect.height / 2;
  const px = (mx - state.view.tx) / state.view.scale;
  const py = (my - state.view.ty) / state.view.scale;
  const newScale = Math.min(Math.max(state.view.scale * factor, 0.08), 8);
  state.view.tx = mx - px * newScale;
  state.view.ty = my - py * newScale;
  state.view.scale = newScale;
  applyTransform();
}

function isFakeFullscreen() {
  return document.body.classList.contains("fake-fullscreen");
}

async function refitCurrentTopic() {
  if (state.currentTopic < 0 || !state.topics[state.currentTopic]) return;
  const topic = state.topics[state.currentTopic];
  topic.fitView = null;
  state.hasAutoFitThisTopic = false;
  if (state.currentStep > 0 && document.querySelector("#canvas svg")) {
    await ensureTopicFit(topic);
    if (topic.fitView) state.view = { ...topic.fitView };
    else fitToView();
    state.hasAutoFitThisTopic = true;
    applyTransform();
  }
}

export function initViewportControls() {
  const viewport = document.getElementById("viewport");

  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!document.querySelector("#canvas svg")) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left,
        my = e.clientY - rect.top;
      const px = (mx - state.view.tx) / state.view.scale;
      const py = (my - state.view.ty) / state.view.scale;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newScale = Math.min(Math.max(state.view.scale * factor, 0.08), 8);
      state.view.tx = mx - px * newScale;
      state.view.ty = my - py * newScale;
      state.view.scale = newScale;
      applyTransform();
    },
    { passive: false },
  );

  let panning = false,
    panStartX = 0,
    panStartY = 0,
    panTx0 = 0,
    panTy0 = 0;
  viewport.addEventListener("pointerdown", (e) => {
    if (!document.querySelector("#canvas svg")) return;
    // While a drawing tool is armed, left-drag draws; middle/right-drag
    // still pans so you never have to disarm just to move around.
    if (isToolArmed() && e.button === 0) return;
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panTx0 = state.view.tx;
    panTy0 = state.view.ty;
    viewport.classList.add("grabbing");
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!panning) return;
    state.view.tx = panTx0 + (e.clientX - panStartX);
    state.view.ty = panTy0 + (e.clientY - panStartY);
    applyTransform();
  });
  function endPan() {
    panning = false;
    viewport.classList.remove("grabbing");
  }
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  viewport.addEventListener("pointerleave", () => {
    if (panning) endPan();
  });

  document
    .getElementById("zoomIn")
    .addEventListener("click", () => zoomAtCenter(viewport, 1.2));
  document
    .getElementById("zoomOut")
    .addEventListener("click", () => zoomAtCenter(viewport, 1 / 1.2));
  document.getElementById("zoomFit").addEventListener("click", () => {
    if (document.querySelector("#canvas svg")) fitToView();
  });

  /* ---- Full screen ---- */
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const fullscreenTarget = document.querySelector("main");

  async function enterFullscreen() {
    if (fullscreenTarget.requestFullscreen) {
      try {
        await fullscreenTarget.requestFullscreen();
        return;
      } catch (e) {
        /* fall through to CSS-only fullscreen below */
      }
    }
    document.body.classList.add("fake-fullscreen");
    onFullscreenChange();
  }

  function exitFullscreenAny() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    document.body.classList.remove("fake-fullscreen");
    onFullscreenChange();
  }

  function onFullscreenChange() {
    const active = !!document.fullscreenElement || isFakeFullscreen();
    document.body.classList.toggle("is-fullscreen", active);
    fullscreenBtn.title = active ? "Exit full screen" : "Full screen";
    requestAnimationFrame(refitCurrentTopic);
  }

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement || isFakeFullscreen()) exitFullscreenAny();
    else enterFullscreen();
  });
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("keydown", (e) => {
    // Escape disarms the drawing tool first (handled in annotate.js);
    // only fall through to leaving full screen once nothing is armed.
    if (isToolArmed()) return;
    if (e.key === "Escape" && isFakeFullscreen()) exitFullscreenAny();
  });
}
