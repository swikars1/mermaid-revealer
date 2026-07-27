export const state = {
  topics: [],
  currentTopic: -1,
  currentStep: 0,
  renderToken: 0,
  view: { scale: 1, tx: 0, ty: 0 },
  hasAutoFitThisTopic: false,
  dragNavIdx: null,
  lastAddedTopicIdx: -1,
  currentTheme: "dark",
  currentAccent: "emerald",
  /* Freehand annotation tool. `tool` is null when the viewport is in
     plain pan/zoom mode; the strokes themselves live per-topic. */
  annotate: {
    tool: null, // null | "pen" | "highlighter" | "eraser"
    color: "#ff4d4d",
    size: 1,
  },
};

export const THEME_STORAGE_KEY = "mermaid-reveal-theme";
export const ACCENT_STORAGE_KEY = "mermaid-reveal-accent";
export const ANNOTATE_STORAGE_KEY = "mermaid-reveal-annotate";
