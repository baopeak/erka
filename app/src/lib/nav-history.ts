// Back / Forward through recently focused places (project → tab → pane), like an editor's
// navigation history. Records only real moves; entries whose tab or pane is gone are skipped.
import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { store } from "./store";
import { allPanes } from "./layout";

interface Place {
  projectId: string;
  tabId: string;
  paneId: string;
}

const MAX = 50;
const same = (a: Place | undefined, b: Place) => !!a && a.projectId === b.projectId && a.tabId === b.tabId && a.paneId === b.paneId;

const [stack, setStack] = createSignal<Place[]>([]);
const [index, setIndex] = createSignal(-1);
/** Set while we move ourselves, so the move is not recorded as a new place. */
let navigating = false;

function current(): Place | null {
  const projectId = store.state.activeProject;
  const tab = projectId ? store.activeTab(projectId) : undefined;
  return projectId && tab ? { projectId, tabId: tab.id, paneId: tab.focus } : null;
}

function exists(p: Place): boolean {
  const tab = store.workspace(p.projectId).tabs.find((t) => t.id === p.tabId);
  return !!tab && allPanes(tab.root).some((x) => x.id === p.paneId);
}

export function startNavHistory() {
  createRoot(() => {
    // Only a change of place counts, not every store update that recomputes it.
    const place = createMemo(current, null, { equals: (a, b) => (a && b ? same(a, b) : a === b) });
    createEffect(on(place, (place) => {
      if (!place || navigating) return;
      const list = stack().slice(0, index() + 1);
      if (same(list[list.length - 1], place)) return;
      list.push(place);
      if (list.length > MAX) list.shift();
      setStack(list);
      setIndex(list.length - 1);
    }));
  });
}

function go(delta: -1 | 1) {
  let i = index() + delta;
  const list = stack();
  while (i >= 0 && i < list.length && !exists(list[i])) i += delta;
  if (i < 0 || i >= list.length) return;
  const p = list[i];
  navigating = true;
  try {
    store.switchProject(p.projectId);
    store.focusPane(p.projectId, p.tabId, p.paneId);
  } finally {
    navigating = false;
  }
  setIndex(i);
}

export const navBack = () => go(-1);
export const navForward = () => go(1);
export const canGoBack = () => index() > 0;
export const canGoForward = () => index() < stack().length - 1;
