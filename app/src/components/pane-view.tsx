import { Match, Show, Switch, createMemo } from "solid-js";
import { store } from "../lib/store";
import { allPanes } from "../lib/layout";
import { Icon, KindGlyph } from "./icons";
import { StatusDot } from "./sidebar";
import { TerminalPane } from "./terminal-pane";
import { FileViewer } from "./file-viewer";
import { DiffView } from "./diff-view";
import { ChatPane } from "./chat-pane";
import { paneTitle } from "./workspace-view";
import { switchToChat, switchToTerminal, supportsChat } from "../chat/mode-switch";
import type { Pane, Project, Tab } from "../lib/types";

export function PaneView(props: { pane: Pane; project: Project; tab: Tab }) {
  const focused = () => props.tab.focus === props.pane.id;
  const multi = createMemo(() => allPanes(props.tab.root).length > 1);
  const session = () => (props.pane.sessionId ? store.sessions[props.pane.sessionId] : undefined);
  const focus = () => store.focusPane(props.project.id, props.tab.id, props.pane.id);
  const close = () => {
    const s = session();
    if (s?.alive && s.kind !== "shell" && !confirm(`Stop ${s.kind} and close this pane?`)) return;
    void store.closePane(props.project.id, props.tab.id, props.pane.id);
  };

  return (
    <div class={`pane${focused() && multi() ? " focused" : ""}`} onPointerDown={focus}>
      <Show when={multi() || (session() && supportsChat(session()!.kind))}>
        <div class="pane-header">
          <Show when={session()} fallback={<Icon name="files" size={13} />}>
            {(s) => <><StatusDot s={s()} /><KindGlyph kind={s().kind} size={14} /></>}
          </Show>
          <span class="title">{paneTitle(props.pane)}</span>
          <Show when={session() && supportsChat(session()!.kind)}>
            <Show
              when={props.pane.kind === "chat"}
              fallback={<button class="icon-btn" title="Open in chat view" onClick={() => void switchToChat(props.project, props.tab, props.pane)}><Icon name="chat" size={14} /></button>}
            >
              <button class="icon-btn" title="Back to terminal (TUI)" onClick={() => void switchToTerminal(props.project, props.tab, props.pane)}><Icon name="terminal" size={14} /></button>
            </Show>
          </Show>
          <button class="icon-btn" title="Close pane" onClick={close}><Icon name="close" size={12} /></button>
        </div>
      </Show>
      <div class="pane-body">
        <Switch fallback={<div class="empty">Empty pane</div>}>
          <Match when={props.pane.kind === "terminal" && props.pane.sessionId} keyed>
            {(id) => <TerminalPane sessionId={id} focused={focused()} />}
          </Match>
          <Match when={props.pane.kind === "chat" && props.pane.sessionId} keyed>
            {(id) => <ChatPane sessionId={id} project={props.project} focused={focused()} />}
          </Match>
          <Match when={props.pane.kind === "file" && props.pane.path} keyed>
            {(path) => <FileViewer project={props.project} path={path} line={props.pane.line} focused={focused()} />}
          </Match>
          <Match when={props.pane.kind === "diff" && props.pane.path} keyed>
            {(path) => <DiffView project={props.project} path={path} staged={!!props.pane.staged} />}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
