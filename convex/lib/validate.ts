/* =========================================================
   Static lint + deterministic repair for generated Mermaid.
   docs/AI_PIPELINE.md §7 stages B and C.

   ~70% of model mistakes are mechanical and fixable in code for $0. This runs
   before any LLM repair call. It is intentionally conservative: a repair that
   might change meaning is not applied, it's reported.

   What is NOT here yet: the real render check (stage E) needs a headless
   browser, which Convex can't run. Until the sidecar exists we rely on the
   static rules below plus the client's own error banner, which already falls
   back to the last valid render (js/render.js catch block).
========================================================= */

import { parseMermaidToSteps } from "../../shared/mermaidSteps.js";
import { ALL_TYPES, STEP_TYPES, ATOMIC_TYPES } from "./prompt";

const RESERVED_IDS = new Set([
  "end", "graph", "subgraph", "class", "click", "style", "linkStyle",
  "direction", "state", "note", "call", "default", "o", "x",
]);

const FORBIDDEN_LINE =
  /^\s*(classDef|class|style|linkStyle|click|callback|href)\b/i;

const DIRECTIVE_LINE = /^\s*%%\{.*\}%%\s*$/;

const BLOCK_OPEN =
  /^(subgraph|alt|opt|loop|par|and|critical|break|rect|box)\b/i;

export type ValidationResult = {
  ok: boolean;
  mermaid: string;
  narration: string[];
  stepCount: number;
  repairs: string[];
  errors: string[];
};

function headerType(header: string): string | null {
  const h = header.trim();
  for (const t of ALL_TYPES) {
    if (h === t || h.startsWith(t + " ") || h.startsWith(t + "\t")) return t;
  }
  // `graph TD` is the legacy alias for `flowchart TD`
  if (/^graph\s/i.test(h)) return "flowchart";
  return null;
}

/** Split `A --> B --> C` into two lines so each edge is its own frame. */
function splitChains(line: string): string[] | null {
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const body = line.trim();
  // Only touch simple flowchart edges with no labels/shapes in the middle.
  if (!/^[A-Za-z][\w]*(\s*(-->|---|==>)\s*[A-Za-z][\w]*){2,}$/.test(body)) return null;

  const parts = body.split(/\s*(-->|---|==>)\s*/);
  const out: string[] = [];
  for (let i = 0; i + 2 < parts.length; i += 2) {
    out.push(`${indent}${parts[i]} ${parts[i + 1]} ${parts[i + 2]}`);
  }
  return out.length > 1 ? out : null;
}

/**
 * `CPU --> Cache["a fast copy"]` becomes two lines: the declaration, then the
 * edge. Valid Mermaid either way, but this is what makes the node and the
 * relationship land in separate reveal frames.
 */
function hoistInlineDecl(
  line: string,
  declared: Set<string>,
): { decl: string; edge: string } | null {
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const m = line
    .trim()
    .match(
      /^([A-Za-z][\w]*)(\s*(?:-{2,3}>|-{3}|-\.->|={2,}>|--x|--o)(?:\|[^|]*\|)?\s*)([A-Za-z][\w]*)(\[.+\]|\(\(.+\)\)|\(.+\)|\{.+\}|>.+\])$/,
    );
  if (!m) return null;
  const [, left, arrow, rightId, shape] = m;
  if (declared.has(rightId)) return null;
  return {
    decl: `${indent}${rightId}${shape}`,
    edge: `${indent}${left}${arrow}${rightId}`,
  };
}

/** Quote a bracketed label that isn't already quoted. */
function quoteLabels(line: string): string {
  return line.replace(
    /(\[|\(\(|\(|\{)([^"\]\)\}][^\]\)\}]*)(\]|\)\)|\)|\})/g,
    (whole, open, inner, close) => {
      if (/^\s*"/.test(inner)) return whole;
      if (open === "{" && /^[A-Za-z_]\w*\s*$/.test(inner)) return whole; // class body etc.
      const cleaned = inner
        .replace(/["`<>|\\]/g, "")
        .replace(/&/g, "and")
        .trim();
      return `${open}"${cleaned}"${close}`;
    },
  );
}

export function validateAndRepair(
  rawMermaid: string,
  modelNarration: string[],
): ValidationResult {
  const repairs: string[] = [];
  const errors: string[] = [];

  let lines = String(rawMermaid).replace(/\r\n/g, "\n").split("\n");

  // Strip code fences the model sometimes leaves in despite instructions.
  lines = lines.filter((l) => !/^\s*```/.test(l));

  // --- header ------------------------------------------------------
  let headerIdx = lines.findIndex(
    (l) => l.trim() !== "" && !l.trim().startsWith("%%"),
  );
  if (headerIdx === -1) {
    return {
      ok: false, mermaid: rawMermaid, narration: [], stepCount: 0,
      repairs, errors: ["Diagram is empty."],
    };
  }
  const type = headerType(lines[headerIdx]);
  if (!type) {
    errors.push(`Unsupported diagram header: "${lines[headerIdx].trim()}"`);
  }

  // --- line-level pass ---------------------------------------------
  const declared = new Set<string>();
  const out: string[] = [];
  let blockDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") continue;

    if (DIRECTIVE_LINE.test(trimmed)) {
      repairs.push("Removed a %%{init}%% directive (app controls theming).");
      continue;
    }
    if (trimmed.startsWith("%%")) { out.push(line); continue; } // narration

    if (i > headerIdx && FORBIDDEN_LINE.test(trimmed)) {
      repairs.push(`Removed styling line: ${trimmed.slice(0, 40)}`);
      continue;
    }

    if (i === headerIdx) { out.push(line); continue; }

    let work = line;

    if (/^\s*END\s*$/.test(work)) {
      work = work.replace(/END/, "end");
      repairs.push("Lowercased a stray END.");
    }

    if (BLOCK_OPEN.test(work.trim())) blockDepth++;
    else if (work.trim().toLowerCase() === "end") blockDepth--;

    // Flowchart-only structural repairs
    if (type === "flowchart") {
      const chain = splitChains(work);
      if (chain) {
        repairs.push("Split a chained edge so each hop is its own reveal step.");
        for (const c of chain) out.push(c);
        continue;
      }
      const hoist = hoistInlineDecl(work, declared);
      if (hoist) {
        repairs.push(`Hoisted the declaration of "${hoist.decl.trim()}" onto its own step.`);
        declared.add(hoist.decl.trim().split(/[\[({>]/)[0]);
        out.push(hoist.decl, hoist.edge);
        continue;
      }
    }

    const quoted = quoteLabels(work);
    if (quoted !== work) {
      repairs.push("Added missing quotes around a label.");
      work = quoted;
    }

    // Track declarations so hoisting doesn't duplicate them
    const decl = work.trim().match(/^([A-Za-z][\w]*)\s*[\[({>]/);
    if (decl) declared.add(decl[1]);

    // Reserved-word IDs break the parser outright
    const idm = work.trim().match(/^([A-Za-z][\w]*)\b/);
    if (idm && RESERVED_IDS.has(idm[1].toLowerCase()) && type === "flowchart") {
      const safe = `node_${idm[1]}`;
      work = work.replace(new RegExp(`\\b${idm[1]}\\b`, "g"), safe);
      repairs.push(`Renamed reserved node id "${idm[1]}" to "${safe}".`);
    }

    out.push(work);
  }

  while (blockDepth > 0) {
    out.push("end");
    blockDepth--;
    repairs.push("Closed an unterminated block at end of diagram.");
  }
  if (blockDepth < 0) errors.push("More `end` keywords than opened blocks.");

  const mermaid = out.join("\n");

  // --- step + narration alignment ----------------------------------
  const parsed = parseMermaidToSteps(mermaid);
  const stepCount = parsed.steps.length;

  if (stepCount < 3) {
    errors.push(`Only ${stepCount} reveal steps — too thin to be useful.`);
  }
  if (stepCount > 40) {
    errors.push(`${stepCount} reveal steps — too many to step through.`);
  }

  // Prefer the inline `%% >` narration (guaranteed aligned by construction);
  // fall back to the model's array, padded or trimmed to fit.
  const inline = parsed.steps.map((s) => s.narration);
  const inlineComplete = inline.every((n) => n && n.length > 0);

  let narration: string[];
  if (inlineComplete) {
    narration = inline as string[];
  } else {
    const arr = Array.isArray(modelNarration) ? modelNarration : [];
    narration = Array.from({ length: stepCount }, (_, i) => inline[i] || arr[i] || "");
    const missing = narration.filter((n) => !n).length;
    if (missing) {
      repairs.push(`${missing} of ${stepCount} steps have no narration.`);
    }
  }

  // Atomic-only types must not claim step reveal
  const isAtomicType = (ATOMIC_TYPES as readonly string[]).includes(type ?? "");
  if (isAtomicType && stepCount > 1) {
    repairs.push(`${type} cannot be revealed step by step; forcing atomic mode.`);
  }

  return {
    ok: errors.length === 0,
    mermaid,
    narration,
    stepCount,
    repairs,
    errors,
  };
}

export function forcedRevealMode(
  diagramType: string,
  declared: "steps" | "atomic",
): "steps" | "atomic" {
  const base = diagramType.split(/\s/)[0];
  if ((ATOMIC_TYPES as readonly string[]).includes(base)) return "atomic";
  if (!(STEP_TYPES as readonly string[]).includes(base) && base !== "graph") {
    return "atomic";
  }
  return declared;
}
