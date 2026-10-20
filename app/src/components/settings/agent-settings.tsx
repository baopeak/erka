// Agents: per-agent arguments, permission mode and environment for new sessions.
import { For, Show } from "solid-js";
import { store } from "../../lib/store";
import { SettingRow } from "./setting-row";
import type { AgentProfile } from "../../lib/types";

/** Permission flags each agent understands; "" keeps the agent's own default. */
const PERMISSIONS: Record<string, [string, string][]> = {
  claude: [["", "Default"], ["acceptEdits", "Accept edits"], ["plan", "Plan only"], ["bypassPermissions", "Bypass (no prompts)"]],
  codex: [["", "Default"], ["untrusted", "Untrusted"], ["on-request", "On request"], ["never", "Never ask"]],
};

const parseArgs = (v: string) => v.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [];
const formatArgs = (a: string[]) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

export function AgentSettings() {
  const update = (kind: AgentProfile["kind"], patch: Partial<AgentProfile>) => store.setProfile(kind, patch);

  return (
    <For each={store.state.settings.profiles}>
      {(p) => (
        <SettingRow id={`agent-${p.kind}`} wide>
          <div class="agent-card">
            <label class="field">
              <span>Arguments</span>
              <input class="text-input" value={formatArgs(p.args)} placeholder={p.kind === "codex" ? "e.g. --model gpt-5" : "e.g. --model opus"}
                onChange={(e) => update(p.kind, { args: parseArgs(e.currentTarget.value) })} />
            </label>
            <Show when={PERMISSIONS[p.kind]}>
              <label class="field">
                <span>{p.kind === "codex" ? "Approval policy" : "Permission mode"}</span>
                <select class="text-input" value={p.permission ?? ""} onChange={(e) => update(p.kind, { permission: e.currentTarget.value || undefined })}>
                  <For each={PERMISSIONS[p.kind]}>{([v, label]) => <option value={v}>{label}</option>}</For>
                </select>
              </label>
            </Show>
            <label class="field">
              <span>Environment</span>
              <textarea class="text-input" rows={2} placeholder="KEY=value, one per line (stored in Erka's settings file as plain text)"
                value={Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
                onChange={(e) => update(p.kind, { env: parseEnv(e.currentTarget.value) })} />
            </label>
          </div>
        </SettingRow>
      )}
    </For>
  );
}
