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
  autoplayTimer: null,
  projectId: null,
  hasAutoPlayedThisProject: false,
};

/** Stable per-browser id. Stands in for a user account until auth lands. */
export function getDeviceId() {
  const KEY = "mermaid-reveal-device";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export const THEME_STORAGE_KEY = "mermaid-reveal-theme";
export const ACCENT_STORAGE_KEY = "mermaid-reveal-accent";
