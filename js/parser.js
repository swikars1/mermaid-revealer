/* =========================================================
   Generic mermaid source -> incremental steps parser.
   Groups nested blocks (subgraph/end, alt/opt/loop/.../end,
   class braces) into a single atomic reveal step so every
   intermediate render stays syntactically valid.
========================================================= */
export function parseMermaidToSteps(source) {
  const rawLines = source.replace(/\r\n/g, "\n").split("\n");
  let idx = 0;
  while (
    idx < rawLines.length &&
    (rawLines[idx].trim() === "" || rawLines[idx].trim().startsWith("%%"))
  )
    idx++;
  const header = rawLines[idx] !== undefined ? rawLines[idx] : "graph TD";
  const rest = rawLines.slice(idx + 1);

  const steps = [];
  let buffer = [];
  let depth = 0;
  const blockStart =
    /^(subgraph|alt|opt|loop|par|and|critical|break|rect|state\s+\w+\s*\{?)\b/i;

  for (const line of rest) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("%%")) continue;

    const lower = trimmed.toLowerCase();
    const opensBrace = /\{\s*$/.test(trimmed) && !trimmed.startsWith("}");
    const isStart = blockStart.test(lower) || opensBrace;
    const isEnd = lower === "end" || trimmed === "}";

    if (depth > 0) {
      buffer.push(line);
      if (isStart) depth++;
      if (isEnd) {
        depth--;
        if (depth === 0) {
          steps.push({ add: buffer.slice(), label: buffer[0].trim() });
          buffer = [];
        }
      }
      continue;
    }

    if (isStart) {
      buffer.push(line);
      depth++;
      continue;
    }

    steps.push({ add: [line], label: trimmed });
  }
  if (buffer.length)
    steps.push({ add: buffer.slice(), label: buffer[0].trim() });

  return { header, steps };
}

/* =========================================================
   Long-label wrapping

   Mermaid 10's `flowchart.wrappingWidth` is a no-op for HTML labels —
   it renders them into a `white-space: nowrap` div, so a long label
   becomes one very wide node. Inserting explicit <br/> is the only
   thing that actually wraps, and because it happens *before* Mermaid
   measures the label, the node box is sized correctly around it.

   This runs on the generated definition at render time rather than on
   the stored source, so the user's own Mermaid stays exactly as typed.
========================================================= */
const WRAP_AT = 26; // chars per line before a label is broken up

function breakText(text) {
  // Already hand-wrapped, or an entity/tag we shouldn't touch.
  if (/<br\s*\/?>/i.test(text)) return text;
  if (text.length <= WRAP_AT) return text;

  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (!line.length) {
      line = word;
    } else if (line.length + 1 + word.length <= WRAP_AT) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length) lines.push(line);
  return lines.length > 1 ? lines.join("<br/>") : text;
}

/* Only quoted labels are touched. Unquoted bracket text can contain
   arbitrary Mermaid syntax (link targets, shape modifiers, class
   assignments), and rewriting inside it risks producing a definition
   that no longer parses — a quoted string is unambiguously a label. */
export function wrapLongLabels(def) {
  return def.replace(/"([^"\n]*)"/g, (match, inner) => {
    const wrapped = breakText(inner);
    return wrapped === inner ? match : `"${wrapped}"`;
  });
}

export function extractMermaidBlocksFromMarkdown(text) {
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim());
  return blocks;
}
