import { Show, createMemo } from "solid-js";
import { store } from "../lib/store";
import { Icon } from "./icons";
import { MemoryMeter, UsageMeters } from "./usage-meter";

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
  // The sidebar's branch summary (debounced `git status -uno`) — never a second full status:
  // on a large repository each full status takes seconds.
  const branch = () => {
    const p = store.activeProject();
    const info = p && store.projectInfo[p.id];
    return info?.is_repo ? info.branch ?? "detached" : null;
  };

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
      <Show when={store.state.settings.usageMeters}><UsageMeters /></Show>
      <Show when={store.state.settings.memoryMeter}><MemoryMeter /></Show>
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
