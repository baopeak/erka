import { For, Show, createSignal, onMount } from "solid-js";
import { store } from "../lib/store";
import { KindGlyph, kindMeta } from "./icons";
import { newChat, supportsChat } from "../chat/mode-switch";
import type { SessionKind } from "../lib/types";

const kinds: SessionKind[] = ["claude", "codex", "omp", "shell", "custom"];

/** New session dialog: agent/shell, placement, extra args, or an arbitrary command. */
export function NewSessionMenu() {
  const project = store.activeProject();
  const [kind, setKind] = createSignal<SessionKind>("claude");
  const [where, setWhere] = createSignal<"tab" | "right" | "down">("tab");
  const [args, setArgs] = createSignal("");
  const [name, setName] = createSignal("");
  const [ui, setUi] = createSignal<"terminal" | "chat">("terminal");
  let argsInput!: HTMLInputElement;
  onMount(() => argsInput.focus());

  const profileArgs = (k: SessionKind) => store.state.settings.profiles.find((p) => p.kind === k)?.args.join(" ") ?? "";
  const start = () => {
    if (!project) return;
    const extra = args().trim();
    const argv = extra ? extra.match(/"[^"]*"|\S+/g)!.map((a) => a.replace(/^"|"$/g, "")) : undefined;
    if (kind() === "custom" && !argv) return store.notify("Enter a command to run");
    store.setOverlay(null);
    if (ui() === "chat" && supportsChat(kind())) return void newChat(project.id, kind(), where());
    void store.newSession(project.id, kind(), { where: where(), args: argv, name: name().trim() || undefined });
  };

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && store.setOverlay(null)}>
      <div class="modal" onKeyDown={(e) => { if (e.key === "Escape") store.setOverlay(null); if (e.key === "Enter") start(); }}>
        <h2>New session in {project?.name}</h2>
        <div class="launcher" style={{ "grid-template-columns": "repeat(5, 1fr)" }}>
          <For each={kinds}>
            {(k) => (
              <div class="launch-card" style={{ "flex-direction": "column", "border-color": kind() === k ? "var(--accent)" : undefined }} onClick={() => { setKind(k); setArgs(k === "custom" ? "" : profileArgs(k)); }}>
                <KindGlyph kind={k} size={30} />
                <div style={{ "font-size": "12px" }}>{kindMeta[k].label}</div>
              </div>
            )}
          </For>
        </div>
        <div class="form-row">
          <label>{kind() === "custom" ? "Command" : kind() === "shell" ? "Shell (empty = default)" : "Extra arguments"}</label>
          <input ref={argsInput} class="text-input" value={args()} onInput={(e) => setArgs(e.currentTarget.value)} placeholder={kind() === "custom" ? "npm run dev" : kind() === "claude" ? "--model opus" : ""} />
        </div>
        <div class="form-row">
          <label>Name (optional)</label>
          <input class="text-input" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </div>
        <Show when={supportsChat(kind())}>
          <div class="form-row">
            <label>Interface</label>
            <div class="toggles">
              <button class={`toggle${ui() === "terminal" ? " on" : ""}`} onClick={() => setUi("terminal")}>Terminal (TUI)</button>
              <button class={`toggle${ui() === "chat" ? " on" : ""}`} onClick={() => setUi("chat")}>Chat view</button>
            </div>
          </div>
        </Show>
        <div class="form-row">
          <label>Open in</label>
          <div class="toggles">
            <button class={`toggle${where() === "tab" ? " on" : ""}`} onClick={() => setWhere("tab")}>New tab</button>
            <button class={`toggle${where() === "right" ? " on" : ""}`} onClick={() => setWhere("right")}>Split right</button>
            <button class={`toggle${where() === "down" ? " on" : ""}`} onClick={() => setWhere("down")}>Split down</button>
          </div>
        </div>
        <div class="footer">
          <button class="btn" onClick={() => store.setOverlay(null)}>Cancel</button>
          <button class="btn primary" onClick={start}>Start</button>
        </div>
      </div>
    </div>
  );
}
