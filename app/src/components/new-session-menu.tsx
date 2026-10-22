import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { store, type PaneTarget } from "../lib/store";
import { KindGlyph } from "./icons";
import { isAgentKind, kindInfo, projectAgents } from "../lib/agents";
import { KeyHints } from "./key-hints";
import { QuickCommandList, quickCommandKey } from "./quick-commands";
import { newChat, supportsChat } from "../chat/mode-switch";
import { GRID_PRESETS, cellCount, gridLabel, type GridSpec } from "../lib/layout";
import { GridThumb, parseCounts } from "./layout-menu";
import { accountsOf, activeAccount, isAccountAgent } from "../lib/accounts";
import type { SessionKind } from "../lib/types";
import { t } from "../lib/i18n";

/** The empty pane the dialog was opened for ("More…" in a pane's launcher). */
const [target, setTarget] = createSignal<PaneTarget | null>(null);

/** Opens the new session dialog; with `into`, it starts in that empty pane by default. */
export function openNewSession(into?: PaneTarget) {
  setTarget(into ?? null);
  store.setOverlay("newsession");
}

/** New session dialog: agent/shell, placement, extra args, or an arbitrary command. */
export function NewSessionMenu() {
  const project = store.activeProject();
  const into = target();
  onCleanup(() => setTarget(null));
  const [kind, setKind] = createSignal<SessionKind>("claude");
  const [where, setWhere] = createSignal<"pane" | "tab" | "right" | "down" | "grid">(into ? "pane" : "tab");
  const [grid, setGrid] = createSignal<GridSpec>({ mode: "rows", counts: [2, 2] });
  /** Account for Claude / Codex ("default" = the agent's own sign-in); starts at the active one. */
  const [account, setAccount] = createSignal<string | null>(null);
  const chosenAccount = () => (isAccountAgent(kind()) ? account() ?? activeAccount(kind() as "claude" | "codex")?.id ?? "default" : undefined);
  const [args, setArgs] = createSignal("");
  const [name, setName] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [ui, setUi] = createSignal<"terminal" | "chat">("terminal");
  const kinds = (): SessionKind[] => [...projectAgents(project, store.state.settings.hiddenAgents), "shell", "custom"];
  let argsInput!: HTMLInputElement;
  onMount(() => argsInput.focus());

  const profileArgs = (k: SessionKind) => store.state.settings.profiles.find((p) => p.kind === k)?.args.join(" ") ?? "";
  const start = () => {
    if (!project) return;
    const extra = args().trim();
    const argv = extra ? extra.match(/"[^"]*"|\S+/g)!.map((a) => a.replace(/^"|"$/g, "")) : undefined;
    if (kind() === "custom" && !argv) return store.notify(t("Enter a command to run"));
    store.setOverlay(null);
    const w = where();
    if (w === "grid") {
      // The same agent in every cell; the first prompt (if any) goes to each of them.
      return void store.launchGrid(project.id, grid(), Array(cellCount(grid())).fill(kind()), { args: argv, account: chosenAccount(), prompt: isAgentKind(kind()) ? prompt().trim() || undefined : undefined });
    }
    // "This pane" falls back to a new tab if the empty pane was closed meanwhile.
    const place = w === "pane" ? { where: "tab" as const, into: into ?? undefined } : { where: w, into: undefined };
    if (ui() === "chat" && supportsChat(kind())) return void newChat(project.id, kind(), place.where, { account: chosenAccount(), into: place.into });
    void store.newSession(project.id, kind(), { ...place, args: argv, account: chosenAccount(), name: name().trim() || undefined, prompt: isAgentKind(kind()) ? prompt().trim() || undefined : undefined });
  };

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && store.setOverlay(null)}>
      <div class="modal" onKeyDown={(e) => {
        if (quickCommandKey(e, () => store.setOverlay(null))) return;
        if (e.key === "Escape") store.setOverlay(null);
        // Enter starts, except inside the prompt box (Ctrl/Cmd+Enter there).
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !(e.target as HTMLElement).matches("textarea"))) start();
      }}>
        <h2>{t("New session in {project}", { project: project?.name ?? "" })}</h2>
        <QuickCommandList onRun={() => store.setOverlay(null)} />
        <div class="launcher" style={{ "grid-template-columns": "repeat(auto-fill, minmax(92px, 1fr))" }}>
          <For each={kinds()}>
            {(k) => (
              <div class="launch-card" style={{ "flex-direction": "column", "border-color": kind() === k ? "var(--accent)" : undefined }} onClick={() => { setKind(k); setArgs(k === "custom" ? "" : profileArgs(k)); }}>
                <KindGlyph kind={k} size={30} />
                <div style={{ "font-size": "12px" }}>{kindInfo(k).label}</div>
              </div>
            )}
          </For>
        </div>
        <div class="form-row">
          <label>{kind() === "custom" ? t("Command") : kind() === "shell" ? t("Shell (empty = default)") : t("Extra arguments")}</label>
          <input ref={argsInput} class="text-input" value={args()} onInput={(e) => setArgs(e.currentTarget.value)} placeholder={kind() === "custom" ? "npm run dev" : kind() === "claude" ? "--model opus" : ""} />
        </div>
        <Show when={isAgentKind(kind()) && ui() === "terminal"}>
          <div class="form-row">
            <label>{t("First prompt (optional)")}</label>
            <textarea class="text-input" rows={2} value={prompt()} placeholder={t("What should the agent do? (Ctrl+Enter to start)")} onInput={(e) => setPrompt(e.currentTarget.value)} />
          </div>
        </Show>
        <div class="form-row">
          <label>{t("Name (optional)")}</label>
          <input class="text-input" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </div>
        <Show when={isAccountAgent(kind()) && accountsOf(kind() as "claude" | "codex").length}>
          <div class="form-row">
            <label>{t("Account")}</label>
            <div class="toggles">
              <button class={`toggle${chosenAccount() === "default" ? " on" : ""}`} onClick={() => setAccount("default")}>{t("Default")}</button>
              <For each={accountsOf(kind() as "claude" | "codex")}>
                {(a) => <button class={`toggle${chosenAccount() === a.id ? " on" : ""}`} onClick={() => setAccount(a.id)}>{a.label}</button>}
              </For>
            </div>
          </div>
        </Show>
        <Show when={supportsChat(kind()) && !project?.remote}>
          <div class="form-row">
            <label>{t("Interface")}</label>
            <div class="toggles">
              <button class={`toggle${ui() === "terminal" ? " on" : ""}`} onClick={() => setUi("terminal")}>{t("Terminal (TUI)")}</button>
              <button class={`toggle${ui() === "chat" ? " on" : ""}`} onClick={() => { setUi("chat"); if (where() === "grid") setWhere("tab"); }}>{t("Chat view")}</button>
            </div>
          </div>
        </Show>
        <div class="form-row">
          <label>{t("Open in")}</label>
          <div class="toggles">
            <Show when={into}>
              <button class={`toggle${where() === "pane" ? " on" : ""}`} onClick={() => setWhere("pane")}>{t("This pane")}</button>
            </Show>
            <button class={`toggle${where() === "tab" ? " on" : ""}`} onClick={() => setWhere("tab")}>{t("New tab")}</button>
            <button class={`toggle${where() === "right" ? " on" : ""}`} onClick={() => setWhere("right")}>{t("Split right")}</button>
            <button class={`toggle${where() === "down" ? " on" : ""}`} onClick={() => setWhere("down")}>{t("Split down")}</button>
            <button class={`toggle${where() === "grid" ? " on" : ""}`} disabled={ui() === "chat"} title={t("Several of this agent in a new tab, arranged in a grid")} onClick={() => setWhere("grid")}>{t("Grid…")}</button>
          </div>
        </div>
        <Show when={where() === "grid"}>
          <div class="form-row">
            <label>{t("Grid · {grid} · {n} sessions", { grid: gridLabel(grid()), n: cellCount(grid()) })}</label>
            <div class="layout-presets" style={{ "grid-template-columns": "repeat(10, 1fr)" }}>
              <For each={GRID_PRESETS}>
                {(spec) => (
                  <button class="layout-preset" style={{ "border-color": gridLabel(spec) === gridLabel(grid()) ? "var(--accent)" : undefined }} title={gridLabel(spec)} onClick={() => setGrid(spec)}>
                    <GridThumb spec={spec} size={28} />
                  </button>
                )}
              </For>
            </div>
            <input class="text-input" style={{ "margin-top": "6px" }} placeholder={t("Or panes per row, e.g. 3, 2")} onInput={(e) => { const c = parseCounts(e.currentTarget.value); if (c) setGrid({ mode: "rows", counts: c }); }} />
          </div>
        </Show>
        <div class="footer">
          <KeyHints items={[["Enter", t("Start")], ["Esc", t("Cancel")]]} />
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={() => store.setOverlay(null)}>{t("Cancel")}</button>
          <button class="btn primary" onClick={start}>{t("Start")}</button>
        </div>
      </div>
    </div>
  );
}
