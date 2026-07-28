export function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* Mermaid re-lays out the whole graph on every render and mints fresh
   element ids each time, suffixing a counter (`flowchart-CPU-7`). Strip
   that suffix to get a key that survives re-renders, so state keyed to a
   node (which ones are new this step, which ones are highlighted) can be
   carried across renders. */
export function stableKeyFromId(id) {
  if (!id) return null;
  return id.replace(/-\d+$/, "");
}

export function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function mixHex(baseHex, accentHex, pct) {
  const b = hexToRgb(baseHex),
    a = hexToRgb(accentHex);
  const t = pct / 100;
  const r = Math.round(b.r + (a.r - b.r) * t);
  const g = Math.round(b.g + (a.g - b.g) * t);
  const bl = Math.round(b.b + (a.b - b.b) * t);
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
