// Scheduled automations: start an agent with a prompt on a schedule. Stored and run by the
// session daemon (`automation.*`), so they also run while the window is closed.
import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { store } from "../../lib/store";
import { daemon } from "../../lib/ipc";
import { kindInfo, launchableAgents } from "../../lib/agents";
import { relTimeShort } from "../../lib/platform";
import { KindGlyph } from "../icons";
import { SettingRow, Toggle } from "./setting-row";
import type { Automation } from "../../lib/types";

const ago = (t: number) => { const r = relTimeShort(t, Date.now()); return r === "now" ? "just now" : `${r} ago`; };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function scheduleLabel(a: Pick<Automation, "every" | "time" | "weekday">): string {
  if (a.every === "hourly") return `hourly at :${a.time.split(":")[1] ?? "00"}`;
  if (a.every === "weekly") return `${DAYS[a.weekday % 7]}s at ${a.time}`;
  return `${a.every === "weekdays" ? "weekdays" : "daily"} at ${a.time}`;
}

const blank = (): Automation => ({
  id: "", name: "", enabled: true, kind: "claude", prompt: "", cwd: store.activeProject()?.path ?? "", project_id: store.activeProject()?.id ?? null,
  args: [], every: "daily", time: "09:00", weekday: 1, last_run: 0, last_session: null, last_error: null, next_run: 0,
});

function Editor(props: { initial: Automation; onDone: () => void }) {
  const [a, setA] = createSignal<Automation>({ ...props.initial });
  const set = (patch: Partial<Automation>) => setA({ ...a(), ...patch });
  const save = async () => {
    try {
      await daemon("automation.save", a());
      props.onDone();
    } catch (e) {
      store.notify(String(e), undefined, 8000);
    }
  };
  const pickProject = (id: string) => {
    const p = store.state.projects.find((x) => x.id === id);
    if (p) set({ project_id: p.id, cwd: p.path });
  };
  return (
    <div class="automation-editor">
      <label class="field"><span>Name</span><input class="text-input" value={a().name} placeholder="Weekday triage" onInput={(e) => set({ name: e.currentTarget.value })} /></label>
      <div class="inline-fields">
        <label class="field" style={{ flex: 1 }}>
          <span>Agent</span>
          <select class="text-input" value={a().kind} onChange={(e) => set({ kind: e.currentTarget.value })}>
            <For each={launchableAgents(store.state.settings.hiddenAgents)}>{(k) => <option value={k}>{kindInfo(k).label}</option>}</For>
          </select>
        </label>
        <label class="field" style={{ flex: 2 }}>
          <span>Project</span>
          <select class="text-input" value={a().project_id ?? ""} onChange={(e) => pickProject(e.currentTarget.value)}>
            <Show when={!a().project_id}><option value="">{a().cwd || "Choose a project"}</option></Show>
            <For each={store.state.projects}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </label>
      </div>
      <div class="inline-fields">
        <label class="field">
          <span>Every</span>
          <select class="text-input" value={a().every} onChange={(e) => set({ every: e.currentTarget.value as Automation["every"] })}>
            <option value="hourly">Hour</option><option value="daily">Day</option><option value="weekdays">Weekday (Mon–Fri)</option><option value="weekly">Week</option>
          </select>
        </label>
        <Show when={a().every === "weekly"}>
          <label class="field">
            <span>On</span>
            <select class="text-input" value={a().weekday} onChange={(e) => set({ weekday: +e.currentTarget.value })}>
              <For each={DAYS}>{(d, i) => <option value={i()}>{d}</option>}</For>
            </select>
          </label>
        </Show>
        <label class="field">
          <span>{a().every === "hourly" ? "At minute" : "At"}</span>
          <input class="text-input" type="time" value={a().time} onInput={(e) => set({ time: e.currentTarget.value || "09:00" })} />
        </label>
      </div>
      <label class="field"><span>Prompt</span><textarea class="text-input" rows={4} value={a().prompt} placeholder="Triage new issues and summarize blockers" onInput={(e) => set({ prompt: e.currentTarget.value })} /></label>
      <div class="inline-fields" style={{ "justify-content": "flex-end" }}>
        <button class="btn" onClick={props.onDone}>Cancel</button>
        <button class="btn primary" disabled={!a().name.trim() || !a().prompt.trim() || !a().cwd} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}

export function AutomationSettings() {
  const [list, { refetch }] = createResource(() => store.connected(), () => daemon<Automation[]>("automation.list").catch(() => [] as Automation[]));
  const [editing, setEditing] = createSignal<Automation | null>(null);
  onMount(() => {
    const on = () => void refetch();
    window.addEventListener("erka:automations", on);
    onCleanup(() => window.removeEventListener("erka:automations", on));
  });
  const toggle = (a: Automation, enabled: boolean) => void daemon("automation.save", { ...a, enabled }).catch((e) => store.notify(String(e)));
  const run = (a: Automation) => void daemon("automation.run", { id: a.id }).then(() => store.notify(`Started ${a.name}`), (e) => store.notify(String(e)));
  const remove = (a: Automation) => confirm(`Delete the automation “${a.name}”?`) && void daemon("automation.delete", { id: a.id }).catch((e) => store.notify(String(e)));

  return (
    <SettingRow id="automations" wide>
      <div class="automations">
        <Show when={editing()} keyed fallback={<button class="btn" style={{ "align-self": "flex-start" }} onClick={() => setEditing(blank())}>New automation</button>}>
          {(a) => <Editor initial={a} onDone={() => { setEditing(null); void refetch(); }} />}
        </Show>
        <For each={list() ?? []} fallback={<div class="muted">No automations yet.</div>}>
          {(a) => (
            <div class={`automation-item${a.enabled ? "" : " paused"}`}>
              <KindGlyph kind={a.kind} size={18} />
              <div class="automation-text">
                <div class="automation-name">{a.name}</div>
                <div class="muted-inline">
                  {scheduleLabel(a)} · {store.state.projects.find((p) => p.id === a.project_id)?.name ?? a.cwd}
                  {a.enabled && a.next_run ? ` · next ${new Date(a.next_run).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                  {a.last_run ? ` · last run ${ago(a.last_run)}${a.last_error ? " (failed)" : ""}` : ""}
                </div>
                <Show when={a.last_error}><div class="automation-error">{a.last_error}</div></Show>
              </div>
              <button class="link-btn" onClick={() => run(a)}>Run now</button>
              <button class="link-btn" onClick={() => setEditing(a)}>Edit</button>
              <button class="link-btn danger" onClick={() => remove(a)}>Delete</button>
              <Toggle on={a.enabled} onChange={(on) => toggle(a, on)} label="Enabled" />
            </div>
          )}
        </For>
      </div>
    </SettingRow>
  );
}
