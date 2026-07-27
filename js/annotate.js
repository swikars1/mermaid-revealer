import { state, ANNOTATE_STORAGE_KEY } from "./state.js";
import { scheduleSave } from "./persist.js";

/* =========================================================
   Freehand annotation layer

   Strokes live in an SVG that sits on top of the diagram but
   outside .canvas, so nothing here ever touches the Mermaid
   output — re-rendering a step, switching themes or accents
   leaves the ink untouched. Points are stored in *diagram*
   coordinates (the untransformed canvas space) and the layer's
   root <g> mirrors the canvas transform, so annotations stay
   pinned to whatever they were drawn over while panning/zooming.

   Every stroke belongs to the topic (file) it was drawn on:
   it's kept on the topic object, so each diagram carries its
   own independent set of annotations.
========================================================= */

const SVG_NS = "http://www.w3.org/2000/svg";

/* "auto" ink is painted with currentColor so it flips with the
   theme — a white marker would be invisible on the light stage
   and a black one invisible on the dark stage. */
export const ANNO_COLORS = [
  { name: "Red", value: "#ff4d4d" },
  { name: "Amber", value: "#ffb020" },
  { name: "Green", value: "#2ecc71" },
  { name: "Cyan", value: "#38bdf8" },
  { name: "Violet", value: "#a78bfa" },
  { name: "Auto (matches theme)", value: "auto" },
];

/* Screen-space stroke widths; the stored width is divided by the
   zoom in effect when drawing, so ink keeps a natural on-screen
   thickness as you draw and then scales with the diagram after. */
const SIZES = [2, 3.5, 6.5];
const HIGHLIGHT_MULT = 5;
const HIGHLIGHT_OPACITY = 0.3;
const UNDO_LIMIT = 60;
const MIN_POINT_GAP = 1.2; // screen px between recorded points
const GRAB_SLOP = 7; // screen px of tolerance when grabbing a stroke

const ICON = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICONS = {
  pen: ICON(
    '<path d="M3 21l3.6-.8L20.3 6.5a1.7 1.7 0 0 0 0-2.4l-.4-.4a1.7 1.7 0 0 0-2.4 0L3.8 17.4 3 21z"/><path d="M15.5 5.5l3 3"/>',
  ),
  highlighter: ICON(
    '<path d="M5 20.5h14"/><path d="M15 3.8l5.2 5.2-7.2 7.2-5.2-5.2z"/><path d="M7.8 11l-1.6 5.4 5.4-1.6"/>',
  ),
  eraser: ICON(
    '<path d="M10.5 20.5H20"/><path d="M13.4 4.6l6 6a1.5 1.5 0 0 1 0 2.1L13 19H8.6l-4-4a1.5 1.5 0 0 1 0-2.2l6.7-6.7a1.5 1.5 0 0 1 2.1 0z"/>',
  ),
  move: ICON(
    '<path d="M12 2.8v18.4M2.8 12h18.4"/><path d="M12 2.8L9 5.8M12 2.8l3 3M12 21.2l-3-3M12 21.2l3-3M2.8 12l3-3M2.8 12l3 3M21.2 12l-3-3M21.2 12l-3 3"/>',
  ),
  undo: ICON(
    '<path d="M4.5 9.5H15a5 5 0 0 1 0 10H9"/><path d="M4.5 9.5l4.5-4.5M4.5 9.5L9 14"/>',
  ),
  redo: ICON(
    '<path d="M19.5 9.5H9a5 5 0 0 0 0 10h6"/><path d="M19.5 9.5L15 5M19.5 9.5L15 14"/>',
  ),
};

const TOOLS = [
  { id: "pen", label: "Pen", key: "D" },
  { id: "highlighter", label: "Highlighter", key: "H" },
  { id: "eraser", label: "Eraser", key: "E" },
  { id: "move", label: "Select / move ink", key: "V" },
];

let layerRoot = null;
let overlay = null; // selection + marquee chrome, drawn above the ink
let viewportEl = null;

let liveStroke = null;
let livePath = null;
let erasing = false;
let erasedThisPass = false;
let moveBase = null; // Map<stroke, original points> while dragging
let moveOrigin = null;
let marquee = null;

/* Selection is transient view state, not part of the saved ink, so
   it lives here rather than on the topic. Cleared on topic switch. */
let selection = new Set();
let pathFor = new Map();

/* ---------- topic-scoped storage ---------- */
function currentTopic() {
  if (state.currentTopic < 0) return null;
  return state.topics[state.currentTopic] || null;
}

function annoOf(topic) {
  if (!topic) return null;
  if (!Array.isArray(topic.annotations)) topic.annotations = [];
  if (!Array.isArray(topic.annoUndo)) topic.annoUndo = [];
  if (!Array.isArray(topic.annoRedo)) topic.annoRedo = [];
  return topic;
}

function pushUndo(topic) {
  annoOf(topic);
  topic.annoUndo.push(topic.annotations.slice());
  if (topic.annoUndo.length > UNDO_LIMIT) topic.annoUndo.shift();
  topic.annoRedo.length = 0;
}

/* ---------- geometry ---------- */
function toDiagram(clientX, clientY) {
  const rect = viewportEl.getBoundingClientRect();
  return [
    (clientX - rect.left - state.view.tx) / state.view.scale,
    (clientY - rect.top - state.view.ty) / state.view.scale,
  ];
}

const r2 = (n) => Math.round(n * 100) / 100;

/* Quadratic smoothing through the midpoints of consecutive samples —
   cheap, and keeps hand-drawn strokes from looking like polylines. */
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

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHit(stroke, x, y, radius) {
  const reach = radius + stroke.width / 2;
  const pts = stroke.points;
  if (pts.length === 1)
    return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
  for (let i = 0; i < pts.length - 1; i++) {
    if (
      distToSegment(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <=
      reach
    )
      return true;
  }
  return false;
}

function strokeBounds(stroke) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = stroke.width / 2;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

function unionBounds(strokes) {
  let box = null;
  for (const s of strokes) {
    const b = strokeBounds(s);
    if (!box) box = b;
    else {
      box[0] = Math.min(box[0], b[0]);
      box[1] = Math.min(box[1], b[1]);
      box[2] = Math.max(box[2], b[2]);
      box[3] = Math.max(box[3], b[3]);
    }
  }
  return box;
}

/* Topmost stroke under the cursor — last drawn wins, matching what
   you see when strokes overlap. */
function topStrokeAt(topic, x, y) {
  const radius = GRAB_SLOP / state.view.scale;
  const list = topic.annotations;
  for (let i = list.length - 1; i >= 0; i--) {
    if (strokeHit(list[i], x, y, radius)) return list[i];
  }
  return null;
}

/* ---------- painting ---------- */
function makePath(stroke) {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", pathData(stroke.points));
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", stroke.color === "auto" ? "currentColor" : stroke.color);
  if (stroke.color === "auto") p.classList.add("anno-auto");
  p.setAttribute("stroke-width", stroke.width);
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  if (stroke.tool === "highlighter")
    p.setAttribute("stroke-opacity", HIGHLIGHT_OPACITY);
  return p;
}

function drawOverlay() {
  overlay.textContent = "";
  if (marquee) {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("class", "anno-marquee");
    r.setAttribute("x", Math.min(marquee.x0, marquee.x1));
    r.setAttribute("y", Math.min(marquee.y0, marquee.y1));
    r.setAttribute("width", Math.abs(marquee.x1 - marquee.x0));
    r.setAttribute("height", Math.abs(marquee.y1 - marquee.y0));
    r.setAttribute("vector-effect", "non-scaling-stroke");
    overlay.appendChild(r);
  }
  if (selection.size) {
    const box = unionBounds(selection);
    if (box) {
      const pad = 6 / state.view.scale;
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("class", "anno-selbox");
      r.setAttribute("x", box[0] - pad);
      r.setAttribute("y", box[1] - pad);
      r.setAttribute("width", box[2] - box[0] + pad * 2);
      r.setAttribute("height", box[3] - box[1] + pad * 2);
      r.setAttribute("vector-effect", "non-scaling-stroke");
      overlay.appendChild(r);
    }
  }
}

export function refreshAnnotations() {
  if (!layerRoot) return;
  const topic = currentTopic();
  layerRoot.textContent = "";
  pathFor = new Map();
  if (topic) {
    for (const s of annoOf(topic).annotations) {
      const p = makePath(s);
      if (selection.has(s)) p.classList.add("anno-selected");
      layerRoot.appendChild(p);
      pathFor.set(s, p);
    }
  }
  layerRoot.appendChild(overlay);
  drawOverlay();
  liveStroke = null;
  livePath = null;
  updateAnnoBar();
  scheduleSave();
}

/* Drops the selection too — used when the displayed diagram changes. */
export function resetAnnotationView() {
  selection = new Set();
  marquee = null;
  refreshAnnotations();
}

export function syncAnnoTransform() {
  if (!layerRoot) return;
  layerRoot.setAttribute(
    "transform",
    `translate(${state.view.tx} ${state.view.ty}) scale(${state.view.scale})`,
  );
  // Selection chrome is padded in screen px, so it has to be re-laid
  // out whenever the zoom changes.
  if (overlay && (selection.size || marquee)) drawOverlay();
}

/* ---------- tool state ---------- */
export function isToolArmed() {
  return state.annotate.tool !== null;
}

function savePrefs() {
  try {
    localStorage.setItem(
      ANNOTATE_STORAGE_KEY,
      JSON.stringify({
        color: state.annotate.color,
        size: state.annotate.size,
      }),
    );
  } catch (e) {
    /* storage unavailable — prefs just won't persist */
  }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(ANNOTATE_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (ANNO_COLORS.some((c) => c.value === saved.color))
      state.annotate.color = saved.color;
    if (Number.isInteger(saved.size) && SIZES[saved.size] !== undefined)
      state.annotate.size = saved.size;
  } catch (e) {
    /* ignore malformed prefs */
  }
}

export function setTool(tool) {
  const next = state.annotate.tool === tool ? null : tool;
  state.annotate.tool = next;
  if (next !== "move" && selection.size) {
    selection = new Set();
    refreshAnnotations();
    return;
  }
  updateAnnoBar();
}

function pickColor(value) {
  state.annotate.color = value;
  savePrefs();
  // With ink selected, picking a colour recolours it in place; otherwise
  // picking ink implies you want to draw with it.
  if (selection.size) {
    recolorSelection(value);
    return;
  }
  const tool = state.annotate.tool;
  if (tool !== "pen" && tool !== "highlighter") state.annotate.tool = "pen";
  updateAnnoBar();
}

/* ---------- toolbar ---------- */
function updateAnnoBar() {
  const bar = document.getElementById("annoBar");
  if (!bar) return;
  const topic = currentTopic();
  const tool = state.annotate.tool;

  bar.classList.toggle("armed", isToolArmed());
  bar.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
    b.disabled = !topic;
  });
  bar.querySelectorAll("[data-color]").forEach((b) => {
    b.classList.toggle("active", b.dataset.color === state.annotate.color);
  });
  bar.querySelectorAll("[data-size]").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.size) === state.annotate.size);
  });

  const count = topic ? annoOf(topic).annotations.length : 0;
  document.getElementById("annoUndo").disabled = !topic || !topic.annoUndo.length;
  document.getElementById("annoRedo").disabled = !topic || !topic.annoRedo.length;
  document.getElementById("annoClear").disabled = !count;

  const label = document.getElementById("annoCount");
  label.textContent = selection.size
    ? `${selection.size} selected`
    : count
      ? String(count)
      : "";

  viewportEl.classList.toggle(
    "anno-draw",
    tool === "pen" || tool === "highlighter",
  );
  viewportEl.classList.toggle("anno-erase", tool === "eraser");
  viewportEl.classList.toggle("anno-move", tool === "move");
}

function buildAnnoBar() {
  const tools = document.getElementById("annoTools");
  TOOLS.forEach((t) => {
    const b = document.createElement("button");
    b.className = "anno-tool";
    b.dataset.tool = t.id;
    b.title = `${t.label} (${t.key})`;
    b.innerHTML = ICONS[t.id];
    b.addEventListener("click", () => setTool(t.id));
    tools.appendChild(b);
  });

  const colors = document.getElementById("annoColors");
  ANNO_COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "anno-color";
    b.dataset.color = c.value;
    if (c.value === "auto") b.classList.add("anno-color-auto");
    else b.style.setProperty("--ink", c.value);
    b.title = `${c.name} ink (${i + 1})`;
    b.addEventListener("click", () => pickColor(c.value));
    colors.appendChild(b);
  });

  const sizes = document.getElementById("annoSizes");
  SIZES.forEach((w, i) => {
    const b = document.createElement("button");
    b.className = "anno-size";
    b.dataset.size = String(i);
    b.title = ["Thin", "Medium", "Thick"][i] + " stroke";
    const dot = document.createElement("span");
    dot.style.width = dot.style.height = 4 + i * 4 + "px";
    b.appendChild(dot);
    b.addEventListener("click", () => {
      state.annotate.size = i;
      savePrefs();
      if (selection.size) resizeSelection(i);
      else updateAnnoBar();
    });
    sizes.appendChild(b);
  });

  const acts = document.getElementById("annoActs");
  [
    ["annoUndo", "Undo (Ctrl/Cmd+Z)", ICONS.undo, undoAnnotation],
    ["annoRedo", "Redo (Ctrl/Cmd+Shift+Z)", ICONS.redo, redoAnnotation],
  ].forEach(([id, title, icon, fn]) => {
    const b = document.createElement("button");
    b.className = "anno-act";
    b.id = id;
    b.title = title;
    b.innerHTML = icon;
    b.addEventListener("click", fn);
    acts.appendChild(b);
  });
  const clear = document.createElement("button");
  clear.className = "anno-act anno-clear";
  clear.id = "annoClear";
  clear.title = "Erase all annotations on this diagram";
  clear.textContent = "clear";
  clear.addEventListener("click", clearAnnotations);
  acts.appendChild(clear);
}

/* ---------- history actions ---------- */
export function undoAnnotation() {
  const topic = currentTopic();
  if (!topic) return;
  annoOf(topic);
  if (!topic.annoUndo.length) return;
  topic.annoRedo.push(topic.annotations.slice());
  topic.annotations = topic.annoUndo.pop();
  pruneSelection(topic);
  refreshAnnotations();
}

export function redoAnnotation() {
  const topic = currentTopic();
  if (!topic) return;
  annoOf(topic);
  if (!topic.annoRedo.length) return;
  topic.annoUndo.push(topic.annotations.slice());
  topic.annotations = topic.annoRedo.pop();
  pruneSelection(topic);
  refreshAnnotations();
}

export function clearAnnotations() {
  const topic = currentTopic();
  if (!topic) return;
  annoOf(topic);
  if (!topic.annotations.length) return;
  pushUndo(topic);
  topic.annotations = [];
  selection = new Set();
  refreshAnnotations();
}

/* Undo/redo swap the whole array, so anything selected may no longer
   be in it — drop those so the selection box can't outlive its ink. */
function pruneSelection(topic) {
  if (!selection.size) return;
  const live = new Set(topic.annotations);
  selection = new Set([...selection].filter((s) => live.has(s)));
}

/* ---------- selection editing ---------- */
/* Edits replace strokes with modified copies instead of mutating them
   in place: the undo stack holds shallow array copies, so mutating a
   stroke object would silently rewrite history too. */
function replaceSelected(topic, transform) {
  pushUndo(topic);
  const next = new Set();
  topic.annotations = topic.annotations.map((s) => {
    if (!selection.has(s)) return s;
    const copy = transform({ ...s, points: s.points.map((p) => p.slice()) });
    next.add(copy);
    return copy;
  });
  selection = next;
  refreshAnnotations();
}

function recolorSelection(value) {
  const topic = currentTopic();
  if (!topic) return;
  replaceSelected(topic, (s) => {
    s.color = value;
    return s;
  });
}

function resizeSelection(sizeIdx) {
  const topic = currentTopic();
  if (!topic) return;
  const base = SIZES[sizeIdx];
  replaceSelected(topic, (s) => {
    s.width = r2(
      (s.tool === "highlighter" ? base * HIGHLIGHT_MULT : base) /
        state.view.scale,
    );
    return s;
  });
}

function deleteSelection() {
  const topic = currentTopic();
  if (!topic || !selection.size) return;
  pushUndo(topic);
  topic.annotations = topic.annotations.filter((s) => !selection.has(s));
  selection = new Set();
  refreshAnnotations();
}

/* ---------- drawing ---------- */
function startStroke(topic, e) {
  const [x, y] = toDiagram(e.clientX, e.clientY);
  pushUndo(topic);
  const base = SIZES[state.annotate.size] || SIZES[1];
  const screenWidth =
    state.annotate.tool === "highlighter" ? base * HIGHLIGHT_MULT : base;
  liveStroke = {
    tool: state.annotate.tool,
    color: state.annotate.color,
    width: r2(screenWidth / state.view.scale),
    points: [[r2(x), r2(y)]],
  };
  topic.annotations.push(liveStroke);
  livePath = makePath(liveStroke);
  layerRoot.insertBefore(livePath, overlay);
  pathFor.set(liveStroke, livePath);
  updateAnnoBar();
}

function extendStroke(e) {
  if (!liveStroke) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const gap = MIN_POINT_GAP / state.view.scale;
  let added = false;
  for (const ev of events) {
    const [x, y] = toDiagram(ev.clientX, ev.clientY);
    const last = liveStroke.points[liveStroke.points.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < gap) continue;
    liveStroke.points.push([r2(x), r2(y)]);
    added = true;
  }
  if (added) livePath.setAttribute("d", pathData(liveStroke.points));
}

function eraseAt(topic, e) {
  const [x, y] = toDiagram(e.clientX, e.clientY);
  const radius = 9 / state.view.scale;
  const keep = topic.annotations.filter((s) => !strokeHit(s, x, y, radius));
  if (keep.length === topic.annotations.length) return;
  if (!erasedThisPass) {
    pushUndo(topic);
    erasedThisPass = true;
  }
  topic.annotations = keep;
  pruneSelection(topic);
  refreshAnnotations();
}

/* ---------- move ---------- */
function beginMove(topic, x, y) {
  // Same copy-on-write rule as replaceSelected: never mutate a stroke
  // that an undo snapshot still points at.
  pushUndo(topic);
  const next = new Set();
  moveBase = new Map();
  topic.annotations = topic.annotations.map((s) => {
    if (!selection.has(s)) return s;
    const copy = { ...s, points: s.points.map((p) => p.slice()) };
    next.add(copy);
    moveBase.set(copy, copy.points.map((p) => p.slice()));
    return copy;
  });
  selection = next;
  moveOrigin = [x, y];
  refreshAnnotations();
}

function dragMove(x, y) {
  const dx = x - moveOrigin[0];
  const dy = y - moveOrigin[1];
  for (const [stroke, base] of moveBase) {
    stroke.points = base.map(([px, py]) => [r2(px + dx), r2(py + dy)]);
    const el = pathFor.get(stroke);
    if (el) el.setAttribute("d", pathData(stroke.points));
  }
  drawOverlay();
}

function commitMarquee(topic) {
  const x0 = Math.min(marquee.x0, marquee.x1);
  const x1 = Math.max(marquee.x0, marquee.x1);
  const y0 = Math.min(marquee.y0, marquee.y1);
  const y1 = Math.max(marquee.y0, marquee.y1);
  selection = new Set(
    topic.annotations.filter((s) => {
      const b = strokeBounds(s);
      return b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
    }),
  );
  marquee = null;
  refreshAnnotations();
}

function endGesture() {
  const topic = currentTopic();
  const hadMarquee = marquee && topic;
  liveStroke = null;
  livePath = null;
  erasing = false;
  erasedThisPass = false;
  moveBase = null;
  moveOrigin = null;
  if (hadMarquee) commitMarquee(topic);
  else {
    marquee = null;
    updateAnnoBar();
  }
  // Covers the two paths above that skip refreshAnnotations for perf
  // (a completed draw stroke, a completed move drag) — refreshAnnotations
  // itself already schedules a save for every other mutation.
  scheduleSave();
}

/* =========================================================
   Init
========================================================= */
export function initAnnotate() {
  layerRoot = document.getElementById("annoRoot");
  viewportEl = document.getElementById("viewport");
  const layer = document.getElementById("annoLayer");

  overlay = document.createElementNS(SVG_NS, "g");
  overlay.setAttribute("class", "anno-overlay");
  layerRoot.appendChild(overlay);

  loadPrefs();
  buildAnnoBar();

  layer.addEventListener("pointerdown", (e) => {
    if (!isToolArmed() || e.button !== 0) return; // middle-drag still pans
    const topic = currentTopic();
    if (!topic) return;
    annoOf(topic);
    e.preventDefault();
    e.stopPropagation(); // keep the viewport's pan handler out of it
    layer.setPointerCapture(e.pointerId);
    const [x, y] = toDiagram(e.clientX, e.clientY);

    if (state.annotate.tool === "eraser") {
      erasing = true;
      erasedThisPass = false;
      eraseAt(topic, e);
    } else if (state.annotate.tool === "move") {
      const hit = topStrokeAt(topic, x, y);
      if (hit) {
        if (!selection.has(hit)) selection = new Set([hit]);
        beginMove(topic, x, y);
      } else {
        selection = new Set();
        marquee = { x0: x, y0: y, x1: x, y1: y };
        refreshAnnotations();
      }
    } else {
      startStroke(topic, e);
    }
  });

  layer.addEventListener("pointermove", (e) => {
    const topic = currentTopic();
    if (!topic) return;
    if (liveStroke) {
      extendStroke(e);
    } else if (erasing) {
      eraseAt(topic, e);
    } else if (moveBase) {
      const [x, y] = toDiagram(e.clientX, e.clientY);
      dragMove(x, y);
    } else if (marquee) {
      const [x, y] = toDiagram(e.clientX, e.clientY);
      marquee.x1 = x;
      marquee.y1 = y;
      drawOverlay();
    } else if (state.annotate.tool === "move") {
      const [x, y] = toDiagram(e.clientX, e.clientY);
      viewportEl.classList.toggle("anno-grab", !!topStrokeAt(topic, x, y));
    }
  });

  layer.addEventListener("pointerup", endGesture);
  layer.addEventListener("pointercancel", endGesture);

  document.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redoAnnotation();
      else undoAnnotation();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if ((e.key === "Delete" || e.key === "Backspace") && selection.size) {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (e.key === "Escape") {
      if (selection.size) {
        selection = new Set();
        refreshAnnotations();
      } else if (isToolArmed()) {
        state.annotate.tool = null;
        updateAnnoBar();
      }
      return;
    }

    const k = e.key.toLowerCase();
    if (k === "d") setTool("pen");
    else if (k === "h") setTool("highlighter");
    else if (k === "e") setTool("eraser");
    else if (k === "v" || k === "m") setTool("move");
    else if (k >= "1" && k <= String(ANNO_COLORS.length))
      pickColor(ANNO_COLORS[Number(k) - 1].value);
  });

  syncAnnoTransform();
  updateAnnoBar();
}
