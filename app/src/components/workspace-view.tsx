import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js";
import { store, sessionLabel } from "../lib/store";
import { allPanes } from "../lib/layout";
import { chordLabel } from "../lib/platform";
import { chordOf, commands } from "../lib/commands";
import { basename } from "../lib/platform";
import { Icon, KindGlyph } from "./icons";
import { SplitView } from "./split-view";
import { StatusDot } from "./sidebar";
import { Launcher } from "./welcome";
import type { Pane, Project, Tab } from "../lib/types";

export function paneTitle(pane: Pane): string {
  if (pane.sessionId) {
    const s = store.sessions[pane.sessionId];
    return s ? sessionLabel(s) : "Session";
  }
  if (pane.path) return (pane.kind === "diff" ? "Δ " : "") + basename(pane.path);
  return "Empty";
}

function TabTitle(props: { tab: Tab }) {
  const panes = createMemo(() => allPanes(props.tab.root));
  const focus = () => panes().find((p) => p.id === props.tab.focus) ?? panes()[0];
  const session = () => (focus()?.sessionId ? store.sessions[focus()!.sessionId!] : undefined);
  return (
    <>
      <Show when={session()} fallback={<Icon name={focus()?.kind === "diff" ? "git" : "files"} size={14} />}>
        {(s) => <StatusDot s={s()} />}
      </Show>
      <Show when={session()}>{(s) => <KindGlyph kind={s().kind} size={14} />}</Show>
      <span class="title">
        {paneTitle(focus())}
        <Show when={panes().length > 1}> <span style={{ color: "var(--text-faint)" }}>+{panes().length - 1}</span></Show>
      </span>
    </>
  );
}

export function WorkspaceView(props: { project: Project }) {
  const ws = () => store.workspace(props.project.id);
  const active = () => store.activeTab(props.project.id);
  const hint = (id: string) => {
    const c = commands.find((x) => x.id === id);
    const k = c && chordOf(c);
    return k ? ` (${chordLabel(k)})` : "";
  };

  const closeTab = async (tab: Tab) => {
    const live = allPanes(tab.root).filter((p) => p.sessionId && store.sessions[p.sessionId]?.alive && store.sessions[p.sessionId]?.kind !== "shell");
    if (live.length && !confirm(`Stop ${live.length} running agent session(s) in this tab?`)) return;
    for (const pane of allPanes(tab.root)) await store.closePane(props.project.id, tab.id, pane.id);
  };

  // The active tab stays in view when tabs overflow: on selection and when the bar resizes.
  let tabsRef!: HTMLDivElement;
  const showActive = () => tabsRef?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  createEffect(() => {
    active()?.id;
    queueMicrotask(showActive);
  });
  onMount(() => {
    const ro = new ResizeObserver(showActive);
    ro.observe(tabsRef);
    onCleanup(() => ro.disconnect());
  });

  return (
    <>
      <div class={`tabbar${ws().rightPanel ? " panel-open" : ""}`}>
        <div class="tabs" ref={tabsRef}>
          <For each={ws().tabs}>
            {(tab) => (
              <div
                class={`tab${active()?.id === tab.id ? " active" : ""}`}
                onClick={() => store.selectTab(props.project.id, tab.id)}
                onAuxClick={(e) => e.button === 1 && void closeTab(tab)}
              >
                <TabTitle tab={tab} />
                <button class="icon-btn close" onClick={(e) => { e.stopPropagation(); void closeTab(tab); }}><Icon name="close" size={12} /></button>
              </div>
            )}
          </For>
        </div>
        <div class="tabbar-actions">
          <button class="icon-btn" title={`New terminal${hint("new.shell")}`} onClick={() => void store.newSession(props.project.id, "shell")}><Icon name="terminal" /></button>
          <button class="icon-btn" title={`New session…${hint("new.menu")}`} onClick={() => store.setOverlay("newsession")}><Icon name="plus" /></button>
          <button class="icon-btn" title={`Split right${hint("split.right")}`} onClick={() => void store.newSession(props.project.id, "shell", { where: "right" })}><Icon name="splitRight" /></button>
          <button class="icon-btn" title={`Split down${hint("split.down")}`} onClick={() => void store.newSession(props.project.id, "shell", { where: "down" })}><Icon name="splitDown" /></button>
          <span class="panel-toggle" style={{ width: "8px" }} />
          <button class={`icon-btn panel-toggle${ws().rightPanel === "files" ? " active" : ""}`} title={`Explorer${hint("panel.files")}`} onClick={() => store.setRightPanel("files")}><Icon name="files" /></button>
          <button class={`icon-btn panel-toggle${ws().rightPanel === "git" ? " active" : ""}`} title={`Source control${hint("panel.git")}`} onClick={() => store.setRightPanel("git")}><Icon name="git" /></button>
          <button class={`icon-btn panel-toggle${ws().rightPanel === "search" ? " active" : ""}`} title={`Search${hint("panel.search")}`} onClick={() => store.setRightPanel("search")}><Icon name="search" /></button>
        </div>
      </div>
      <div class="tab-content">
        <Show when={active()} keyed fallback={<Launcher project={props.project} />}>
          {(tab) => <SplitView project={props.project} tab={tab} />}
        </Show>
      </div>
    </>
  );
}
