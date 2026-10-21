// Notification inbox and activity feed: agents that finished or need you, automation runs,
// new worktrees — newest first, across every project. Opened from the status-bar bell.
import { For, Show, createMemo, createSignal } from "solid-js";
import { store, sessionLabel } from "../lib/store";
import { relTimeShort } from "../lib/platform";
import { Icon } from "./icons";
import type { InboxItem } from "../lib/types";

const ICON: Record<InboxItem["kind"], string> = { finished: "check", waiting: "bell", automation: "clock", worktree: "branch", error: "close" };

export function InboxPanel(props: { onClose: () => void }) {
  const [filter, setFilter] = createSignal<"all" | "unread">("all");
  const [query, setQuery] = createSignal("");
  const items = createMemo(() => {
    const q = query().trim().toLowerCase();
    return (store.state.inbox ?? []).filter((i) => (filter() === "all" || !i.read) && (!q || `${i.title} ${i.body}`.toLowerCase().includes(q)));
  });
  // Working agents stay on top: the feed is for catching up on everything else.
  const working = createMemo(() => Object.values(store.sessions).filter((s) => s.alive && s.status === "working" && s.kind !== "shell"));

  const open = (i: InboxItem) => {
    store.markInbox(i.id);
    if (i.sessionId && store.sessions[i.sessionId]) store.revealSession(i.sessionId);
    else if (i.projectId && store.state.projects.some((p) => p.id === i.projectId)) store.switchProject(i.projectId);
    props.onClose();
  };

  return (
    <div class="inbox" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div class="inbox-head">
        <b>Activity</b>
        <div class="toggles">
          <button class={`toggle${filter() === "all" ? " on" : ""}`} onClick={() => setFilter("all")}>All</button>
          <button class={`toggle${filter() === "unread" ? " on" : ""}`} onClick={() => setFilter("unread")}>Unread {store.unreadInbox() || ""}</button>
        </div>
        <span style={{ flex: 1 }} />
        <button class="link-btn" onClick={() => store.markInbox("all")}>Mark all read</button>
        <button class="link-btn" onClick={() => store.clearInbox()}>Clear</button>
      </div>
      <input class="text-input" placeholder="Filter" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} style={{ margin: "0 10px 8px", width: "calc(100% - 20px)" }} />
      <div class="inbox-list">
        <Show when={working().length}>
          <div class="group-label">Working now</div>
          <For each={working()}>
            {(s) => (
              <div class="inbox-item" onClick={() => { store.revealSession(s.id); props.onClose(); }}>
                <span class="dot working" />
                <span class="inbox-text"><span class="inbox-title">{sessionLabel(s)}</span><span class="inbox-body">{store.state.projects.find((p) => p.id === s.project_id)?.name ?? s.cwd}</span></span>
              </div>
            )}
          </For>
          <div class="group-label">Earlier</div>
        </Show>
        <For each={items()} fallback={<div class="muted">Nothing here yet. Agents that finish or need you while you look elsewhere show up here.</div>}>
          {(i) => (
            <div
              class={`inbox-item${i.read ? "" : " unread"} k-${i.kind}`}
              onClick={() => open(i)}
              onContextMenu={(e) => { e.preventDefault(); store.markInbox(i.id, !i.read); }}
              title={i.read ? "Right-click: mark unread" : "Right-click: mark read"}
            >
              <span class="inbox-icon"><Icon name={ICON[i.kind]} size={13} /></span>
              <span class="inbox-text">
                <span class="inbox-title">{i.title}</span>
                <span class="inbox-body">{i.body}</span>
              </span>
              <span class="age">{relTimeShort(i.at, Date.now())}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
