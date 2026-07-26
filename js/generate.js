import { convex, backendReady } from "./convexClient.js";
import { state, getDeviceId } from "./state.js";
import { setTopics } from "./topics.js";
import { startAutoPlay } from "./render.js";
import { escapeHtml } from "./utils.js";

const api = {
  submit: "generate:submit",
  status: "generate:status",
  project: "projects:get",
  recent: "projects:listRecent",
  remove: "projects:remove",
};

let statusUnsub = null;
let recentUnsub = null;

function el(id) {
  return document.getElementById(id);
}

function setStatus(text, kind = "info") {
  const box = el("genStatus");
  if (!box) return;
  box.textContent = text || "";
  box.className = `gen-status ${kind}` + (text ? " visible" : "");
}

function setBusy(busy) {
  const btn = el("genBtn");
  const input = el("genUrl");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "Working…" : "Generate";
  }
  if (input) input.disabled = busy;
}

/* ---------------------------------------------------------
   Loading a project into the revealer
--------------------------------------------------------- */

export async function loadProject(projectId, { autoplay = false } = {}) {
  if (!convex) return;
  const project = await convex.query(api.project, { projectId });
  if (!project) {
    setStatus("That project no longer exists.", "error");
    return;
  }

  state.projectId = projectId;
  const count = setTopics(project.diagrams);

  const titleEl = el("projectTitle");
  if (titleEl) {
    titleEl.textContent = project.title;
    titleEl.href = project.sourceUrl ?? "#";
    titleEl.classList.toggle("hidden", !project.title);
  }

  setStatus(`${count} diagram${count === 1 ? "" : "s"} ready.`, "ok");
  convex.mutation("projects:touch", { projectId }).catch(() => {});

  // Play the first diagram through once so the user sees the idea assemble
  // itself, then reset and hand over the controls. This is the whole demo.
  if (autoplay && !state.hasAutoPlayedThisProject) {
    state.hasAutoPlayedThisProject = true;
    setTimeout(() => startAutoPlay(2000), 600);
  }
  return project;
}

/* ---------------------------------------------------------
   Generation
--------------------------------------------------------- */

/**
 * The pipeline runs detached on the Convex scheduler, so this reactive
 * subscription is the only thing driving the UI while it works — stage text
 * arrives as the backend writes it, and `projectId` appears at the end.
 */
function watchStatus(generationId, deviceId) {
  statusUnsub?.();
  const stop = () => {
    statusUnsub?.();
    statusUnsub = null;
    setBusy(false);
  };

  statusUnsub = convex.onUpdate(
    api.status,
    { generationId, deviceId },
    async (s) => {
      if (!s) return;

      if (s.status === "failed") {
        setStatus(s.failureMessage ?? "Generation failed.", "error");
        // Offer the paste path rather than leaving them at a dead end.
        if (FALLBACK_CODES.has(s.failureCode)) showFallback(true);
        stop();
        return;
      }

      if (s.status === "complete") {
        // The fork is a separate mutation, so `complete` can land a beat
        // before the project row exists. Wait for the id.
        if (!s.projectId) return;
        const secs = s.durationMs ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : "";
        setStatus(`${s.stage}${secs}`, "ok");
        stop();
        state.hasAutoPlayedThisProject = false;
        await loadProject(s.projectId, { autoplay: true });
        return;
      }

      setStatus(s.stage, "info");
    },
  );
}

/** Codes where fetching will keep failing but a pasted transcript won't. */
const FALLBACK_CODES = new Set([
  "RATE_LIMITED",
  "NO_TRANSCRIPT",
  "ALL_PROVIDERS_FAILED",
  "FETCH_BLOCKED",
  "FETCH_FAILED",
]);

function showFallback(show) {
  el("fallbackPanel")?.classList.toggle("open", show);
  if (show) el("fallbackText")?.focus();
}

async function submit(url, force = false, transcript = undefined) {
  if (!convex) return;
  setBusy(true);
  setStatus("Starting…", "info");
  if (!transcript) showFallback(false);

  try {
    const deviceId = getDeviceId();
    const { generationId, projectId, cached } = await convex.action(api.submit, {
      url,
      deviceId,
      force,
      transcript,
    });

    if (cached && projectId) {
      setStatus("⚡ Instant — this video was already mapped.", "ok");
      state.hasAutoPlayedThisProject = false;
      await loadProject(projectId, { autoplay: true });
      setBusy(false);
      return;
    }

    // Not cached: the job is running on the scheduler. Watch it.
    watchStatus(generationId, deviceId);
  } catch (e) {
    setStatus(e?.message ?? String(e), "error");
    setBusy(false);
  }
}

/* ---------------------------------------------------------
   Recent projects list
--------------------------------------------------------- */

function refreshRecent() {
  if (!convex) return;
  recentUnsub?.();
  recentUnsub = convex.onUpdate(
    api.recent,
    { deviceId: getDeviceId(), limit: 20 },
    (rows) => renderRecent(rows ?? []),
  );
}

function renderRecent(rows) {
  const list = el("recentList");
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="empty-note">No generated projects yet.</div>';
    return;
  }
  list.innerHTML = rows
    .map(
      (p) => `
      <div class="recent-item" data-id="${p._id}">
        <span class="recent-title">${escapeHtml(p.title)}</span>
        <span class="recent-del" data-del="${p._id}" title="Delete">&times;</span>
      </div>`,
    )
    .join("");

  list.querySelectorAll(".recent-item").forEach((node) => {
    node.addEventListener("click", (e) => {
      if (e.target.closest("[data-del]")) return;
      state.hasAutoPlayedThisProject = false;
      loadProject(node.dataset.id, { autoplay: false });
    });
  });
  list.querySelectorAll("[data-del]").forEach((node) => {
    node.addEventListener("click", async (e) => {
      e.stopPropagation();
      await convex.mutation(api.remove, { projectId: node.dataset.del });
    });
  });
}

/* ---------------------------------------------------------
   Init
--------------------------------------------------------- */

export function initGenerate() {
  const panel = el("genPanel");
  if (!backendReady) {
    if (panel) {
      panel.classList.add("disabled");
      setStatus(
        "Backend not configured — set VITE_CONVEX_URL to enable YouTube generation.",
        "warn",
      );
    }
    return;
  }

  const input = el("genUrl");
  const btn = el("genBtn");

  const go = () => {
    const url = input.value.trim();
    if (!url) return setStatus("Paste a YouTube URL first.", "warn");
    submit(url, false);
  };

  btn?.addEventListener("click", go);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  el("genRegen")?.addEventListener("click", () => {
    const url = input.value.trim();
    if (url) submit(url, true);
  });

  el("genPaste")?.addEventListener("click", () => {
    const open = el("fallbackPanel")?.classList.contains("open");
    showFallback(!open);
  });
  el("fallbackCancel")?.addEventListener("click", () => showFallback(false));
  el("fallbackGo")?.addEventListener("click", () => {
    const url = input.value.trim();
    const text = el("fallbackText").value.trim();
    if (!url) return setStatus("Paste the video URL too — it's the cache key.", "warn");
    if (text.split(/\s+/).length < 120) {
      return setStatus("That transcript looks too short to build diagrams from.", "warn");
    }
    showFallback(false);
    submit(url, true, text);
  });

  refreshRecent();

  // Deep link: /?p=<projectId>
  const pid = new URLSearchParams(location.search).get("p");
  if (pid) loadProject(pid, { autoplay: true }).catch(() => {});
}
