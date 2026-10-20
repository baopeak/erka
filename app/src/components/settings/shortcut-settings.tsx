// Shortcut editor: every command with its key; record a new key, remove or reset it. Warns
// about keys another command already uses and keys terminal programs rely on.
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { store } from "../../lib/store";
import { commands, chordOf, commandsWithChord, defaultChordOf, eventChord, normalizeChord, suspendKeymap } from "../../lib/commands";
import { chordLabel, isMac } from "../../lib/platform";
import { entryMatches, catalogEntry } from "../../lib/settings-catalog";
import { SettingRow, settingsQuery } from "./setting-row";

interface Pending {
  id: string;
  chord: string;
  conflicts: string[];
  tui: string | null;
}

/** Why a chord would be taken away from shells and agent TUIs, if it would. */
function tuiConflict(chord: string): string | null {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const letter = /^[a-z\[\]\\]$/.test(key);
  if (!isMac && mods.length === 1 && mods[0] === "mod" && letter)
    return `Ctrl+${key.toUpperCase()} is used by shells and agent TUIs (Ctrl+C, Ctrl+R history, Ctrl+P/N, Ctrl+J…); terminals would no longer receive it.`;
  if (isMac && mods.includes("ctrl") && !mods.includes("mod") && letter)
    return `⌃${key.toUpperCase()} is a terminal control key; terminals would no longer receive it.`;
  if (mods.length === 1 && mods[0] === "alt" && letter)
    return `${isMac ? "⌥" : "Alt+"}${key.toUpperCase()} moves by word in shells and agent TUIs.`;
  return null;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

export function ShortcutSettings() {
  const [filter, setFilter] = createSignal("");
  const [recording, setRecording] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<Pending | null>(null);

  // The page search filters the table too, unless it matched the section itself.
  const query = () => {
    const q = settingsQuery().trim();
    return filter().trim() || (q && !entryMatches(catalogEntry("shortcuts")!, q) ? q : "");
  };
  const rows = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => {
      const hay = `${c.label} ${c.id} ${chordOf(c) ? chordLabel(chordOf(c)!) : ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  });

  const stop = () => {
    window.removeEventListener("keydown", onKey, true);
    suspendKeymap(false);
    setRecording(null);
  };
  onCleanup(stop);

  function onKey(e: KeyboardEvent) {
    const id = recording();
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stop();
    if (MODIFIER_KEYS.has(e.key)) return;
    const chord = normalizeChord(eventChord(e));
    const hasModifier = chord.includes("+");
    if (!hasModifier && !/^f\d{1,2}$/.test(chord)) return; // bare keys belong to the terminal
    stop();
    const next: Pending = { id, chord, conflicts: commandsWithChord(chord, id).map((c) => c.label), tui: tuiConflict(chord) };
    if (!next.conflicts.length && !next.tui) assign(next);
    else setPending(next);
  }

  function record(id: string) {
    setPending(null);
    setRecording(id);
    suspendKeymap(true);
    window.addEventListener("keydown", onKey, true);
  }

  function assign(p: Pending) {
    for (const c of commandsWithChord(p.chord, p.id)) store.setShortcut(c.id, "");
    store.setShortcut(p.id, p.chord);
    setPending(null);
  }

  return (
    <SettingRow id="shortcuts" wide match={shortcutsMatch}>
      <div class="shortcuts">
        <input class="text-input" placeholder="Filter commands or keys" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        <Show when={pending()}>
          {(p) => (
            <div class="shortcut-warn" data-pending={p().id}>
              <div>
                <b>{chordLabel(p().chord)}</b> for “{commands.find((c) => c.id === p().id)?.label}”
                <Show when={p().conflicts.length}><div>Already used by {p().conflicts.join(", ")} — assigning removes it there.</div></Show>
                <Show when={p().tui}><div>{p().tui}</div></Show>
              </div>
              <div class="inline-fields">
                <button class="btn primary" onClick={() => assign(p())}>Assign anyway</button>
                <button class="btn" onClick={() => setPending(null)}>Cancel</button>
              </div>
            </div>
          )}
        </Show>
        <div class="shortcut-table">
          <For each={rows()} fallback={<div class="muted">No matching commands</div>}>
            {(c) => {
              const chord = () => chordOf(c);
              const overridden = () => store.state.keymap?.[c.id] !== undefined;
              return (
                <div class={`shortcut-row${recording() === c.id ? " recording" : ""}`} data-command={c.id}>
                  <span class="shortcut-label">{c.label}</span>
                  <span class="shortcut-key">
                    <Show when={recording() === c.id} fallback={<Show when={chord()} fallback={<span class="muted-inline">—</span>}><span class="kbd">{chordLabel(chord()!)}</span></Show>}>
                      <span class="kbd live">Press keys… (Esc cancels)</span>
                    </Show>
                    <Show when={overridden()}><span class="changed" title={`Default: ${defaultChordOf(c) ? chordLabel(defaultChordOf(c)!) : "none"}`}>changed</span></Show>
                  </span>
                  <span class="shortcut-actions">
                    <button class="btn mini" onClick={() => record(c.id)}>Change</button>
                    <Show when={chord()}><button class="btn mini" onClick={() => store.setShortcut(c.id, "")}>Remove</button></Show>
                    <Show when={overridden()}><button class="btn mini" onClick={() => store.setShortcut(c.id, null)}>Reset</button></Show>
                  </span>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </SettingRow>
  );
}

/** The shortcuts section shows when the page search matches it or any command. */
export function shortcutsMatch(q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return entryMatches(catalogEntry("shortcuts")!, q) || commands.some((c) => words.every((w) => c.label.toLowerCase().includes(w)));
}
