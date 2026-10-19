// Git status for the active project, shared by the explorer (decorations) and the source
// control panel. Refreshed on watcher events, debounced, one request in flight at a time.
import { createRoot, createSignal } from "solid-js";
import { gitStatus, onEvent } from "./ipc";
import type { GitStatus } from "./types";

const DEBOUNCE_MS = 300;

function createGitState() {
  const [status, setStatus] = createSignal<GitStatus | null>(null);
  let root: string | null = null;
  let timer = 0;
  let inFlight = false;
  let again = false;

  async function refresh() {
    if (!root) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const r = root;
    try {
      const st = await gitStatus(r);
      if (r === root) setStatus(st);
    } catch {
      if (r === root) setStatus(null);
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        void refresh();
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), DEBOUNCE_MS);
  }

  void onEvent<{ root: string; git: boolean }>("fs-changed", (e) => {
    if (e.git && e.root === root) schedule();
  });

  function setRoot(next: string | null) {
    if (next === root) return;
    root = next;
    setStatus(null);
    void refresh();
  }

  /** path → status letter for decorations (worktree change wins over index change). */
  function decorations(): Map<string, string> {
    const map = new Map<string, string>();
    const st = status();
    if (!st) return map;
    for (const f of st.files) {
      const letter = f.index === "U" ? "C" : f.index === "?" ? "U" : f.worktree !== "." ? f.worktree : f.index;
      map.set(f.path, letter);
      // Mark ancestor folders.
      let i = f.path.lastIndexOf("/");
      while (i > 0) {
        const dir = f.path.slice(0, i);
        if (!map.has(dir)) map.set(dir, "•");
        i = dir.lastIndexOf("/");
      }
    }
    return map;
  }

  return { status, refresh, schedule, setRoot, decorations };
}

export const gitState = createRoot(createGitState);
