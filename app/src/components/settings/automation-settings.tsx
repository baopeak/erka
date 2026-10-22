// Scheduled automations: start an agent with a prompt on a schedule. Stored and run by the
// session daemon (`automation.*`), so they also run while the window is closed.
import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { store } from "../../lib/store";
import { daemon } from "../../lib/ipc";
import { kindInfo, launchableAgents } from "../../lib/agents";
import { formatDateTime, formatRelative, msg, t } from "../../lib/i18n";
import { KindGlyph } from "../icons";
import { SettingRow, Toggle } from "./setting-row";
import type { Automation } from "../../lib/types";
import { HOME_VAR, accountsOf, activeAccount, isAccountAgent, type AccountAgent } from "../../lib/accounts";
import { confirmDialog } from "../../lib/confirm-dialog";

const DAYS = [msg("Sunday"), msg("Monday"), msg("Tuesday"), msg("Wednesday"), msg("Thursday"), msg("Friday"), msg("Saturday")];

export function scheduleLabel(a: Pick<Automation, "every" | "time" | "weekday">): string {
  if (a.every === "hourly") return t("hourly at :{minute}", { minute: a.time.split(":")[1] ?? "00" });
  if (a.every === "weekly") return t("{day}s at {time}", { day: t(DAYS[a.weekday % 7]), time: a.time });
  return a.every === "weekdays" ? t("weekdays at {time}", { time: a.time }) : t("daily at {time}", { time: a.time });
}

const blank = (): Automation => ({
  id: "", name: "", enabled: true, kind: "claude", prompt: "", cwd: store.activeProject()?.path ?? "", project_id: store.activeProject()?.id ?? null,
  args: [], every: "daily", time: "09:00", weekday: 1, last_run: 0, last_session: null, last_error: null, next_run: 0,
});

function Editor(props: { initial: Automation; onDone: () => void }) {
  const [a, setA] = createSignal<Automation>({ ...props.initial });
  const set = (patch: Partial<Automation>) => setA({ ...a(), ...patch });
  const [account, setAccount] = createSignal<string>(
    (isAccountAgent(props.initial.kind) && accountsOf(props.initial.kind).find((x) => props.initial.env?.[HOME_VAR[props.initial.kind as AccountAgent]] === x.dir)?.id) || (props.initial.id ? "default" : activeAccount(props.initial.kind as AccountAgent)?.id ?? "default"),
  );
  const save = async () => {
    try {
      // Runs with the agent profile's environment on the chosen account.
      await daemon("automation.save", { ...a(), env: store.profileLaunch(a().kind, { account: account() }).env ?? {} });
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
      <label class="field"><span>{t("Name")}</span><input class="text-input" value={a().name} placeholder={t("Weekday triage")} onInput={(e) => set({ name: e.currentTarget.value })} /></label>
      <div class="inline-fields">
        <label class="field" style={{ flex: 1 }}>
          <span>{t("Agent")}</span>
          <select class="text-input" value={a().kind} onChange={(e) => set({ kind: e.currentTarget.value })}>
            <For each={launchableAgents(store.state.settings.hiddenAgents)}>{(k) => <option value={k}>{kindInfo(k).label}</option>}</For>
          </select>
        </label>
        <Show when={isAccountAgent(a().kind) && accountsOf(a().kind as AccountAgent).length}>
          <label class="field" style={{ flex: 1 }}>
            <span>{t("Account")}</span>
            <select class="text-input" value={account()} onChange={(e) => setAccount(e.currentTarget.value)}>
              <option value="default">{t("Default")}</option>
              <For each={accountsOf(a().kind as AccountAgent)}>{(x) => <option value={x.id}>{x.label}</option>}</For>
            </select>
          </label>
        </Show>
        <label class="field" style={{ flex: 2 }}>
          <span>{t("Project")}</span>
          <select class="text-input" value={a().project_id ?? ""} onChange={(e) => pickProject(e.currentTarget.value)}>
            <Show when={!a().project_id}><option value="">{a().cwd || t("Choose a project")}</option></Show>
            <For each={store.state.projects}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </label>
      </div>
      <div class="inline-fields">
        <label class="field">
          <span>{t("Every")}</span>
          <select class="text-input" value={a().every} onChange={(e) => set({ every: e.currentTarget.value as Automation["every"] })}>
            <option value="hourly">{t("Hour")}</option><option value="daily">{t("Day")}</option><option value="weekdays">{t("Weekday (Mon–Fri)")}</option><option value="weekly">{t("Week")}</option>
          </select>
        </label>
        <Show when={a().every === "weekly"}>
          <label class="field">
            <span>{t("On")}</span>
            <select class="text-input" value={a().weekday} onChange={(e) => set({ weekday: +e.currentTarget.value })}>
              <For each={DAYS}>{(d, i) => <option value={i()}>{t(d)}</option>}</For>
            </select>
          </label>
        </Show>
        <label class="field">
          <span>{a().every === "hourly" ? t("At minute") : t("At")}</span>
          <input class="text-input" type="time" value={a().time} onInput={(e) => set({ time: e.currentTarget.value || "09:00" })} />
        </label>
      </div>
      <label class="field"><span>{t("Prompt")}</span><textarea class="text-input" rows={4} value={a().prompt} placeholder={t("Triage new issues and summarize blockers")} onInput={(e) => set({ prompt: e.currentTarget.value })} /></label>
      <div class="inline-fields" style={{ "justify-content": "flex-end" }}>
        <button class="btn" onClick={props.onDone}>{t("Cancel")}</button>
        <button class="btn primary" disabled={!a().name.trim() || !a().prompt.trim() || !a().cwd} onClick={() => void save()}>{t("Save")}</button>
      </div>
    </div>
  );
}

export function AutomationSettings() {
  const [list, { refetch }] = createResource(() => store.connected(), () => daemon<Automation[]>("automation.list").catch(() => [] as Automation[]));
  const [editing, setEditing] = createSignal<Automation | null>(null);
  onMount(() => {
    const on = () => void refetch();
    window.addEventListener("kelpie:automations", on);
    onCleanup(() => window.removeEventListener("kelpie:automations", on));
  });
  const toggle = (a: Automation, enabled: boolean) => void daemon("automation.save", { ...a, enabled }).catch((e) => store.notify(String(e)));
  const run = (a: Automation) => void daemon("automation.run", { id: a.id }).then(() => store.notify(t("Started {name}", { name: a.name })), (e) => store.notify(String(e)));
  const remove = async (a: Automation) => (await confirmDialog(t("Delete the automation “{name}”?", { name: a.name }))) && void daemon("automation.delete", { id: a.id }).catch((e) => store.notify(String(e)));

  return (
    <SettingRow id="automations" wide>
      <div class="automations">
        <Show when={editing()} keyed fallback={<button class="btn" style={{ "align-self": "flex-start" }} onClick={() => setEditing(blank())}>{t("New automation")}</button>}>
          {(a) => <Editor initial={a} onDone={() => { setEditing(null); void refetch(); }} />}
        </Show>
        <For each={list() ?? []} fallback={<div class="muted">{t("No automations yet.")}</div>}>
          {(a) => (
            <div class={`automation-item${a.enabled ? "" : " paused"}`}>
              <KindGlyph kind={a.kind} size={18} />
              <div class="automation-text">
                <div class="automation-name">{a.name}</div>
                <div class="muted-inline">
                  {scheduleLabel(a)} · {store.state.projects.find((p) => p.id === a.project_id)?.name ?? a.cwd}
                  {a.enabled && a.next_run ? ` · ${t("next {when}", { when: formatDateTime(a.next_run, { weekday: "short", hour: "2-digit", minute: "2-digit" }) })}` : ""}
                  {a.last_run ? ` · ${t("last run {when}", { when: formatRelative(a.last_run) })}${a.last_error ? ` ${t("(failed)")}` : ""}` : ""}
                </div>
                <Show when={a.last_error}><div class="automation-error">{a.last_error}</div></Show>
              </div>
              <button class="link-btn" onClick={() => run(a)}>{t("Run now")}</button>
              <button class="link-btn" onClick={() => setEditing(a)}>{t("Edit")}</button>
              <button class="link-btn danger" onClick={() => remove(a)}>{t("Delete")}</button>
              <Toggle on={a.enabled} onChange={(on) => toggle(a, on)} label={t("Enabled")} />
            </div>
          )}
        </For>
      </div>
    </SettingRow>
  );
}
