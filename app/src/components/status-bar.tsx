import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { store } from "../lib/store";
import { Icon } from "./icons";
import { MemoryMeter, UsageMeters } from "./usage-meter";
import { InboxPanel } from "./inbox";

export function StatusBar() {
  const [inbox, setInbox] = createSignal(false);
  onMount(() => {
    const close = () => setInbox(false);
    const open = () => setInbox(true);
    window.addEventListener("pointerdown", close);
    window.addEventListener("erka:inbox", open);
    onCleanup(() => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("erka:inbox", open);
    });
  });
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
      <span class={`item clickable${awake() !== "off" ? " on" : ""}`} title={AWAKE_TITLE[awake()]} onClick={cycleAwake}>
        <Icon name="coffee" size={13} />
        <Show when={awake() !== "off"}>{awake() === "agents" ? "agents" : "on"}</Show>
      </span>
      <Show when={store.state.settings.floatingTerminal}>
        <span class={`item clickable${store.state.floating?.open ? " on" : ""}`} title="Floating terminal" onClick={() => store.toggleFloating()}>
          <Icon name="float" size={13} />
        </span>
      </Show>
      <span class="item clickable inbox-anchor" title="Activity and notifications" onPointerDown={(e) => e.stopPropagation()} onClick={() => setInbox(!inbox())}>
        <Icon name="bell" size={13} />
        <Show when={store.unreadInbox()}><span class="badge waiting">{store.unreadInbox()}</span></Show>
        <Show when={inbox()}><InboxPanel onClose={() => setInbox(false)} /></Show>
      </span>
    </div>
  );
}

const AWAKE_TITLE = {
  off: "Keep computer awake: off (click: while agents work)",
  agents: "Keep computer awake while an agent is working (click: always)",
  always: "Keep computer awake: always (click: off)",
} as const;

const awake = () => store.state.settings.keepAwake ?? "off";

function cycleAwake() {
  const order = ["off", "agents", "always"] as const;
  store.setSettings({ keepAwake: order[(order.indexOf(awake()) + 1) % order.length] });
}
