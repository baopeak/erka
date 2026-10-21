import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { store } from "../lib/store";
import { daemon } from "../lib/ipc";
import { getView, parkView } from "../lib/terminal-host";
import { Icon } from "./icons";
import { openContextMenu, type MenuItem } from "./context-menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isMac } from "../lib/platform";
import { isAgentKind, kindInfo, launchableAgents } from "../lib/agents";
import { quickCommandsFor } from "../lib/quick-commands";

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
    // Match highlights must read on both terminal backgrounds.
    const light = store.state.settings.theme === "light";
    const opts = {
      decorations: light
        ? { matchOverviewRuler: "#b7791f", activeMatchColorOverviewRuler: "#2f6fde", matchBackground: "#fbe7a6", activeMatchBackground: "#b9d2fb" }
        : { matchOverviewRuler: "#f2c96d", activeMatchColorOverviewRuler: "#6cb6ff", matchBackground: "#5a4a1a", activeMatchBackground: "#1f4b7a" },
    };
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

  /** The last lines of this terminal as plain text (scrollback included), capped in size. */
  const transcript = async (lines = 400, maxChars = 12000) => {
    const s = session();
    if (!s) return "";
    const r = await daemon<{ text: string }>("session.read", { handle: s.handle, lines });
    const text = r.text.trimEnd();
    return text.length > maxChars ? "…\n" + text.slice(text.length - maxChars) : text;
  };

  /** Starts another agent seeded with this session's recent transcript (this one keeps running). */
  const handOff = async (kind: string) => {
    const s = session();
    if (!s?.project_id) return store.notify("Hand-off needs a project session");
    const text = await transcript().catch(() => "");
    const prompt = `You are taking over a task from another coding agent (${kindInfo(s.kind).label}) working in this folder. Below is the end of its terminal session. Work out what was being done and what is left, then continue.\n\n----- transcript -----\n${text}\n----- end -----`;
    await store.newSession(s.project_id, kind, { prompt, where: "right" });
  };

  const menu = (e: MouseEvent) => {
    const s = session();
    const items: MenuItem[] = [
      { label: "Copy", hint: isMac ? "⌘C" : "Ctrl+C", run: () => view.term.hasSelection() && void writeText(view.term.getSelection()) },
      { label: "Paste", hint: isMac ? "⌘V" : "Ctrl+V", run: () => void view.pasteFromClipboard() },
      { label: "Select All", run: () => view.term.selectAll() },
      { label: "Copy Context", run: () => void transcript().then((t) => writeText(t)).then(() => store.notify("Copied the last 400 lines")) },
      { label: "Find…", run: () => { setFinding(true); queueMicrotask(() => findInput?.focus()); } },
      { label: "Clear", run: () => view.term.clear() },
      null,
      { label: "Split Right", run: () => s?.project_id && void store.newSession(s.project_id, "shell", { where: "right" }) },
      { label: "Split Down", run: () => s?.project_id && void store.newSession(s.project_id, "shell", { where: "down" }) },
    ];
    const quick = quickCommandsFor(s?.project_id ?? null);
    if (quick.length) {
      items.push(null);
      for (const c of quick.slice(0, 8)) items.push({ label: `Insert: ${c.label}`, run: () => { view.paste(c.text); view.focus(); } });
    }
    if (s && isAgentKind(s.kind) && s.project_id) {
      items.push(null);
      for (const kind of launchableAgents(store.state.settings.hiddenAgents).filter((k) => k !== s.kind).slice(0, 6)) {
        items.push({ label: `Hand Off to ${kindInfo(kind).label}`, run: () => void handOff(kind) });
      }
    }
    openContextMenu(e, items);
  };

  return (
    <div class="term-wrap" data-session={props.sessionId} onContextMenu={menu}>
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
            <button class="btn primary" onClick={restart}><Icon name="restart" size={14} /> {store.resumable(session()!) ? "Resume" : "Restart"}</button>
          </div>
        </div>
      </Show>
    </div>
  );
}
