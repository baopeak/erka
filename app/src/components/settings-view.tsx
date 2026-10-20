import { For } from "solid-js";
import { store } from "../lib/store";
import { allViews } from "../lib/terminal-host";
import { daemon } from "../lib/ipc";
import { kindMeta } from "./icons";
import { QuickCommandsEditor } from "./quick-commands";
import type { Settings } from "../lib/types";

export function SettingsView() {
  const s = () => store.state.settings;
  const set = (patch: Partial<Settings>) => {
    store.setSettings(patch);
    for (const v of allViews()) v.applySettings(store.state.settings);
  };
  const setProfileArgs = (kind: string, value: string) => {
    const profiles = s().profiles.map((p) => (p.kind === kind ? { ...p, args: value.trim() ? value.trim().split(/\s+/) : [] } : p));
    store.setSettings({ profiles });
  };
  const stopAll = async () => {
    if (!confirm("Stop the session daemon and every running session?")) return;
    await daemon("daemon.shutdown", { kill_sessions: true }).catch(() => {});
  };

  return (
    <div class="overlay" onPointerDown={(e) => e.target === e.currentTarget && store.setOverlay(null)}>
      <div class="modal" tabIndex={-1} ref={(el) => queueMicrotask(() => el.focus())} onKeyDown={(e) => e.key === "Escape" && store.setOverlay(null)}>
        <h2>Settings</h2>
        <div class="form-row">
          <label>Terminal font</label>
          <input class="text-input" value={s().fontFamily} onChange={(e) => set({ fontFamily: e.currentTarget.value })} />
        </div>
        <div class="form-row">
          <label>Font size / line height</label>
          <div style={{ display: "flex", gap: "8px" }}>
            <input class="text-input" type="number" min="8" max="28" value={s().fontSize} onChange={(e) => set({ fontSize: +e.currentTarget.value || 13 })} />
            <input class="text-input" type="number" step="0.05" min="1" max="2" value={s().lineHeight} onChange={(e) => set({ lineHeight: +e.currentTarget.value || 1.2 })} />
          </div>
        </div>
        <div class="form-row">
          <label>Scrollback lines</label>
          <input class="text-input" type="number" min="500" max="100000" step="500" value={s().scrollback} onChange={(e) => set({ scrollback: +e.currentTarget.value || 5000 })} />
        </div>
        <div class="form-row">
          <label>Renderer</label>
          <div class="toggles">
            <button class={`toggle${s().webgl ? " on" : ""}`} onClick={() => set({ webgl: true })}>WebGL (GPU)</button>
            <button class={`toggle${!s().webgl ? " on" : ""}`} onClick={() => set({ webgl: false })}>DOM</button>
          </div>
        </div>
        <div class="form-row">
          <label>Cursor blink</label>
          <div class="toggles">
            <button class={`toggle${s().cursorBlink ? " on" : ""}`} onClick={() => set({ cursorBlink: !s().cursorBlink })}>{s().cursorBlink ? "On" : "Off"}</button>
          </div>
        </div>
        <div class="form-row">
          <label>Desktop notifications</label>
          <div class="toggles">
            <button class={`toggle${s().notifications ? " on" : ""}`} onClick={() => set({ notifications: !s().notifications })}>{s().notifications ? "On" : "Off"}</button>
          </div>
        </div>
        <div class="form-row">
          <label>Status bar meters</label>
          <div class="toggles">
            <button class={`toggle${s().usageMeters ? " on" : ""}`} title="Claude / Codex plan usage, read with the agents' own sign-in" onClick={() => set({ usageMeters: !s().usageMeters })}>Usage {s().usageMeters ? "on" : "off"}</button>
            <button class={`toggle${s().memoryMeter ? " on" : ""}`} onClick={() => set({ memoryMeter: !s().memoryMeter })}>RAM {s().memoryMeter ? "on" : "off"}</button>
          </div>
        </div>
        <div class="form-row">
          <label>Default shell command</label>
          <input class="text-input" placeholder="(system default)" value={s().shellArgs.join(" ")} onChange={(e) => set({ shellArgs: e.currentTarget.value.trim() ? e.currentTarget.value.trim().split(/\s+/) : [] })} />
        </div>
        <For each={s().profiles}>
          {(p) => (
            <div class="form-row">
              <label>{kindMeta[p.kind]?.label ?? p.label} args</label>
              <input class="text-input" value={p.args.join(" ")} placeholder="e.g. --model opus" onChange={(e) => setProfileArgs(p.kind, e.currentTarget.value)} />
            </div>
          )}
        </For>
        <div class="form-row" data-section="commands">
          <label>Quick commands</label>
          <QuickCommandsEditor />
        </div>
        <div class="footer">
          <button class="btn danger" onClick={() => void stopAll()}>Stop daemon & all sessions</button>
          <span style={{ flex: 1 }} />
          <button class="btn primary" onClick={() => store.setOverlay(null)}>Done</button>
        </div>
      </div>
    </div>
  );
}
