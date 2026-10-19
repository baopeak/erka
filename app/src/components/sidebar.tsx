import { For, Show, createMemo } from "solid-js";
import { store, sessionLabel } from "../lib/store";
import { pickProjectFolder } from "../lib/commands";
import { chordLabel, isMac } from "../lib/platform";
import { Icon, KindGlyph } from "./icons";
import type { Project, SessionInfo } from "../lib/types";

export function StatusDot(props: { s: SessionInfo }) {
  return <span class={`dot ${props.s.alive ? props.s.status : "exited"}${props.s.unread ? " unread" : ""}`} title={props.s.alive ? props.s.status : "exited"} />;
}

function projectSessions(projectId: string): SessionInfo[] {
  return Object.values(store.sessions)
    .filter((s) => s.project_id === projectId)
    .sort((a, b) => a.created_at - b.created_at);
}

function ProjectRow(props: { project: Project; index: number }) {
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
  const collapsed = () => store.state.settings.sidebarCollapsed;

  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    const name = prompt("Rename project (empty = remove from Erka)", props.project.name);
    if (name === null) return;
    if (name.trim() === "") store.removeProject(props.project.id);
    else store.renameProject(props.project.id, name.trim());
  };

  return (
    <>
      <div
        class={`project${active() ? " active" : ""}`}
        onClick={() => store.switchProject(props.project.id)}
        onContextMenu={onContext}
        title={`${props.project.path}${props.index < 9 ? `  (${chordLabel(isMac ? `mod+${props.index + 1}` : `alt+${props.index + 1}`)})` : ""}`}
      >
        <span class="project-swatch" style={{ background: props.project.color }}>{props.project.name.slice(0, 1).toUpperCase()}</span>
        <Show when={!collapsed()}>
          <span class="project-name">{props.project.name}</span>
          <span class="project-badges">
            <Show when={counts().waiting}><span class="badge waiting" title="Needs you">{counts().waiting}</span></Show>
            <Show when={counts().working}><span class="badge working" title="Working">{counts().working}</span></Show>
            <Show when={counts().unread}><span class="badge unread" title="Finished, unread">{counts().unread}</span></Show>
          </span>
        </Show>
      </div>
      <Show when={active() && !collapsed() && sessions().length}>
        <div class="session-list">
          <For each={sessions()}>
            {(s) => (
              <div class={`session-row${store.isSessionVisible(s.id) ? " visible" : ""}`} onClick={() => store.revealSession(s.id)} title={s.title ?? ""}>
                <StatusDot s={s} />
                <KindGlyph kind={s.kind} size={14} />
                <span class="name">{sessionLabel(s)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

export function Sidebar() {
  const collapsed = () => store.state.settings.sidebarCollapsed;
  return (
    <aside class={`sidebar${collapsed() ? " collapsed" : ""}`}>
      <div class="brand">
        <span class="brand-logo">E</span>
        <Show when={!collapsed()}>
          <span>Erka</span>
          <span class="spacer" />
        </Show>
      </div>
      <Show when={!collapsed()}>
        <div class="section-label">
          Projects<span class="spacer" />
          <button class="icon-btn" title="Add project folder" onClick={() => void pickProjectFolder()}><Icon name="plus" /></button>
        </div>
      </Show>
      <div class="project-list">
        <For each={store.state.projects}>{(p, i) => <ProjectRow project={p} index={i()} />}</For>
        <Show when={collapsed()}>
          <button class="icon-btn" title="Add project" onClick={() => void pickProjectFolder()} style={{ margin: "6px 6px" }}><Icon name="plus" /></button>
        </Show>
      </div>
      <div class="sidebar-footer">
        <button class="icon-btn" title="Agent dashboard" onClick={() => store.setOverlay("dashboard")}><Icon name="dashboard" /></button>
        <button class="icon-btn" title="Settings" onClick={() => store.setOverlay("settings")}><Icon name="settings" /></button>
        <span style={{ flex: 1 }} />
        <button class="icon-btn" title="Toggle sidebar" onClick={() => store.setSettings({ sidebarCollapsed: !collapsed() })}><Icon name="sidebar" /></button>
      </div>
    </aside>
  );
}
