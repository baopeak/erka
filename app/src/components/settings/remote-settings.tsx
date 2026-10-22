// Settings → Remote (SSH): the ssh config file remote projects use, and those projects.
import { For } from "solid-js";
import { store } from "../../lib/store";
import { t } from "../../lib/i18n";
import { hostLabel } from "../../lib/remote";
import { Icon } from "../icons";
import { SettingRow } from "./setting-row";

export function RemoteSettings() {
  const remotes = () => store.state.projects.filter((p) => p.remote);
  return (
    <>
      <SettingRow id="ssh-config">
        <input class="text-input mono" style={{ width: "360px" }} placeholder="~/.ssh/config" value={store.state.settings.sshConfig ?? ""}
          onChange={(e) => store.setSettings({ sshConfig: e.currentTarget.value.trim() })} />
      </SettingRow>
      <SettingRow id="remote-projects" wide>
        <div class="saved-layouts">
          <For each={remotes()} fallback={<div class="muted-inline">{t("No remote projects yet.")}</div>}>
            {(p) => (
              <div class="saved-layout">
                <Icon name="server" size={16} />
                <div class="saved-layout-main">
                  <div>{p.name}</div>
                  <div class="muted-inline mono" style={{ "font-size": "11.5px" }}>{hostLabel(p)}:{p.remote!.path}{p.remote!.tmux ? " · tmux" : ""}</div>
                </div>
                <button class="btn" onClick={() => { store.setOverlay(null); store.switchProject(p.id); }}>{t("Open")}</button>
              </div>
            )}
          </For>
          <button class="btn" style={{ "align-self": "flex-start" }} onClick={() => store.setOverlay("remote")}><Icon name="plus" size={13} /> {t("Add remote project")}</button>
        </div>
      </SettingRow>
    </>
  );
}
