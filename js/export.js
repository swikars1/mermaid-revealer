import { state } from "./state.js";
import { wrapLongLabels } from "./parser.js";
import { stableKeyFromId } from "./utils.js";
import { initMermaidForTheme } from "./theme.js";

/* =========================================================
   Export

   Bakes the three layers the user actually sees — the Mermaid diagram,
   the highlighted boxes, and the freehand annotations — into one
   standalone file.

   Two things make this more than a serialize-and-download:

   1. The look of the diagram doesn't live entirely inside the SVG.
      Mermaid embeds its own <style>, but the flowing edge dashes,
      rounded corners and highlight treatment come from the app's own
      stylesheet, which a detached SVG has no access to. Those rules are
      re-declared into the exported file.

   2. Annotation strokes are stored in canvas pixels, whose origin is
      the SVG element's top-left corner. The SVG's own user space starts
      at the viewBox origin, which is usually *not* (0,0), so every point
      has to be shifted by the viewBox offset to land where it was drawn.
========================================================= */

const SVG_NS = "http://www.w3.org/2000/svg";
const HIGHLIGHT_OPACITY = 0.3; // matches the highlighter tool in annotate.js
const PNG_SCALE = 2;

function currentTopic() {
  if (state.currentTopic < 0) return null;
  return state.topics[state.currentTopic] || null;
}

/* Resolves the CSS custom properties we bake into the export, since a
   detached SVG can't see the document's :root variables. */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
  return {
    accent: v("--accent", "#5eeaa0"),
    accentSoft: v("--accent-soft", "rgba(94,234,160,0.14)"),
    text: v("--text", "#d9f2e4"),
    panel: v("--panel", "#101815"),
  };
}

function exportStyles(theme) {
  // Static equivalents of the animated rules — an exported still frame
  // shows the dash pattern but obviously can't march it.
  return `
    /* !important for the same reason as in style.css: Mermaid's own
       embedded stylesheet scopes these by the diagram's element id
       (including a zero dasharray for solid edges), which outranks
       any class selector we append afterwards. */
    .flowchart-link { stroke-width: 2.25px !important; stroke-linecap: round;
      stroke-linejoin: round; stroke-dasharray: 8 6 !important; }
    .node rect, .node polygon, .node circle, .label-container rect { rx: 10; ry: 10; }
    .node.mmd-highlight rect, .node.mmd-highlight polygon,
    .node.mmd-highlight circle, .node.mmd-highlight ellipse,
    .node.mmd-highlight path {
      fill: ${theme.accentSoft} !important;
      stroke: ${theme.accent} !important;
      stroke-width: 2.5px !important;
      stroke-dasharray: 7 5 !important;
    }
    .anno-ink { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  `;
}

const r2 = (n) => Math.round(n * 100) / 100;

/* Same midpoint-quadratic smoothing the live annotation layer uses, so
   exported ink traces exactly the curve that was drawn. */
function pathData(points) {
  if (!points.length) return "";
  const [x0, y0] = points[0];
  if (points.length === 1) return `M ${r2(x0)} ${r2(y0)} l 0.01 0`;
  let d = `M ${r2(x0)} ${r2(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q ${r2(cx)} ${r2(cy)} ${r2((cx + nx) / 2)} ${r2((cy + ny) / 2)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${r2(last[0])} ${r2(last[1])}`;
  return d;
}

/* Appends the topic's ink into the SVG, offset into the viewBox's
   coordinate system. `auto` ink is resolved to a literal colour here —
   currentColor would otherwise inherit from whatever opens the file. */
function appendAnnotations(svgEl, topic, theme, offsetX, offsetY) {
  const strokes = topic.annotations || [];
  if (!strokes.length) return;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "anno-layer-export");
  g.setAttribute("transform", `translate(${r2(offsetX)} ${r2(offsetY)})`);
  for (const s of strokes) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("class", "anno-ink");
    p.setAttribute("d", pathData(s.points));
    p.setAttribute("stroke", s.color === "auto" ? theme.text : s.color);
    p.setAttribute("stroke-width", s.width);
    if (s.tool === "highlighter")
      p.setAttribute("stroke-opacity", HIGHLIGHT_OPACITY);
    g.appendChild(p);
  }
  svgEl.appendChild(g);
}

/* Grows the viewBox so ink drawn outside the diagram's bounds still
   makes it into the exported frame. */
function expandForAnnotations(topic, vb) {
  const strokes = topic.annotations || [];
  if (!strokes.length) return vb;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of strokes) {
    const pad = (s.width || 0) / 2;
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x - pad);
      minY = Math.min(minY, y - pad);
      maxX = Math.max(maxX, x + pad);
      maxY = Math.max(maxY, y + pad);
    }
  }
  // Ink coordinates are relative to the SVG element's top-left, which
  // sits at (vb.x, vb.y) in user space.
  const inkMinX = vb.x + minX;
  const inkMinY = vb.y + minY;
  const inkMaxX = vb.x + maxX;
  const inkMaxY = vb.y + maxY;
  const x = Math.min(vb.x, inkMinX);
  const y = Math.min(vb.y, inkMinY);
  return {
    x,
    y,
    width: Math.max(vb.x + vb.width, inkMaxX) - x,
    height: Math.max(vb.y + vb.height, inkMaxY) - y,
  };
}

/* Builds a standalone SVG element for the current topic at its current
   step. `htmlLabels` false re-renders labels as native <text>, which is
   what the PNG path needs (see rasterize below). */
async function composeSvg({ htmlLabels }) {
  const topic = currentTopic();
  if (!topic) throw new Error("No diagram loaded.");

  const lines = [topic.header];
  for (let i = 0; i < state.currentStep; i++) lines.push(...topic.steps[i].add);
  const def = wrapLongLabels(lines.join("\n"));

  const theme = readTheme();
  let markup;

  if (htmlLabels) {
    // Reuse exactly what's on screen — no re-render, so the export can't
    // drift from what the user is looking at.
    const live = document.querySelector("#canvas svg");
    if (!live) throw new Error("Nothing is rendered yet.");
    markup = live.outerHTML;
  } else {
    const sandbox = document.createElement("div");
    sandbox.style.cssText =
      "position:absolute; left:-99999px; top:-99999px; visibility:hidden;";
    document.body.appendChild(sandbox);
    try {
      initMermaidForTheme(state.currentTheme, {
        flowchart: { htmlLabels: false },
      });
      const out = await mermaid.render("mmd-export-" + Date.now(), def);
      markup = out.svg;
    } finally {
      // Always restore the on-screen renderer's label mode, even if the
      // render threw — otherwise every later step would lose HTML labels.
      initMermaidForTheme(state.currentTheme);
      sandbox.remove();
    }
  }

  const holder = document.createElement("div");
  holder.innerHTML = markup;
  const svgEl = holder.querySelector("svg");
  if (!svgEl) throw new Error("Could not read the rendered diagram.");

  // Carry the highlight classes over to the re-rendered copy, which was
  // built fresh and knows nothing about them.
  const keys = new Set(topic.highlights || []);
  if (keys.size) {
    svgEl.querySelectorAll(".node[id]").forEach((n) => {
      n.classList.toggle("mmd-highlight", keys.has(stableKeyFromId(n.id)));
    });
  }

  const vbBase = svgEl.viewBox && svgEl.viewBox.baseVal;
  let vb = vbBase && vbBase.width
    ? { x: vbBase.x, y: vbBase.y, width: vbBase.width, height: vbBase.height }
    : { x: 0, y: 0, width: 800, height: 600 };

  appendAnnotations(svgEl, topic, theme, vb.x, vb.y);
  vb = expandForAnnotations(topic, vb);

  const pad = 16;
  vb = {
    x: vb.x - pad,
    y: vb.y - pad,
    width: vb.width + pad * 2,
    height: vb.height + pad * 2,
  };

  svgEl.setAttribute("viewBox", `${r2(vb.x)} ${r2(vb.y)} ${r2(vb.width)} ${r2(vb.height)}`);
  svgEl.setAttribute("width", r2(vb.width));
  svgEl.setAttribute("height", r2(vb.height));
  svgEl.setAttribute("xmlns", SVG_NS);
  svgEl.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  svgEl.style.maxWidth = "none";

  // Opaque background: the stage has one, and a transparent export
  // would render as black-on-black wherever it's pasted.
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", r2(vb.x));
  bg.setAttribute("y", r2(vb.y));
  bg.setAttribute("width", r2(vb.width));
  bg.setAttribute("height", r2(vb.height));
  bg.setAttribute("fill", theme.panel);
  svgEl.insertBefore(bg, svgEl.firstChild);

  const styleEl = document.createElementNS(SVG_NS, "style");
  styleEl.textContent = exportStyles(theme);
  svgEl.appendChild(styleEl);

  return { svgEl, width: vb.width, height: vb.height };
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function safeName(title) {
  return (
    (title || "diagram")
      .replace(/[^\w\d\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "diagram"
  );
}

export async function exportSvg() {
  const topic = currentTopic();
  const { svgEl } = await composeSvg({ htmlLabels: true });
  const xml = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], {
    type: "image/svg+xml;charset=utf-8",
  });
  download(blob, `${safeName(topic.title)}-step${state.currentStep}.svg`);
}

export async function exportPng() {
  const topic = currentTopic();
  // Chrome refuses to rasterize <foreignObject> inside an <img>, and
  // Mermaid renders HTML labels into foreignObject — so a PNG built
  // from the on-screen SVG would come out with every label blank.
  // Re-rendering with htmlLabels:false gives native <text> instead.
  const { svgEl, width, height } = await composeSvg({ htmlLabels: false });
  const xml = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Could not rasterize the diagram."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * PNG_SCALE));
    canvas.height = Math.max(1, Math.round(height * PNG_SCALE));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!pngBlob) throw new Error("Could not encode the PNG.");
    download(pngBlob, `${safeName(topic.title)}-step${state.currentStep}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function initExport() {
  const btn = document.getElementById("exportBtn");
  const menu = document.getElementById("exportMenu");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  });

  menu.addEventListener("click", async (e) => {
    const item = e.target.closest("[data-format]");
    if (!item) return;
    menu.classList.remove("open");
    try {
      if (item.dataset.format === "svg") await exportSvg();
      else await exportPng();
    } catch (err) {
      console.error(err);
      alert(err.message || "Export failed.");
    }
  });

  document.addEventListener("click", () => menu.classList.remove("open"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.classList.remove("open");
  });
}
