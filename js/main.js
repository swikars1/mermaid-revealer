import mermaid from "mermaid";
import { state } from "./state.js";
import { initThemeUI } from "./theme.js";
import {
  render,
  goToAdjacentTopic,
  toggleAutoPlay,
  stopAutoPlay,
  renderEmpty,
} from "./render.js";
import { buildNav } from "./nav.js";
import { initViewportControls } from "./viewport.js";
import { initFileLoader } from "./fileLoader.js";
import { initGenerate } from "./generate.js";

/* =========================================================
   Mermaid init.

   securityLevel:'strict' + htmlLabels:false is mandatory, not optional: we
   render model-generated and user-pasted Mermaid, and label content would
   otherwise be parsed as HTML. docs/ENGINE_CHANGES.md §7.
   The version is pinned in package.json rather than pulled from a CDN, so the
   backend validator and the browser agree on what is valid syntax.
========================================================= */
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false, curve: "basis" },
  theme: "base",
  fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
});
// render.js and theme.js still reach for the global; keep it until they're
// converted to imports.
window.mermaid = mermaid;

/* =========================================================
   Controls
========================================================= */
document.getElementById("nextBtn").addEventListener("click", () => {
  if (state.currentTopic < 0) return;
  stopAutoPlay();
  const topic = state.topics[state.currentTopic];
  if (state.currentStep < topic.steps.length) {
    state.currentStep++;
    render("forward");
  } else {
    goToAdjacentTopic(1);
  }
});

document.getElementById("prevBtn").addEventListener("click", () => {
  stopAutoPlay();
  if (state.currentStep > 1) {
    state.currentStep--;
    render("back");
  } else {
    goToAdjacentTopic(-1);
  }
});

document.getElementById("playBtn")?.addEventListener("click", toggleAutoPlay);

document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (e.key === "ArrowRight") document.getElementById("nextBtn").click();
  if (e.key === "ArrowLeft") document.getElementById("prevBtn").click();
  if (e.key === " ") {
    e.preventDefault();
    toggleAutoPlay();
  }
});

initThemeUI();
initViewportControls();
initFileLoader();
initGenerate();
buildNav();
renderEmpty();
