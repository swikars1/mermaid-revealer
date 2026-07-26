/* The parser now lives in shared/ because the Convex backend must compute
   byte-identical step boundaries — it uses them to align narration with
   frames. If the two ever disagree, captions land on the wrong step.
   See docs/ENGINE_CHANGES.md §8. */
export {
  parseMermaidToSteps,
  sourceForPrefix,
  extractMermaidBlocksFromMarkdown,
} from "../shared/mermaidSteps.js";
