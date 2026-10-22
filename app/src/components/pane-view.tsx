import { For, Match, Show, Switch, createEffect, createMemo } from "solid-js";
import { openNewSession } from "./new-session-menu";
import { MicButton } from "./voice";
import { store } from "../lib/store";
import { allPanes, cyclePane } from "../lib/layout";
import { Icon, KindGlyph } from "./icons";
import { StatusDot } from "./sidebar";
import { TerminalPane } from "./terminal-pane";
import { FileViewer } from "./file-viewer";
import { DiffView } from "./diff-view";
import { ChatPane } from "./chat-pane";
import { paneTitle } from "./workspace-view";
import { switchToChat, switchToTerminal, supportsChat } from "../chat/mode-switch";
import { startPaneDrag } from "./split-view";
import { BrowserPane } from "./browser-pane";
import { kindInfo, projectAgents } from "../lib/agents";
import type { Pane, Project, Tab } from "../lib/types";
import { t } from "../lib/i18n";

export function PaneView(props: { pane: Pane; project: Project; tab: Tab }) {
  const focused = () => props.tab.focus === props.pane.id;
  const multi = createMemo(() => allPanes(props.tab.root).length > 1);
  const session = () => (props.pane.sessionId ? store.sessions[props.pane.sessionId] : undefined);
  const focus = () => store.focusPane(props.project.id, props.tab.id, props.pane.id);
  const close = () => {
    const s = session();
    if (s?.alive && s.kind !== "shell" && !confirm(t("Stop {kind} and close this pane?", { kind: s.kind }))) return;
    void store.closePane(props.project.id, props.tab.id, props.pane.id);
  };
  const split = (where: "right" | "down") => {
    focus();
    store.splitPicker(props.project.id, where);
  };
  const zoomedHere = () => store.zoomed()[props.tab.id] === props.pane.id;
  const tools = () => (
    <>
      <Show when={props.pane.kind === "terminal" && session()?.alive}>
        <MicButton sessionId={props.pane.sessionId} size={13} />
      </Show>
      <button class="icon-btn" title={t("Split right")} onClick={() => split("right")}><Icon name="splitRight" size={13} /></button>
      <button class="icon-btn" title={t("Split down")} onClick={() => split("down")}><Icon name="splitDown" size={13} /></button>
      <Show when={multi() || zoomedHere()}>
        <button class={`icon-btn${zoomedHere() ? " active" : ""}`} title={zoomedHere() ? t("Restore layout") : t("Maximize pane")} onClick={() => store.toggleZoom(props.tab.id, props.pane.id)}>
          <Icon name={zoomedHere() ? "minimize" : "maximize"} size={13} />
        </button>
      </Show>
      <button class="icon-btn" title={t("Close pane")} onClick={close}><Icon name="close" size={12} /></button>
    </>
  );
  // File/diff viewers have their own top bar: give them the header instead of a floating
  // toolbar so the two never overlap.
  const hasHeader = () =>
    multi() || zoomedHere() || props.pane.kind === "file" || props.pane.kind === "diff" || (session() && chatable());
  // Chat view runs the agent as a local process: not for sessions on another machine.
  const chatable = () => !!session() && supportsChat(session()!.kind) && !session()!.remote;
  const broadcasting = () => !!props.tab.broadcast && props.pane.kind === "terminal";

  return (
    <div class={`pane${focused() && multi() ? " focused" : ""}${broadcasting() ? " broadcast" : ""}`} data-pane={props.pane.id} data-tab={props.tab.id} onPointerDown={focus}>
      <Show when={!hasHeader()}>
        <div class="pane-tools">{tools()}</div>
      </Show>
      <Show when={hasHeader()}>
        <div class="pane-header" onPointerDown={(e) => multi() && startPaneDrag(e, props.project, props.tab, props.pane.id)} title={multi() ? t("Drag to move or swap this pane, or onto a tab") : undefined}>
          <Show when={session()} fallback={<Icon name={props.pane.kind === "empty" ? "plus" : props.pane.kind === "browser" ? "globe" : "files"} size={13} />}>
            {(s) => <><StatusDot s={s()} /><KindGlyph kind={s().kind} size={14} /></>}
          </Show>
          <span class="title">{paneTitle(props.pane)}</span>
          <Show when={broadcasting()}>
            <span class="badge broadcast-badge" title={t("Typing here goes to every terminal in this tab")}>{t("Broadcast")}</span>
          </Show>
          <Show when={chatable()}>
            <Show
              when={props.pane.kind === "chat"}
              fallback={<button class="icon-btn" title={t("Open in chat view")} onClick={() => void switchToChat(props.project, props.tab, props.pane)}><Icon name="chat" size={14} /></button>}
            >
              <button class="icon-btn" title={t("Back to terminal (TUI)")} onClick={() => void switchToTerminal(props.project, props.tab, props.pane)}><Icon name="terminal" size={14} /></button>
            </Show>
          </Show>
          {tools()}
        </div>
      </Show>
      <div class="pane-body">
        <Switch fallback={<EmptyPane project={props.project} tab={props.tab} pane={props.pane} focused={focused()} />}>
          <Match when={props.pane.kind === "terminal" && props.pane.sessionId} keyed>
            {(id) => <TerminalPane sessionId={id} focused={focused()} />}
          </Match>
          <Match when={props.pane.kind === "chat" && props.pane.sessionId} keyed>
            {(id) => <ChatPane sessionId={id} project={props.project} focused={focused()} />}
          </Match>
          <Match when={props.pane.kind === "file" && props.pane.path} keyed>
            {(path) => <FileViewer project={props.project} path={path} line={props.pane.line} focused={focused()} />}
          </Match>
          <Match when={props.pane.kind === "browser" && props.pane.id} keyed>
            {(_id) => <BrowserPane pane={props.pane} project={props.project} tab={props.tab} focused={focused()} />}
          </Match>
          <Match when={props.pane.kind === "diff" && props.pane.path} keyed>
            {(path) => <DiffView project={props.project} path={path} staged={!!props.pane.staged} />}
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/** An empty pane (a new split or grid cell): asks what to run in it. One click or key 1–9
 *  starts an agent or a shell; "More…" opens the full dialog for this pane; Esc closes it. */
function EmptyPane(props: { project: Project; tab: Tab; pane: Pane; focused: boolean }) {
  let el!: HTMLDivElement;
  const kinds = () => [...projectAgents(props.project, store.state.settings.hiddenAgents), "shell"];
  const into = () => ({ tabId: props.tab.id, paneId: props.pane.id });
  // One start per pane: a double click or a held key must not start a second session.
  let starting = false;
  const start = (kind: string) => {
    if (starting) return;
    starting = true;
    void store.newSession(props.project.id, kind, { into: into() }).then((s) => !s && (starting = false));
  };
  // Take the keyboard when focused (and again when a dialog closes), so a split can be
  // answered without the mouse; never from behind an open dialog.
  createEffect(() => {
    if (props.focused && store.overlay() === null) queueMicrotask(() => el?.focus({ preventScroll: true }));
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, kinds().length)) {
      e.preventDefault();
      start(kinds()[n - 1]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Cancelling a split goes back to the pane before it (the one that was split).
      // Ids are read now: once the pane leaves the tree its props no longer resolve.
      const { id: projectId } = props.project;
      const { id: tabId } = props.tab;
      const paneId = props.pane.id;
      const back = cyclePane(props.tab.root, paneId, -1);
      void store.closePane(projectId, tabId, paneId).then(() => {
        if (back !== paneId) store.focusPane(projectId, tabId, back);
      });
    }
  };
  return (
    <div class="empty-pane" ref={el} tabindex={-1} onKeyDown={onKey}>
      <div class="empty-pane-title">{t("What should run in this pane?")}</div>
      <div class="empty-pane-kinds">
        <For each={kinds()}>
          {(k, i) => (
            <button class="empty-pane-kind" title={kindInfo(k).label} onClick={() => start(k)}>
              <KindGlyph kind={k} size={22} />
              <span>{kindInfo(k).label}</span>
              <Show when={i() < 9}><kbd class="empty-pane-key">{i() + 1}</kbd></Show>
            </button>
          )}
        </For>
        <button class="empty-pane-kind" title={t("Command, arguments, account, chat view…")} onClick={() => openNewSession(into())}>
          <Icon name="plus" size={16} />
          <span>{t("More…")}</span>
        </button>
      </div>
      <div class="empty-pane-hint">{t("1–9 to start · Esc to close")}</div>
    </div>
  );
}
