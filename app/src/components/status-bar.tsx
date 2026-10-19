import { Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { store } from "../lib/store";
import { gitStatus, onEvent } from "../lib/ipc";
import { Icon } from "./icons";

export function StatusBar() {
  const counts = createMemo(() => {
    let alive = 0, working = 0, waiting = 0;
    for (const s of Object.values(store.sessions)) {
      if (!s.alive) continue;
      alive++;
      if (s.status === "working") working++;
      if (s.status === "waiting") waiting++;
    }
    return { alive, working, waiting };
  });
  const [gitTick, setGitTick] = createSignal(0);
  const unlisten = onEvent<{ root: string; git: boolean }>("fs-changed", (e) => e.git && e.root === store.activeProject()?.path && setGitTick((t) => t + 1));
  onCleanup(() => void unlisten.then((f) => f()));
  const [branch] = createResource(
    () => (store.activeProject() ? { path: store.activeProject()!.path, t: gitTick() } : null),
    (k) => gitStatus(k.path).then((s) => (s.is_repo ? s.branch ?? "detached" : null)).catch(() => null),
  );

  return (
    <div class="statusbar">
      <span class="item" title={store.connected() ? "Session daemon connected" : "Session daemon not connected"}>
        <span class={`conn${store.connected() ? " on" : ""}`} />
        {store.connected() ? "erkad" : "erkad offline"}
      </span>
      <Show when={branch()}>
        <span class="item clickable" onClick={() => store.setRightPanel("git")}><Icon name="git" size={13} /> {branch()}</span>
      </Show>
      <span class="spacer" />
      <Show when={store.lastSwitchMs() != null}>
        <span class="item" title="Time to render the last project switch">switch {store.lastSwitchMs()} ms</span>
      </Show>
      <span class="item clickable" onClick={() => store.setOverlay("dashboard")}>
        {counts().alive} sessions
        <Show when={counts().working}> · <span style={{ color: "var(--working)" }}>{counts().working} working</span></Show>
        <Show when={counts().waiting}> · <span style={{ color: "var(--waiting)" }}>{counts().waiting} need you</span></Show>
      </span>
    </div>
  );
}
