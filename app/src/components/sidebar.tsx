// Project sidebar: every project with its sessions (status, task title, model, last activity),
// branch subtitle, filter/sort, and context menus. Each row binds only to its own session's
// fields, so status ticks from 20 agents re-render single rows, not the list.
import { For, Show, createMemo, createSignal } from "solid-js";
import { store, sessionLabel } from "../lib/store";
import { pickProjectFolder, chordOf, commands } from "../lib/commands";
import { chordLabel, isMac, relTimeShort } from "../lib/platform";
import { revealEntry } from "../lib/ipc";
import { switchToChat, switchToTerminal, supportsChat } from "../chat/mode-switch";
import { daemon } from "../lib/ipc";
import { Icon, KindGlyph } from "./icons";
import { openContextMenu, type MenuItem } from "./context-menu";
import type { Project, SessionInfo } from "../lib/types";

export function StatusDot(props: { s: SessionInfo }) {
  return <span class={`dot ${props.s.alive ? props.s.status : "exited"}${props.s.unread ? " unread" : ""}`} title={props.s.alive ? props.s.status : "exited"} />;
}

/** Row being renamed inline: `s:<session id>` or `p:<project id>`. */
const [renaming, setRenaming] = createSignal<string | null>(null);

function RenameInput(props: { value: string; onDone: (value: string | null) => void }) {
  let done = false;
  const finish = (v: string | null) => {
    if (done) return;
    done = true;
    setRenaming(null);
    props.onDone(v);
  };
  return (
    <input
      class="rename-input"
      value={props.value}
      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/** Ticks every 30 s so relative ages stay fresh without per-row timers. */
const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 30_000);

export const shortModel = (m: string | null | undefined) =>
  m ? m.replace(/^(claude|anthropic)[-/]/i, "").replace(/^openai[-/]/i, "").replace(/\[.*\]$/, "") : "";

function projectSessions(projectId: string): SessionInfo[] {
  return Object.values(store.sessions)
    .filter((s) => s.project_id === projectId)
    .sort((a, b) => a.created_at - b.created_at);
}

const lastActivity = (projectId: string) =>
  projectSessions(projectId).reduce((m, s) => Math.max(m, s.last_activity || s.created_at), 0);

async function inPane(s: SessionInfo, fn: typeof switchToChat) {
  store.revealSession(s.id);
  const loc = store.paneLocation(s.id);
  const project = loc && store.state.projects.find((p) => p.id === loc.projectId);
  const tab = loc && store.workspace(loc.projectId).tabs.find((t) => t.id === loc.tabId);
  if (!loc || !project || !tab) return;
  const walk = (n: import("../lib/types").LayoutNode): import("../lib/types").Pane | undefined =>
    n.type === "leaf" ? (n.pane.id === loc.paneId ? n.pane : undefined) : walk(n.a) ?? walk(n.b);
  const pane = walk(tab.root);
  if (pane) await fn(project, tab, pane);
}

function sessionMenu(s: SessionInfo): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Rename…", run: () => setRenaming(`s:${s.id}`) },
    s.unread ? { label: "Mark as read", run: () => void store.markUnread(s.id, false) } : { label: "Mark as unread", run: () => void store.markUnread(s.id, true) },
  ];
  if (!s.alive && !s.chat) items.push({ label: s.agent_session_id ? "Resume" : "Restart", run: () => void daemon("session.restart", { handle: s.handle }).catch((e) => store.notify(String(e))) });
  if (s.alive && supportsChat(s.kind)) {
    items.push(s.chat ? { label: "Continue in terminal (TUI)", run: () => void inPane(s, switchToTerminal) } : { label: "Continue in chat view", run: () => void inPane(s, switchToChat) });
  }
  items.push(null, {
    label: s.alive ? "Stop and close" : "Close", danger: true,
    run: () => {
      const loc = store.paneLocation(s.id);
      if (s.alive && s.kind !== "shell" && !confirm(`Stop ${sessionLabel(s)}?`)) return;
      if (loc) void store.closePane(loc.projectId, loc.tabId, loc.paneId);
      else void daemon("session.close", { handle: s.handle }).catch((e) => store.notify(String(e)));
    },
  });
  return items;
}

function projectMenu(p: Project): MenuItem[] {
  const folded = !!store.state.collapsed?.[p.id];
  return [
    { label: "Rename…", run: () => setRenaming(`p:${p.id}`) },
    { label: folded ? "Show sessions" : "Hide sessions", run: () => store.setCollapsed(p.id, !folded) },
    { label: isMac ? "Reveal in Finder" : "Reveal in Explorer", run: () => void revealEntry(p.path, "") },
    { label: "Move up", run: () => store.moveProject(p.id, -1) },
    { label: "Move down", run: () => store.moveProject(p.id, 1) },
    null,
    { label: "Remove from Erka", danger: true, run: () => { if (confirm(`Remove ${p.name} from the sidebar? Files and running sessions are not touched.`)) store.removeProject(p.id); } },
  ];
}

function SessionRow(props: { s: SessionInfo }) {
  return (
    <div
      class={`session-row${store.isSessionVisible(props.s.id) ? " visible" : ""}`}
      onClick={() => store.revealSession(props.s.id)}
      onContextMenu={(e) => openContextMenu(e, sessionMenu(props.s))}
      title={[props.s.title, props.s.model, props.s.cwd].filter(Boolean).join("\n")}
    >
      <StatusDot s={props.s} />
      <KindGlyph kind={props.s.kind} size={14} />
      <span class="session-text">
        <Show when={renaming() === `s:${props.s.id}`} fallback={<span class="name">{sessionLabel(props.s)}</span>}>
          <RenameInput value={props.s.name ?? sessionLabel(props.s)} onDone={(v) => v !== null && void store.renameSession(props.s.id, v.trim() || null)} />
        </Show>
        <Show when={props.s.model}><span class="model">{shortModel(props.s.model)}</span></Show>
      </span>
      <span class="age">{relTimeShort(props.s.last_activity || props.s.created_at, now())}</span>
    </div>
  );
}

function ProjectRow(props: { project: Project }) {
  const index = createMemo(() => store.state.projects.indexOf(props.project));
  const active = () => store.state.activeProject === props.project.id;
  const sessions = createMemo(() => projectSessions(props.project.id));
  const counts = createMemo(() => {
    let working = 0, waiting = 0, unread = 0;
    for (const s of sessions()) {
      if (!s.alive) continue;
      if (s.status === "waiting") waiting++;
      else if (s.status === "working") working++;
      else if (s.unread) unread++;
    }
    return { working, waiting, unread };
  });
  const folded = () => !!store.state.collapsed?.[props.project.id];
  const info = () => store.projectInfo[props.project.id];
  const collapsedSidebar = () => store.state.settings.sidebarCollapsed;
  const switchChord = () => {
    const c = commands.find((x) => x.id === `project.${index() + 1}`);
    return c && chordOf(c) ? chordLabel(chordOf(c)!) : "";
  };

  return (
    <div class={`project-block${active() ? " active" : ""}`}>
      <div
        class={`project${active() ? " active" : ""}`}
        onClick={() => store.switchProject(props.project.id)}
        onContextMenu={(e) => openContextMenu(e, projectMenu(props.project))}
        title={`${props.project.path}${index() < 9 ? `  (${switchChord()})` : ""}`}
      >
        <Show when={!collapsedSidebar() && sessions().length}>
          <button class="chev" title={folded() ? "Show sessions" : "Hide sessions"} onClick={(e) => { e.stopPropagation(); store.setCollapsed(props.project.id, !folded()); }}>
            <Icon name={folded() ? "chevronRight" : "chevronDown"} size={11} />
          </button>
        </Show>
        <span class="project-swatch" style={{ background: props.project.color }}>{props.project.name.slice(0, 1).toUpperCase()}</span>
        <Show when={!collapsedSidebar()}>
          <span class="project-text">
            <Show when={renaming() === `p:${props.project.id}`} fallback={<span class="project-name">{props.project.name}</span>}>
              <RenameInput value={props.project.name} onDone={(v) => v?.trim() && store.renameProject(props.project.id, v.trim())} />
            </Show>
            <Show when={info()?.is_repo}>
              <span class="project-sub">
                <Icon name="branch" size={10} />
                {info()!.branch ?? "detached"}{info()!.dirty ? "*" : ""}
                <Show when={info()!.ahead || info()!.behind}> ↑{info()!.ahead}↓{info()!.behind}</Show>
              </span>
            </Show>
          </span>
          <span class="project-badges">
            <Show when={counts().waiting}><span class="badge waiting" title="Needs you">{counts().waiting}</span></Show>
            <Show when={counts().working}><span class="badge working" title="Working">{counts().working}</span></Show>
            <Show when={counts().unread}><span class="badge unread" title="Finished, unread">{counts().unread}</span></Show>
          </span>
        </Show>
        <Show when={collapsedSidebar() && (counts().waiting || counts().unread)}>
          <span class={`mini-dot ${counts().waiting ? "waiting" : "unread"}`} />
        </Show>
      </div>
      <Show when={!collapsedSidebar() && !folded() && sessions().length}>
        <div class="session-list">
          <For each={sessions()}>{(s) => <SessionRow s={s} />}</For>
        </div>
      </Show>
    </div>
  );
}

const FILTERS = { all: "All projects", running: "Projects with running sessions", attention: "Projects that need you" } as const;

export function Sidebar() {
  const collapsed = () => store.state.settings.sidebarCollapsed;
  const searchChord = () => {
    const c = commands.find((x) => x.id === "palette");
    return c && chordOf(c) ? chordLabel(chordOf(c)!) : "";
  };
  // Store proxies are stable, so returning the previous array when the order is unchanged
  // keeps <For> from remounting every row on each session update.
  const sameList = <T,>(prev: T[] | undefined, next: T[]) => (prev && prev.length === next.length && prev.every((x, i) => x === next[i]) ? prev : next);
  const projects = createMemo<Project[]>((prev) => {
    const filter = store.state.settings.projectFilter ?? "all";
    let list = [...store.state.projects];
    if (filter !== "all") {
      list = list.filter((p) =>
        p.id === store.state.activeProject ||
        projectSessions(p.id).some((s) => s.alive && (filter === "running" ? true : s.status === "waiting" || s.unread)),
      );
    }
    if (store.state.settings.projectSort === "recent") list.sort((a, b) => lastActivity(b.id) - lastActivity(a.id));
    return sameList(prev, list);
  });
  // Sessions whose project was removed from the sidebar keep running; list them here.
  const orphans = createMemo<SessionInfo[]>((prev) => {
    const known = new Set(store.state.projects.map((p) => p.id));
    const list = Object.values(store.sessions).filter((s) => !s.project_id || !known.has(s.project_id)).sort((a, b) => a.created_at - b.created_at);
    return sameList(prev, list);
  });
  const cycleFilter = () => {
    const order = ["all", "running", "attention"] as const;
    const cur = store.state.settings.projectFilter ?? "all";
    store.setSettings({ projectFilter: order[(order.indexOf(cur) + 1) % order.length] });
  };

  return (
    <aside class={`sidebar${collapsed() ? " collapsed" : ""}`}>
      <div class="brand">
        <span class="brand-logo">E</span>
        <Show when={!collapsed()}>
          <span>Erka</span>
          <span class="spacer" />
        </Show>
      </div>
      <Show when={!collapsed()} fallback={<button class="icon-btn" style={{ margin: "0 auto 6px" }} title="Search" onClick={() => store.setOverlay("palette")}><Icon name="search" /></button>}>
        <button class="search-btn" onClick={() => store.setOverlay("palette")}>
          <Icon name="search" size={14} />
          <span>Search</span>
          <span class="kbd">{searchChord()}</span>
        </button>
        <div class="section-label">
          Projects<span class="spacer" />
          <button class={`icon-btn mini${store.state.settings.projectFilter !== "all" ? " active" : ""}`} title={`Filter: ${FILTERS[store.state.settings.projectFilter ?? "all"]}`} onClick={cycleFilter}><Icon name="filter" size={13} /></button>
          <button class={`icon-btn mini${store.state.settings.projectSort === "recent" ? " active" : ""}`} title={store.state.settings.projectSort === "recent" ? "Sorted by recent activity" : "Manual order"}
            onClick={() => store.setSettings({ projectSort: store.state.settings.projectSort === "recent" ? "manual" : "recent" })}><Icon name="history" size={13} /></button>
          <button class="icon-btn mini" title="Add project folder" onClick={() => void pickProjectFolder()}><Icon name="plus" size={14} /></button>
        </div>
      </Show>
      <div class="project-list">
        <For each={projects()}>{(p) => <ProjectRow project={p} />}</For>
        <Show when={!collapsed() && orphans().length}>
          <div class="section-label other-label">Other sessions</div>
          <div class="session-list">
            <For each={orphans()}>{(s) => <SessionRow s={s} />}</For>
          </div>
        </Show>
        <Show when={collapsed()}>
          <button class="icon-btn" title="Add project" onClick={() => void pickProjectFolder()} style={{ margin: "6px 6px" }}><Icon name="plus" /></button>
        </Show>
      </div>
      <div class="sidebar-footer">
        <button class="icon-btn" title="Agent dashboard" onClick={() => store.setOverlay("dashboard")}><Icon name="dashboard" /></button>
        <button class="icon-btn" title="Settings" onClick={() => store.openSettings()}><Icon name="settings" /></button>
        <span style={{ flex: 1 }} />
        <button class="icon-btn" title="Toggle sidebar" onClick={() => store.setSettings({ sidebarCollapsed: !collapsed() })}><Icon name="sidebar" /></button>
      </div>
    </aside>
  );
}
