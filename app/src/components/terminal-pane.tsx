import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { store } from "../lib/store";
import { daemon } from "../lib/ipc";
import { getView, parkView } from "../lib/terminal-host";
import { Icon } from "./icons";

export function TerminalPane(props: { sessionId: string; focused: boolean }) {
  let host!: HTMLDivElement;
  let findInput!: HTMLInputElement;
  const session = () => store.sessions[props.sessionId];
  const view = getView(props.sessionId, store.state.settings);
  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");

  onMount(() => {
    view.mount(host);
    // (Re)attach whenever the daemon (re)connects or the session's handle changes.
    createEffect(() => {
      const s = session();
      if (s && store.connected() && (!view.attached || view.handle !== s.handle)) void view.attach(s.handle);
    });
    createEffect(() => {
      if (props.focused && store.overlay() === null) queueMicrotask(() => view.focus());
    });
    const onFind = () => {
      if (!props.focused) return;
      setFinding(true);
      findInput?.focus();
      findInput?.select();
    };
    window.addEventListener("erka:find", onFind);
    onCleanup(() => {
      window.removeEventListener("erka:find", onFind);
      parkView(props.sessionId);
    });
  });

  const find = (forward: boolean) => {
    const q = query();
    if (!q) return;
    const opts = { decorations: { matchOverviewRuler: "#f2c96d", activeMatchColorOverviewRuler: "#6cb6ff", matchBackground: "#5a4a1a", activeMatchBackground: "#1f4b7a" } };
    if (forward) view.search.findNext(q, opts);
    else view.search.findPrevious(q, opts);
  };

  const closeFind = () => {
    setFinding(false);
    view.search.clearDecorations();
    view.focus();
  };

  const restart = () => {
    const s = session();
    if (s) void daemon("session.restart", { handle: s.handle }).catch((e) => store.notify(String(e)));
  };

  return (
    <div class="term-wrap" data-session={props.sessionId}>
      <div ref={host} style={{ width: "100%", height: "100%" }} />
      <Show when={finding()}>
        <div class="findbar">
          <input
            ref={findInput}
            placeholder="Find in terminal"
            value={query()}
            onInput={(e) => { setQuery(e.currentTarget.value); find(true); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") find(!e.shiftKey);
              if (e.key === "Escape") closeFind();
            }}
          />
          <button class="icon-btn" onClick={() => find(false)} title="Previous (Shift+Enter)"><Icon name="up" size={14} /></button>
          <button class="icon-btn" onClick={() => find(true)} title="Next (Enter)"><Icon name="down" size={14} /></button>
          <button class="icon-btn" onClick={closeFind} title="Close (Esc)"><Icon name="close" size={12} /></button>
        </div>
      </Show>
      <Show when={!session()}>
        <div class="pane-overlay"><div class="exit-card"><span class="msg">Session not available (daemon {store.connected() ? "has no such session" : "disconnected"})</span></div></div>
      </Show>
      <Show when={session() && !session()!.alive}>
        <div style={{ position: "absolute", left: "12px", right: "12px", bottom: "10px", "z-index": 6, display: "flex", "justify-content": "center" }}>
          <div class="exit-card" style={{ "flex-direction": "row", padding: "8px 12px" }}>
            <span class="msg">Process exited{session()!.exit_code != null ? ` (code ${session()!.exit_code})` : ""}</span>
            <button class="btn primary" onClick={restart}><Icon name="restart" size={14} /> {session()!.agent_session_id ? "Resume" : "Restart"}</button>
          </div>
        </div>
      </Show>
    </div>
  );
}
