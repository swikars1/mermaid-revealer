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

export function extractMermaidBlocksFromMarkdown(text) {
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim());
  return blocks;
}
