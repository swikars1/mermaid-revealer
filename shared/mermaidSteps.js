/* =========================================================
   CANONICAL Mermaid -> reveal-step parser.

   Imported by BOTH the browser client and the Convex backend.
   The server uses it to validate that every prefix renders and to
   align narration with steps; the client uses it to actually reveal.
   If these two ever disagree about where a step boundary is, narration
   attaches to the wrong frame. So: one file, two importers.

   Do not fork this. Do not "optimize" it on one side only.
========================================================= */

/**
 * @typedef {Object} Step
 * @property {string[]} add        Lines added at this step (>1 for grouped blocks)
 * @property {string}   label      Raw first line, for debugging / nav tooltips
 * @property {string|null} narration  Plain-English caption for this step
 */

/**
 * @typedef {Object} Parsed
 * @property {string}   header      First real line, e.g. "flowchart TD"
 * @property {string[]} directives  Leading %%{init:...}%% lines (kept, not revealed)
 * @property {Step[]}   steps
 */

/** Narration comment the AI emits before each reveal line: `%% > text` */
const NARRATION_RE = /^%%\s*>\s?(.*)$/;

/** `%%{init: {...}}%%` and friends. Captured, never turned into a step. */
const DIRECTIVE_RE = /^%%\{.*\}%%\s*$/;

/**
 * Lines that change styling/metadata but render nothing new. Revealing one
 * of these produces a dead frame (user presses -> and nothing moves), so we
 * attach them to the NEXT real step instead of giving them their own.
 */
const NON_VISUAL_RE =
  /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i;

/** Blocks that must be revealed atomically or the prefix is invalid. */
const BLOCK_START_RE =
  /^(subgraph|alt|opt|loop|par|and|critical|break|rect|box|state\s+\w+\s*\{?)\b/i;

/**
 * @param {string} source Raw mermaid source, may contain narration comments
 * @returns {Parsed}
 */
export function parseMermaidToSteps(source) {
  const rawLines = String(source).replace(/\r\n/g, "\n").split("\n");

  // --- header + leading directives ---------------------------------
  const directives = [];
  let idx = 0;
  while (idx < rawLines.length) {
    const t = rawLines[idx].trim();
    if (t === "") { idx++; continue; }
    if (DIRECTIVE_RE.test(t)) { directives.push(t); idx++; continue; }
    if (t.startsWith("%%")) { idx++; continue; } // stray comment above header
    break;
  }
  const header = rawLines[idx] !== undefined ? rawLines[idx].trim() : "graph TD";
  const rest = rawLines.slice(idx + 1);

  // --- body --------------------------------------------------------
  /** @type {Step[]} */
  const steps = [];
  let buffer = [];        // lines of an in-progress block
  let depth = 0;          // block nesting depth
  let pendingNarration = null;
  let attachments = [];   // non-visual lines waiting for the next real step

  const push = (add, label, narration) => {
    steps.push({
      add: attachments.length ? [...attachments, ...add] : add,
      label,
      narration: narration ?? null,
    });
    attachments = [];
  };

  for (const line of rest) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    // narration always applies to the next revealed thing, even inside blocks
    const narr = NARRATION_RE.exec(trimmed);
    if (narr) {
      // Inside a block we ignore extra narrations — the block is one step and
      // already took the narration that preceded its opening line.
      if (depth === 0) pendingNarration = narr[1].trim();
      continue;
    }
    if (trimmed.startsWith("%%")) continue; // ordinary comment / directive

    const opensBrace = /\{\s*$/.test(trimmed) && !trimmed.startsWith("}");
    const isStart = BLOCK_START_RE.test(trimmed) || opensBrace;
    const isEnd = trimmed.toLowerCase() === "end" || trimmed === "}";

    if (depth > 0) {
      buffer.push(line);
      if (isStart) depth++;
      if (isEnd) {
        depth--;
        if (depth === 0) {
          push(buffer.slice(), buffer[0].trim(), pendingNarration);
          pendingNarration = null;
          buffer = [];
        }
      }
      continue;
    }

    if (NON_VISUAL_RE.test(trimmed)) {
      attachments.push(line);
      continue;
    }

    if (isStart) {
      buffer.push(line);
      depth++;
      continue;
    }

    push([line], trimmed, pendingNarration);
    pendingNarration = null;
  }

  // unterminated block at EOF — emit what we have rather than losing it
  if (buffer.length) {
    push(buffer.slice(), buffer[0].trim(), pendingNarration);
  } else if (attachments.length && steps.length) {
    steps[steps.length - 1].add.push(...attachments);
  }

  return { header, directives, steps };
}

/** Reassemble the full source for a given prefix length (0 = header only). */
export function sourceForPrefix(parsed, stepCount) {
  const lines = [...parsed.directives, parsed.header];
  for (let i = 0; i < stepCount && i < parsed.steps.length; i++) {
    lines.push(...parsed.steps[i].add);
  }
  return lines.join("\n");
}

export function extractMermaidBlocksFromMarkdown(text) {
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim());
  return blocks;
}
