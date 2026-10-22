// Shortcut editor: every command with its key; record a new key, remove or reset it. Warns
// about keys another command already uses and keys terminal programs rely on.
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { store } from "../../lib/store";
import { t, translated } from "../../lib/i18n";
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

/** Chords that can never be a shortcut (they would stop a character from being typed). */
function unusable(chord: string): string | null {
  const mods = chord.split("+").slice(0, -1);
  if (!mods.length) return t("Add Ctrl, Alt or Cmd: a single key belongs to the terminal.");
  if (mods.every((m) => m === "shift")) return t("Shift alone only changes the character typed; add Ctrl, Alt or Cmd.");
  return null;
}

/** Why a chord would be taken away from shells, agent TUIs or text editing, if it would. */
function tuiConflict(chord: string): string | null {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const letter = /^[a-z\[\]\\]$/.test(key);
  const is = (...m: string[]) => mods.length === m.length && m.every((x) => mods.includes(x));
  if (!isMac && is("mod", "shift") && (key === "c" || key === "v")) return t("Ctrl+Shift+{key} copies / pastes in terminals.", { key: key.toUpperCase() });
  if (isMac && is("mod") && "cvxza".includes(key) && key.length === 1) return t("⌘{key} is copy, paste, cut, undo or select-all everywhere.", { key: key.toUpperCase() });
  if (!isMac && is("mod", "alt")) return t("Ctrl+Alt is AltGr on many keyboard layouts: {key} may type a character there (e.g. @ € { }).", { key: key.toUpperCase() });
  if (!isMac && mods.length === 1 && mods[0] === "mod" && letter)
    return t("Ctrl+{key} is used by shells and agent TUIs (Ctrl+C, Ctrl+R history, Ctrl+P/N, Ctrl+J…); terminals would no longer receive it.", { key: key.toUpperCase() });
  if (isMac && mods.includes("ctrl") && !mods.includes("mod") && letter)
    return t("⌃{key} is a terminal control key; terminals would no longer receive it.", { key: key.toUpperCase() });
  if (mods.length === 1 && mods[0] === "alt" && letter)
    return t("{mod}{key} moves by word in shells and agent TUIs.", { mod: isMac ? "⌥" : "Alt+", key: key.toUpperCase() });
  return null;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

export function ShortcutSettings() {
  const [filter, setFilter] = createSignal("");
  const [recording, setRecording] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<Pending | null>(null);
  const [hint, setHint] = createSignal<string | null>(null);

  // The page search filters the table too, unless it matched the section itself.
  const query = () => {
    const q = settingsQuery().trim();
    return filter().trim() || (q && !entryMatches(catalogEntry("shortcuts")!, q) ? q : "");
  };
  const rows = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => {
      const hay = `${c.label} ${t(c.label)} ${c.id} ${chordOf(c) ? chordLabel(chordOf(c)!) : ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  });

  const stop = () => {
    window.removeEventListener("keydown", onKey, true);
    suspendKeymap(false);
    setRecording(null);
    setHint(null);
  };

  /** Back to the default key, unless another command holds it now. */
  function reset(id: string) {
    const c = commands.find((x) => x.id === id)!;
    const chord = defaultChordOf(c);
    const conflicts = chord ? commandsWithChord(chord, id).map((x) => x.label) : [];
    if (!chord || !conflicts.length) return store.setShortcut(id, null);
    setPending({ id, chord, conflicts, tui: null });
  }
  onCleanup(stop);

  function onKey(e: KeyboardEvent) {
    const id = recording();
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stop();
    if (MODIFIER_KEYS.has(e.key)) return;
    const chord = normalizeChord(eventChord(e));
    const problem = /^f\d{1,2}$/.test(chord.split("+").pop() ?? "") ? null : unusable(chord);
    if (problem) return setHint(problem); // keep recording
    stop();
    const next: Pending = { id, chord, conflicts: commandsWithChord(chord, id).map((c) => c.label), tui: tuiConflict(chord) };
    if (!next.conflicts.length && !next.tui) assign(next);
    else setPending(next);
  }

  function record(id: string) {
    setPending(null);
    setHint(null);
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
        <input class="text-input" placeholder={t("Filter commands or keys")} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        <Show when={pending()}>
          {(p) => (
            <div class="shortcut-warn" data-pending={p().id}>
              <div>
                <b>{chordLabel(p().chord)}</b> {t("for “{name}”", { name: t(commands.find((c) => c.id === p().id)?.label ?? "") })}
                <Show when={p().conflicts.length}><div>{t("Already used by {names} — assigning removes it there.", { names: p().conflicts.map((x) => t(x)).join(", ") })}</div></Show>
                <Show when={p().tui}><div>{p().tui}</div></Show>
              </div>
              <div class="inline-fields">
                <button class="btn primary" onClick={() => assign(p())}>{t("Assign anyway")}</button>
                <button class="btn" onClick={() => setPending(null)}>{t("Cancel")}</button>
              </div>
            </div>
          )}
        </Show>
        <div class="shortcut-table">
          <For each={rows()} fallback={<div class="muted">{t("No matching commands")}</div>}>
            {(c) => {
              const chord = () => chordOf(c);
              const overridden = () => store.state.keymap?.[c.id] !== undefined;
              return (
                <div class={`shortcut-row${recording() === c.id ? " recording" : ""}`} data-command={c.id}>
                  <span class="shortcut-label">{t(c.label)}</span>
                  <span class="shortcut-key">
                    <Show when={recording() === c.id} fallback={<Show when={chord()} fallback={<span class="muted-inline">—</span>}><span class="kbd">{chordLabel(chord()!)}</span></Show>}>
                      <span class="kbd live">{hint() ?? t("Press keys… (Esc cancels)")}</span>
                    </Show>
                    <Show when={chord() && commandsWithChord(chord()!, c.id).length}><span class="clash" title={t("Also bound to {names}", { names: commandsWithChord(chord()!, c.id).map((x) => t(x.label)).join(", ") })}>{t("clash")}</span></Show>
                    <Show when={overridden()}><span class="changed" title={t("Default: {key}", { key: defaultChordOf(c) ? chordLabel(defaultChordOf(c)!) : t("none") })}>{t("changed")}</span></Show>
                  </span>
                  <span class="shortcut-actions">
                    <button class="btn mini" onClick={() => record(c.id)}>{t("Change")}</button>
                    <Show when={chord()}><button class="btn mini" onClick={() => store.setShortcut(c.id, "")}>{t("Remove")}</button></Show>
                    <Show when={overridden()}><button class="btn mini" onClick={() => reset(c.id)}>{t("Reset")}</button></Show>
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
  return entryMatches(catalogEntry("shortcuts")!, q) || commands.some((c) => words.every((w) => `${c.label} ${translated(c.label) ?? ""}`.toLowerCase().includes(w)));
}
