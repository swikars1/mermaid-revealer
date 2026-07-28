/* =========================================================
   Theme (dark / light) + accent colors
========================================================= */
import { state, THEME_STORAGE_KEY, ACCENT_STORAGE_KEY } from "./state.js";
import { mixHex } from "./utils.js";
import { render } from "./render.js";

export const ACCENT_PRESETS = {
  emerald: {
    dark: {
      accent: "#5eeaa0",
      soft: "rgba(94,234,160,0.14)",
      glow: "rgba(94,234,160,0.25)",
      grid: "rgba(94,234,160,0.05)",
      stageDot: "rgba(94,234,160,0.08)",
      contrast: "#06120c",
    },
    light: {
      accent: "#1f9d5c",
      soft: "rgba(31,157,92,0.12)",
      glow: "rgba(31,157,92,0.2)",
      grid: "rgba(31,157,92,0.06)",
      stageDot: "rgba(31,157,92,0.07)",
      contrast: "#ffffff",
    },
  },
  ocean: {
    dark: {
      accent: "#5eb8ea",
      soft: "rgba(94,184,234,0.14)",
      glow: "rgba(94,184,234,0.25)",
      grid: "rgba(94,184,234,0.05)",
      stageDot: "rgba(94,184,234,0.08)",
      contrast: "#061018",
    },
    light: {
      accent: "#1f7a9d",
      soft: "rgba(31,122,157,0.12)",
      glow: "rgba(31,122,157,0.2)",
      grid: "rgba(31,122,157,0.06)",
      stageDot: "rgba(31,122,157,0.07)",
      contrast: "#ffffff",
    },
  },
  violet: {
    dark: {
      accent: "#a78bfa",
      soft: "rgba(167,139,250,0.14)",
      glow: "rgba(167,139,250,0.25)",
      grid: "rgba(167,139,250,0.05)",
      stageDot: "rgba(167,139,250,0.08)",
      contrast: "#0c0618",
    },
    light: {
      accent: "#7c3aed",
      soft: "rgba(124,58,237,0.12)",
      glow: "rgba(124,58,237,0.2)",
      grid: "rgba(124,58,237,0.06)",
      stageDot: "rgba(124,58,237,0.07)",
      contrast: "#ffffff",
    },
  },
  coral: {
    dark: {
      accent: "#ff9a5b",
      soft: "rgba(255,154,91,0.14)",
      glow: "rgba(255,154,91,0.25)",
      grid: "rgba(255,154,91,0.05)",
      stageDot: "rgba(255,154,91,0.08)",
      contrast: "#180c06",
    },
    light: {
      accent: "#c45f1a",
      soft: "rgba(196,95,26,0.12)",
      glow: "rgba(196,95,26,0.2)",
      grid: "rgba(196,95,26,0.06)",
      stageDot: "rgba(196,95,26,0.07)",
      contrast: "#ffffff",
    },
  },
  rose: {
    dark: {
      accent: "#f472b6",
      soft: "rgba(244,114,182,0.14)",
      glow: "rgba(244,114,182,0.25)",
      grid: "rgba(244,114,182,0.05)",
      stageDot: "rgba(244,114,182,0.08)",
      contrast: "#180610",
    },
    light: {
      accent: "#db2777",
      soft: "rgba(219,39,119,0.12)",
      glow: "rgba(219,39,119,0.2)",
      grid: "rgba(219,39,119,0.06)",
      stageDot: "rgba(219,39,119,0.07)",
      contrast: "#ffffff",
    },
  },
  gold: {
    dark: {
      accent: "#fbbf24",
      soft: "rgba(251,191,36,0.14)",
      glow: "rgba(251,191,36,0.25)",
      grid: "rgba(251,191,36,0.05)",
      stageDot: "rgba(251,191,36,0.08)",
      contrast: "#181006",
    },
    light: {
      accent: "#b8860b",
      soft: "rgba(184,134,11,0.12)",
      glow: "rgba(184,134,11,0.2)",
      grid: "rgba(184,134,11,0.06)",
      stageDot: "rgba(184,134,11,0.07)",
      contrast: "#ffffff",
    },
  },
};

function buildMermaidThemeVars(theme, accentName) {
  const preset = ACCENT_PRESETS[accentName] || ACCENT_PRESETS.emerald;
  const c = preset[theme === "light" ? "light" : "dark"];
  const isLight = theme === "light";
  const bg = isLight ? "#ffffff" : "#101815";
  const primary = isLight
    ? mixHex("#eaf7ef", c.accent, 35)
    : mixHex("#132019", c.accent, 8);
  const secondary = isLight
    ? mixHex("#eef4f0", c.accent, 18)
    : mixHex("#1a2620", c.accent, 10);
  const clusterBorder = isLight
    ? mixHex("#b9d6c4", c.accent, 40)
    : mixHex("#3a5548", c.accent, 35);
  const text = isLight ? "#132019" : "#d9f2e4";
  return {
    background: bg,
    primaryColor: primary,
    primaryBorderColor: c.accent,
    primaryTextColor: text,
    lineColor: c.accent,
    secondaryColor: secondary,
    tertiaryColor: bg,
    edgeLabelBackground: bg,
    fontFamily: "IBM Plex Mono, monospace",
    fontSize: "14px",
    borderRadius: "10px",
    clusterBkg: isLight
      ? mixHex("#f4faf6", c.accent, 12)
      : mixHex("#0d1512", c.accent, 6),
    clusterBorder: clusterBorder,
    actorBkg: primary,
    actorBorder: c.accent,
    actorTextColor: text,
    signalColor: c.accent,
    signalTextColor: text,
    labelBoxBkgColor: primary,
    labelBoxBorderColor: c.accent,
    noteBkgColor: secondary,
    noteBorderColor: clusterBorder,
    arrowheadColor: c.accent,
  };
}

function applyAccentCss(accentName) {
  const preset = ACCENT_PRESETS[accentName] || ACCENT_PRESETS.emerald;
  const c = preset[state.currentTheme === "light" ? "light" : "dark"];
  const root = document.documentElement.style;
  root.setProperty("--accent", c.accent);
  root.setProperty("--accent-soft", c.soft);
  root.setProperty("--accent-glow", c.glow);
  root.setProperty("--accent-contrast", c.contrast);
  root.setProperty("--bg-grid", c.grid);
  root.setProperty("--stage-dot", c.stageDot);
  document.querySelectorAll(".color-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.accent === accentName);
  });
}

/* Always re-applies the FULL config. mermaid.initialize() merges into
   its stored config, so passing a partial `flowchart` block elsewhere
   risks silently dropping the rest of these options — callers that need
   a one-off tweak (the PNG exporter needs htmlLabels:false) pass it as
   an override here instead, and restore by calling with none. */
export function initMermaidForTheme(theme, overrides = {}) {
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: buildMermaidThemeVars(theme, state.currentAccent),
    flowchart: {
      curve: "basis",
      htmlLabels: true,
      padding: 18,
      nodeSpacing: 55,
      rankSpacing: 65,
      diagramPadding: 12,
      ...(overrides.flowchart || {}),
    },
    sequence: { actorMargin: 60, boxMargin: 10, mirrorActors: false },
    securityLevel: "loose",
  });
}

export function applyTheme(theme, { persist = true, rerender = true } = {}) {
  state.currentTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.currentTheme);
  document.getElementById("themeIcon").innerHTML =
    state.currentTheme === "light" ? "&#9788;" : "&#9789;";
  document.getElementById("themeLabel").textContent =
    state.currentTheme === "light" ? "Light" : "Dark";
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, state.currentTheme);
  applyAccentCss(state.currentAccent);
  initMermaidForTheme(state.currentTheme);
  state.topics.forEach((t) => {
    t.fitView = null;
  });
  if (rerender) render();
}

export function applyAccent(accentName, { persist = true, rerender = true } = {}) {
  if (!ACCENT_PRESETS[accentName]) return;
  state.currentAccent = accentName;
  if (persist) localStorage.setItem(ACCENT_STORAGE_KEY, state.currentAccent);
  applyAccentCss(state.currentAccent);
  initMermaidForTheme(state.currentTheme);
  state.topics.forEach((t) => {
    t.fitView = null;
  });
  if (rerender) render();
}

export function initThemeUI() {
  document.getElementById("themeToggle").addEventListener("click", () => {
    applyTheme(state.currentTheme === "light" ? "dark" : "light");
  });

  document.getElementById("colorPicker").addEventListener("click", (e) => {
    const swatch = e.target.closest(".color-swatch");
    if (!swatch) return;
    applyAccent(swatch.dataset.accent);
  });

  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const savedAccent = localStorage.getItem(ACCENT_STORAGE_KEY);
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const initial = saved || (prefersLight ? "light" : "dark");
  state.currentAccent =
    savedAccent && ACCENT_PRESETS[savedAccent] ? savedAccent : "emerald";
  applyTheme(initial, { persist: false, rerender: false });
}
