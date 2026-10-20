// Session Daemon and About sections.
import { Show, createResource } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { store } from "../../lib/store";
import { daemon, platformInfo, revealEntry } from "../../lib/ipc";
import { SettingRow } from "./setting-row";

interface DaemonInfo {
  version: string;
  protocol: number;
  api?: number;
  pid: number;
  data_dir: string;
  endpoint: string;
  sessions: number;
}

const [platform] = createResource(() => platformInfo().catch(() => null));

export function DaemonSettings() {
  const [info, { refetch }] = createResource(() => store.connected(), () => daemon<DaemonInfo>("daemon.info").catch(() => null));
  const stopAll = async () => {
    if (!confirm("Stop the session daemon and every running session?")) return;
    await daemon("daemon.shutdown", { kill_sessions: true }).catch(() => {});
    setTimeout(() => void refetch(), 1500);
  };
  return (
    <>
      <SettingRow id="daemon-info">
        <Show when={info()} fallback={<span class="muted-inline">Not connected</span>}>
          {(d) => (
            <div class="kv">
              <span>Version</span><span>{d().version}</span>
              <span>Process</span><span>pid {d().pid} · {d().sessions} sessions</span>
              <span>Endpoint</span><span class="mono">{d().endpoint}</span>
            </div>
          )}
        </Show>
      </SettingRow>
      <SettingRow id="daemon-data">
        <div class="kv">
          <span>Folder</span><span class="mono">{info()?.data_dir ?? platform()?.data_dir ?? ""}</span>
        </div>
        <div class="inline-fields">
          <button class="btn" onClick={() => void revealEntry(info()?.data_dir ?? platform()!.data_dir, "").catch((e) => store.notify(String(e)))}>Open folder</button>
          <button class="btn" onClick={() => void revealEntry(info()?.data_dir ?? platform()!.data_dir, "logs/erkad.log").catch((e) => store.notify(String(e)))}>Show log file</button>
        </div>
      </SettingRow>
      <SettingRow id="daemon-stop">
        <button class="btn danger" onClick={() => void stopAll()}>Stop daemon & all sessions</button>
      </SettingRow>
    </>
  );
}

export function AboutSettings() {
  const [version] = createResource(() => getVersion().catch(() => "?"));
  return (
    <SettingRow id="version">
      <div class="kv">
        <span>Erka</span><span>{version()}</span>
        <span>Platform</span><span>{platform()?.os ?? ""}</span>
        <span>Stack</span><span>Tauri 2 · SolidJS · xterm.js · Rust session daemon</span>
      </div>
    </SettingRow>
  );
}
