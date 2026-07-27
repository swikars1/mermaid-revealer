import { state } from "./state.js";
import { initThemeUI } from "./theme.js";
import { render, selectTopic, goToAdjacentTopic } from "./render.js";
import { buildNav } from "./nav.js";
import { addTopic } from "./topics.js";
import { initViewportControls } from "./viewport.js";
import { initFileLoader } from "./fileLoader.js";
import { initAnnotate } from "./annotate.js";

/* =========================================================
   Controls
========================================================= */
document.getElementById("nextBtn").addEventListener("click", () => {
  if (state.currentTopic < 0) return;
  const topic = state.topics[state.currentTopic];
  if (state.currentStep < topic.steps.length) {
    state.currentStep++;
    render("forward");
  } else {
    goToAdjacentTopic(1);
  }
});
document.getElementById("prevBtn").addEventListener("click", () => {
  if (state.currentStep > 1) {
    state.currentStep--;
    render("back");
  } else {
    goToAdjacentTopic(-1);
  }
});
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (e.key === "ArrowRight") document.getElementById("nextBtn").click();
  if (e.key === "ArrowLeft") document.getElementById("prevBtn").click();
});

initThemeUI();
// initAnnotate() must come after initViewportControls() so the viewport's
// Escape handler runs first and can see that a drawing tool is still armed.
initViewportControls();
initFileLoader();
initAnnotate();

/* =========================================================
   Starter sample so the tool isn't empty on first open
========================================================= */
addTopic(
  "Sample: Cache Bridges the Gap",
  `graph LR
CPU["CPU Core"]
CPU -->|"~1ns access"| Cache["Cache: small, fast copy"]
CPU -.->|"~100ns access"| RAM["Main Memory"]
Cache <--> RAM`,
);
addTopic(
  "Sample: Row vs Column Traversal",
  `graph TD
subgraph RowMajor["Row-major (cheap)"]
R1["Elem 1"] --> R2["Elem 2"] --> R3["Elem 3"]
R1 -. same cache line .-> R3
end
subgraph ColMajor["Column-major (expensive)"]
C1["Elem 1"] --> C2["Elem 2"] --> C3["Elem 3"]
C1 -. new cache line .-> C2
end
RowMajor --> Result["Same math. ~15x real difference."]
ColMajor --> Result`,
);
selectTopic(0);
buildNav();
