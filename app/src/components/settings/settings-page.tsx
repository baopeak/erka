// Settings as a full page: grouped navigation on the left, one section at a time on the right,
// and a search box (Ctrl/Cmd+F) that shows every matching row across sections.
import { For, createMemo, onCleanup, onMount, type JSX } from "solid-js";
import { store } from "../../lib/store";
import { isMac } from "../../lib/platform";
import { settingsCatalog, settingsSections, entryMatches, type SettingsSection } from "../../lib/settings-catalog";
import { QuickCommandsEditor } from "../quick-commands";
import { Icon } from "../icons";
import { SettingRow, setSettingsQuery, settingsQuery } from "./setting-row";
import { AgentSettings } from "./agent-settings";
import { AppearanceSettings, NotificationSettings, TerminalSettings, UsageSettings } from "./interface-settings";
import { ShortcutSettings, shortcutsMatch } from "./shortcut-settings";
import { AboutSettings, DaemonSettings } from "./system-settings";

const SECTIONS: Record<SettingsSection, () => JSX.Element> = {
  agents: AgentSettings,
  commands: () => (
    <SettingRow id="quick-commands" wide>
      <QuickCommandsEditor />
    </SettingRow>
  ),
  terminal: TerminalSettings,
  appearance: AppearanceSettings,
  shortcuts: ShortcutSettings,
  notifications: NotificationSettings,
  usage: UsageSettings,
  daemon: DaemonSettings,
  about: AboutSettings,
};

const sectionMatches = (id: SettingsSection, q: string) =>
  id === "shortcuts" ? shortcutsMatch(q) : settingsCatalog.some((e) => e.section === id && entryMatches(e, q));

export function SettingsPage() {
  let search!: HTMLInputElement;
  let page!: HTMLDivElement;
  const query = () => settingsQuery().trim();
  const groups = createMemo(() => {
    const out: { group: string; items: typeof settingsSections }[] = [];
    for (const s of settingsSections) {
      if (out[out.length - 1]?.group !== s.group) out.push({ group: s.group, items: [] });
      out[out.length - 1].items.push(s);
    }
    return out;
  });
  const shown = createMemo(() => (query() ? settingsSections.filter((s) => sectionMatches(s.id, query())) : settingsSections.filter((s) => s.id === store.settingsSection())));

  const close = () => store.setOverlay(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      if (query()) setSettingsQuery("");
      else close();
      return;
    }
    if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      search.focus();
      search.select();
    }
  };
  onMount(() => {
    setSettingsQuery("");
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => (store.settingsItem() ? page.focus() : search.focus()));
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="settings-page" ref={page} tabIndex={-1}>
      <nav class="settings-nav">
        <button class="settings-back" onClick={close} title="Back (Esc)"><Icon name="back" size={14} /> Settings</button>
        <For each={groups()}>
          {(g) => (
            <>
              <div class="settings-group">{g.group}</div>
              <For each={g.items}>
                {(s) => (
                  <button class={`settings-link${!query() && store.settingsSection() === s.id ? " on" : ""}${query() && !sectionMatches(s.id, query()) ? " dim" : ""}`}
                    data-section={s.id}
                    onClick={() => { setSettingsQuery(""); store.setSettingsSection(s.id); }}>
                    {s.label}
                  </button>
                )}
              </For>
            </>
          )}
        </For>
      </nav>
      <main class="settings-main">
        <div class="settings-search">
          <Icon name="search" size={14} />
          <input ref={search} placeholder={`Search settings (${isMac ? "⌘F" : "Ctrl+F"})`} value={settingsQuery()} onInput={(e) => setSettingsQuery(e.currentTarget.value)} />
        </div>
        <div class="settings-scroll">
          <For each={shown()} fallback={<div class="muted">No settings match “{query()}”.</div>}>
            {(s) => (
              <section class="settings-section" data-section={s.id}>
                <h2>{s.label}</h2>
                {SECTIONS[s.id]()}
              </section>
            )}
          </For>
        </div>
      </main>
    </div>
  );
}
