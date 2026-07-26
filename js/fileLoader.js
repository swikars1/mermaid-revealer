import { state } from "./state.js";
import { addTopic } from "./topics.js";
import { extractMermaidBlocksFromMarkdown } from "./parser.js";
import { buildNav } from "./nav.js";
import { renderEmpty } from "./render.js";

/* =========================================================
   File loading
========================================================= */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    try {
      const text = await readFile(file);
      const name = file.name.replace(/\.[^/.]+$/, "");
      if (/\.(md|markdown)$/i.test(file.name)) {
        const blocks = extractMermaidBlocksFromMarkdown(text);
        if (blocks.length === 0) {
          alert(`No \`\`\`mermaid code fences found in "${file.name}".`);
          continue;
        }
        blocks.forEach((b, i) => {
          addTopic(blocks.length > 1 ? `${name} (${i + 1})` : name, b);
        });
      } else {
        addTopic(name, text);
      }
    } catch (err) {
      console.error(err);
      alert(`Couldn't read "${file.name}".`);
    }
  }
}

export function initFileLoader() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    handleFiles(e.target.files);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    }),
  );
  dropzone.addEventListener("drop", (e) => {
    handleFiles(e.dataTransfer.files);
  });

  /* also allow dropping anywhere on the stage */
  const stageWrapEl = document.querySelector(".stage-wrap");
  ["dragenter", "dragover"].forEach((ev) =>
    stageWrapEl.addEventListener(ev, (e) => e.preventDefault()),
  );
  stageWrapEl.addEventListener("drop", (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });

  /* ---- Paste panel ---- */
  const pastePanel = document.getElementById("pastePanel");
  document.getElementById("pasteToggle").addEventListener("click", () => {
    pastePanel.classList.toggle("open");
  });
  document.getElementById("pasteCancel").addEventListener("click", () => {
    pastePanel.classList.remove("open");
    document.getElementById("pasteTitle").value = "";
    document.getElementById("pasteText").value = "";
  });
  document.getElementById("pasteAdd").addEventListener("click", () => {
    const title =
      document.getElementById("pasteTitle").value.trim() ||
      `Diagram ${state.topics.length + 1}`;
    const text = document.getElementById("pasteText").value;
    if (!text.trim()) {
      alert("Paste some Mermaid source first.");
      return;
    }
    if (!addTopic(title, text)) {
      alert("Could not parse any steps from that source.");
      return;
    }
    pastePanel.classList.remove("open");
    document.getElementById("pasteTitle").value = "";
    document.getElementById("pasteText").value = "";
  });

  document.getElementById("clearAll").addEventListener("click", () => {
    if (state.topics.length && !confirm("Remove all loaded diagrams?")) return;
    const items = document.querySelectorAll(".nav-item");
    if (items.length) {
      items.forEach((el) => el.classList.add("nav-leave"));
      setTimeout(() => {
        state.topics = [];
        state.currentTopic = -1;
        buildNav();
        renderEmpty();
      }, 280);
    } else {
      state.topics = [];
      state.currentTopic = -1;
      buildNav();
      renderEmpty();
    }
  });
}
