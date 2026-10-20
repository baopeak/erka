import { Match, Show, Switch, createEffect, onMount } from "solid-js";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { store } from "../lib/store";
import { peekView } from "../lib/terminal-host";
import { Sidebar } from "./sidebar";
import { WorkspaceView } from "./workspace-view";
import { RightPanel } from "./right-panel";
import { StatusBar } from "./status-bar";
import { Palette } from "./palette";
import { Dashboard } from "./dashboard";
import { SettingsPage } from "./settings/settings-page";
import { Tips } from "./tips";
import { Board } from "./board";
import { WorktreeDialog } from "./worktree-dialog";
import { NewSessionMenu } from "./new-session-menu";
import { Welcome } from "./welcome";
import { ContextMenuHost } from "./context-menu";

export function App() {
  // Theme, density and interface scale are plain CSS switches on the root element.
  createEffect(() => {
    const s = store.state.settings;
    const root = document.documentElement;
    root.dataset.theme = s.theme ?? "dark";
    root.dataset.density = s.density ?? "comfortable";
    root.style.setProperty("--ui-scale", String(s.uiScale ?? 1));
  });
  onMount(() => {
    // Files dropped from Explorer/Finder onto a terminal paste their (quoted) paths.
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { x, y } = event.payload.position;
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / ratio, y / ratio)?.closest<HTMLElement>("[data-session]");
      const view = el && peekView(el.dataset.session!);
      if (!view) return;
      const quote = (p: string) => (/[\s'"&()]/.test(p) ? `"${p}"` : p);
      view.paste(event.payload.paths.map(quote).join(" ") + " ");
      view.focus();
    });
  });

  return (
    <div class="app" style={{ "--sidebar-w": `${store.state.settings.sidebarWidth}px`, "--right-w": `${store.state.settings.rightPanelWidth}px` }}>
      <Sidebar />
      <div class="main">
        <div class="workarea">
          <div class="center">
            <Show when={store.activeProject()} fallback={<Welcome />} keyed>
              {(project) => <WorkspaceView project={project} />}
            </Show>
          </div>
          <Show when={store.activeProject() && store.workspace(store.activeProject()!.id).rightPanel ? store.activeProject() : null} keyed>
            {(project) => <RightPanel project={project} />}
          </Show>
        </div>
        <StatusBar />
      </div>
      <Switch>
        <Match when={store.overlay() === "dashboard"}><Dashboard /></Match>
        <Match when={store.overlay() === "settings"}><SettingsPage /></Match>
        <Match when={store.overlay() === "newsession"}><NewSessionMenu /></Match>
        <Match when={store.overlay() === "board"}><Board /></Match>
        <Match when={store.overlay() === "worktree"}><WorktreeDialog /></Match>
        <Match when={["palette", "quickopen", "jump"].includes(store.overlay() ?? "") && store.overlay()} keyed>
          {(o) => <Palette scope={o === "quickopen" ? "files" : o === "jump" ? "sessions" : "all"} />}
        </Match>
      </Switch>
      <ContextMenuHost />
      <Tips />
      <Show when={store.toast()}>
        {(t) => (
          <div class="toast">
            <span>{t().text}</span>
            <Show when={t().action}>
              {(a) => <button class="btn" style={{ height: "24px", "margin-left": "10px" }} onClick={() => a().run()}>{a().label}</button>}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
