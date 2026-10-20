// Quick command editor (Settings) and the runnable list shown in the New Session menu.
import { For, Show } from "solid-js";
import { store } from "../lib/store";
import { isMac, uid } from "../lib/platform";
import { quickCommandsFor, runQuickCommand } from "../lib/quick-commands";
import { Icon } from "./icons";
import type { QuickCommand } from "../lib/types";

export function QuickCommandsEditor() {
  const list = () => store.state.settings.quickCommands ?? [];
  const save = (next: QuickCommand[]) => store.setSettings({ quickCommands: next });
  const patch = (id: string, p: Partial<QuickCommand>) => save(list().map((c) => (c.id === id ? { ...c, ...p } : c)));
  const add = () =>
    save([...list(), { id: uid(), label: "New command", text: "", action: "terminal", enter: true, projectId: null }]);

  return (
    <div class="qc-editor">
      <For each={list()} fallback={<div class="muted" style={{ padding: "4px 0" }}>No quick commands yet.</div>}>
        {(c) => (
          <div class="qc-row" data-qc={c.id}>
            <div class="qc-line">
              <input class="text-input qc-label" value={c.label} placeholder="Label" onChange={(e) => patch(c.id, { label: e.currentTarget.value.trim() || "Untitled" })} />
              <div class="toggles">
                <button class={`toggle${c.action === "terminal" ? " on" : ""}`} title="Type into the focused terminal (or a new one)" onClick={() => patch(c.id, { action: "terminal" })}>Terminal</button>
                <button class={`toggle${c.action === "agent" ? " on" : ""}`} title="Send as a prompt to the focused agent" onClick={() => patch(c.id, { action: "agent" })}>Agent</button>
              </div>
              <button class="icon-btn" title="Delete" onClick={() => save(list().filter((x) => x.id !== c.id))}><Icon name="close" size={13} /></button>
            </div>
            <textarea class="text-input qc-text" rows={2} value={c.text} placeholder={c.action === "agent" ? "Prompt for the agent" : "Command, e.g. npm test"}
              onChange={(e) => patch(c.id, { text: e.currentTarget.value })} />
            <div class="qc-line qc-opts">
              <label><input type="checkbox" checked={c.enter} onChange={(e) => patch(c.id, { enter: e.currentTarget.checked })} /> Press Enter</label>
              <select class="text-input" value={c.projectId ?? ""} onChange={(e) => patch(c.id, { projectId: e.currentTarget.value || null })}>
                <option value="">All projects</option>
                <For each={store.state.projects}>{(p) => <option value={p.id}>Only {p.name}</option>}</For>
              </select>
            </div>
          </div>
        )}
      </For>
      <button class="btn" onClick={add}><Icon name="plus" size={13} /> Add quick command</button>
    </div>
  );
}

/** Runnable quick commands for the active project; Ctrl+1…9 run the first nine (Alt+digit
 *  switches projects on Windows, Cmd+digit on macOS). */
export function QuickCommandList(props: { onRun?: () => void }) {
  const list = () => quickCommandsFor(store.state.activeProject);
  const run = (c: QuickCommand) => {
    props.onRun?.();
    void runQuickCommand(c);
  };
  return (
    <Show when={list().length}>
      <div class="qc-list">
        <For each={list()}>
          {(c, i) => (
            <button class="qc-chip" title={`${c.action === "agent" ? "Prompt" : "Command"}: ${c.text}`} onClick={() => run(c)}>
              <Icon name={c.action === "agent" ? "chat" : "terminal"} size={12} />
              {c.label}
              <Show when={i() < 9}><span class="kbd">{isMac ? "⌃" : "Ctrl+"}{i() + 1}</span></Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Ctrl+digit handler for menus showing a QuickCommandList. */
export function quickCommandKey(e: KeyboardEvent, onRun?: () => void): boolean {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return false;
  const c = quickCommandsFor(store.state.activeProject)[+e.code.slice(5) - 1];
  if (!c) return false;
  e.preventDefault();
  onRun?.();
  void runQuickCommand(c);
  return true;
}
