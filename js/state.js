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
};

export const THEME_STORAGE_KEY = "mermaid-reveal-theme";
export const ACCENT_STORAGE_KEY = "mermaid-reveal-accent";
