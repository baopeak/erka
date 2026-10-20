import { Match, Switch, createEffect, onCleanup } from "solid-js";
import { store } from "../lib/store";
import { unwatchRoot, watchRoot } from "../lib/ipc";
import { gitState } from "../lib/git-state";
import { Explorer } from "./explorer";
import { GitPanel } from "./git-panel";
import { HistoryPanel } from "./history-panel";
import type { Project } from "../lib/types";

export function RightPanel(props: { project: Project }) {
  const panel = () => store.workspace(props.project.id).rightPanel;

  // Watch only the project being looked at; background projects cost nothing.
  createEffect(() => {
    const root = props.project.path;
    void watchRoot(root).catch(() => {});
    gitState.setRoot(root);
    onCleanup(() => void unwatchRoot(root).catch(() => {}));
  });

  const startResize = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = store.state.settings.rightPanelWidth;
    // The panel is zoomed by the interface scale; its width is in unzoomed pixels.
    const scale = store.state.settings.uiScale || 1;
    const move = (ev: PointerEvent) => store.setSettings({ rightPanelWidth: Math.min(700, Math.max(200, startW - (ev.clientX - startX) / scale)) });
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const tab = (id: "files" | "git" | "history", label: string) => (
    <button class={`ptab${panel() === id || (id === "files" && panel() === "search") ? " active" : ""}`} onClick={() => store.showRightPanel(id)}>
      {label}
      {id === "git" && gitState.status()?.files.length ? ` ${gitState.status()!.files.length}` : ""}
    </button>
  );

  return (
    <aside class="rightpanel">
      <div class="panel-resizer" onPointerDown={startResize} />
      <div class="panel-tabs">
        {tab("files", "Files")}
        {tab("git", "Changes")}
        {tab("history", "Sessions")}
      </div>
      <div class="panel-body">
        <Switch>
          <Match when={panel() === "files" || panel() === "search"}><Explorer project={props.project} /></Match>
          <Match when={panel() === "git"}><GitPanel project={props.project} /></Match>
          <Match when={panel() === "history"}><HistoryPanel project={props.project} /></Match>
        </Switch>
      </div>
    </aside>
  );
}
