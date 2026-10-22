# Code Review: Erka to Kelpie rename (uncommitted working tree vs HEAD 933a178)

## Scope
- Branch `rebrand/kelpie`, 145 changed files plus the renamed crates and scripts. I read `scripts/rename-to-kelpie.py`, all the hand edits (legacy fallbacks, migration, brand/theme) and every cross-boundary name.
- Method: read-only. I used `git diff`, `git grep` against HEAD and the working tree, and file reads. I ran no cargo, pnpm or vite.
- Focus: upgrade path for existing Erka users, names shared across processes, theme tokens.

## Overall assessment
The mechanical rename is consistent. Every name that crosses a process or language boundary changed on both sides at once, and nothing the regex missed is still in use.

The problems are in the **upgrade path**. The migration copies state that still refers to the old install by absolute path or by old name. It also ignores the old session daemon, which outlives the app by design, and it cannot recover if it is interrupted. None of this shows up in unit tests or the build.

---

## High

### H1. The old `erkad` keeps running, and Kelpie resumes copies of its live sessions
- Where: `crates/kelpie-proto/src/lib.rs:245-259` (`migrate_legacy_data_dir`), `crates/kelpied/src/daemon.rs:508-529` (`restore` marks `alive` sessions as interrupted), `app/src/lib/store.ts:1070-1081` (`resumeInterrupted`, default `"shown"` mode).
- Kelpie uses the pipe `kelpie-<user>-v1`, so it never sees the old daemon on `erka-<user>-v1`. Nothing stops the old daemon: there is no NSIS hook and no check in the migration.
- What goes wrong:
  1. The user installs Kelpie. The Erka window is closed, but `erkad.exe` still runs the agents.
  2. Kelpie copies `sessions.json`, where those sessions are `alive: true`.
  3. `kelpied` restores them as interrupted.
  4. The UI auto-resumes every visible one, so a second `claude --resume <same id>` starts in the same worktree while the original keeps running headless under `erkad`. The result is two writers on one transcript and conflicting edits.
  5. If phone access is on, `kelpied`'s mobile autostart also fails to bind the port the old daemon still holds.
- The README makes this worse. `README.md:277` says "Quit Erka before the first start", but quitting the app does not stop `erkad`.
- Fix:
  - Before copying, check for a live legacy daemon. Either try to open `<legacy>/erkad.lock` with `share_mode(0)` (Unix: `flock` / connect `erkad-v1.sock`), or connect to `\\.\pipe\erka-<user>-v1`.
  - If it is live, ask it to stop (`daemon.shutdown`, ideally with `kill_sessions: true` after the user confirms) and copy only after it has exited. Otherwise, skip the migration for this launch and tell the user.
  - At minimum, do not auto-resume sessions on the launch that ran the migration.
  - Change the README to say `erkad stop --kill-sessions` (from the old install folder) before the first start.

### H2. Copied state still points into `%LOCALAPPDATA%\Erka` by absolute path and uses old env names
These paths and names are stored, not recomputed:
- **Accounts:**
  - `settings.accounts[].dir` in `app-state.json` comes from `account_create` (`app/src/lib/accounts.ts:66-68`).
  - It is turned into `CLAUDE_CONFIG_DIR` / `CODEX_HOME` for every new session (`accounts.ts:35-38`).
  - The same path is stored in each session's `spec.env` (`crates/kelpied/src/session.rs:53`, reused by `session.restart` at `daemon.rs:575-576`).
  - It is also stored in history items' `home`.
- **SSH sessions on saved hosts:**
  - `ssh_session_env` (`app/src-tauri/src/ssh_hosts.rs:408-416`) returns `SSH_ASKPASS=<...\Erka\erkad.exe>` and `ERKA_ASKPASS=<id>`.
  - `store.ts:586` merges these into the session env, which is persisted in `sessions.json`.
  - `spec.remote.config` (`app/src/lib/remote.ts:44`) persists `-F <...\Erka\ssh\config>`.

What goes wrong after the upgrade:
- **Accounts keep using the old folder.** The copy in `Kelpie\accounts` is never used. It is also a second plaintext copy of `.credentials.json` / `auth.json`.
- **Uninstalling Erka or deleting its folder breaks accounts.** README says "then uninstall it". Once the old folder is gone, sessions start with a `CLAUDE_CONFIG_DIR` that does not exist. Claude creates an empty one, so the account shows as signed out, the usage meter fails, and that account's history disappears from the UI.
- **Resumed SSH sessions fail to log in.** The first `ssh_secret_has` / `ssh_session_env` call in Kelpie moves the password from keyring service `Erka` to `Kelpie` (`lib.rs:176-187`). After that, a restored remote session runs the old `erkad.exe` as askpass. It looks in the `Erka` service, finds nothing, and with `SSH_ASKPASS_REQUIRE=force` there is no prompt fallback, so login fails. If Erka was uninstalled, the askpass binary is missing entirely.
- **Rewriting only the path is not enough.** The env key is still `ERKA_ASKPASS`. `kelpied` treats a call as askpass only when `KELPIE_ASKPASS` is set (`crates/kelpied/src/main.rs:76`), so an askpass call with only the old key fails with "unknown command".
- **The old-folder references in task prompts and running runs have the same problem.** Task prompts embed the absolute exe path (`runs.rs:446`). A resumed task agent's conversation tells it to run `...\Erka\erkad.exe run report`, which reports to the old daemon or fails.

Fix: rewrite the copied state during migration.
- Parse `app-state.json`, `sessions.json` and `history-cache.json`, and replace the legacy-folder prefix in string values (both slash styles, compared case-insensitively on Windows) with the new folder.
- Rename the env key `ERKA_ASKPASS` to `KELPIE_ASKPASS`, and point `SSH_ASKPASS` at `daemon_exe()`.
- More robust alternative: stop persisting derived values.
  - Have `session.restart` recompute the askpass env and the ssh `-F` path.
  - Resolve an account's home from `account_dir(agent, id)` in the backend instead of the stored `dir`.

### H3. Remote tmux sessions are no longer re-attached
- Where: `crates/kelpied/src/agents.rs:241-242`. The tmux session name changed from `erka-<id12>` to `kelpie-<id12>`.
- `tmux new-session -A` re-attaches only to a session with the same name.
- What goes wrong: a remote project session was started under Erka inside tmux. After the upgrade, Resume (or the automatic resume) creates a new `kelpie-…` tmux session and starts the agent a second time in the same remote folder. The original agent keeps running, unseen, in `erka-…` on the host.
- Fix: prefer the legacy name when it exists, for example `n=kelpie-X; tmux has-session -t '=erka-X' 2>/dev/null && n=erka-X; exec tmux new-session -A -s "$n" …`. Extend `remote_tmux_reattaches_by_session` to cover it.

### H4. The migration cannot resume after an interruption and blocks startup
- Where: `crates/kelpie-proto/src/lib.rs:239-286`, called synchronously at `app/src-tauri/src/lib.rs:139` before the window exists.
- **How "done" is decided:** the migration counts as done once `app-state.json` or `sessions.json` exists in the new folder. NTFS lists entries in name order, so `app-state.json` is copied second, right after `accounts/`.
- **Any error stops it for good.** The first error ends the copy (`?` inside the loop), and an interrupted copy is never resumed.
  - Example trigger: `copy_data` uses `file_type().is_dir()`, which is false for a symlink or junction. A symlinked directory inside a Claude account home (a dotfiles `commands/` link, say) makes `fs::copy` fail.
  - Another trigger: the user kills the app because no window has appeared.
  - Result: `ssh/hosts.json` (saved hosts), `sessions.json`, `snapshots/`, `plugins/` and `speech-models/` are silently left behind. Every later start sees `app-state.json` and skips the migration.
- **The copy can be large and shows no UI.** `speech-models/` alone can be about 650 MB (Whisper small, base and tiny), plus account transcripts.
- **Two instances can race.** There is no single-instance plugin, so a second launch during the copy is plausible:
  1. Instance 2 sees `app-state.json`, skips the migration and may read a half-written file.
  2. Its daemon finds no `sessions.json` and later persists an empty one.
  3. Instance 1's copy then skips `sessions.json` because `dest.exists()`, so the sessions are lost.
- Fix:
  - Serialize the migration with an exclusive `migrate.lock`.
  - Copy `STATE_FILES` last, and write a `.migrated-from-erka` marker only after a full pass. Decide "done" from that marker.
  - Continue past errors on individual entries and log them.
  - Handle symlinks explicitly (recreate them, or skip and log).
  - Consider moving or hard-linking `speech-models` instead of copying.
  - Show progress, or run the copy after the window opens with a blocking notice.

## Medium

### M1. Accounts copied from Erka cannot be removed
- Where: `app/src-tauri/src/accounts.rs:16,120-122`. The marker is now `.kelpie-account`, but copied account folders contain `.erka-account`.
- `account_remove` fails with "not an Kelpie account folder". Even if it succeeded, it would delete the unused copy while the old-path folder stays in use (H2).
- Fix: accept the legacy marker, or rename it during migration. Fix H2 at the same time.

### M2. The `.gitignore` rule was renamed but the folder was not
- Where: `.gitignore:8` now ignores `plans/261020-0823-kelpie-ui-improvements/assets/`. The script skips `plans/`, so the real folder is still `plans/261020-0823-erka-ui-improvements/assets/`.
- `git status` now shows it as untracked: 3.5 MB of screenshots, including the third-party Orca app.
- `git add -A` would commit it.
- Fix: restore the original line, or add `plans/` to the script's skip list for `.gitignore` edits.

### M3. Paired phones are signed out, and the mobile UI was not rebranded
- **Signed out:** `crates/kelpied/mobile/app.js:10` renamed the localStorage key from `erka-token` to `kelpie-token`. The phone's origin (ip:port) is unchanged, so the old token is still there under the old name. After the upgrade every paired phone shows "Not paired", while its device entry stays listed as paired on the desktop.
- **Not rebranded:**
  - `mobile/app.css:2-7,27,34` still uses the old blue `#6cb6ff` / `#2f6fde` and the `#0b0d12` ground.
  - `mobile/index.html:6` and `manifest.webmanifest:8-9` still use `#0b0d12`.
  - `mobile/icon.svg` is still the purple-gradient "E" icon. The home-screen app is called "Kelpie" but shows an "E".
- Fix: read `erka-token` as a fallback and move it to the new key. Port the brand tokens and icon to the mobile app.

### M4. Browser-pane logins and the stored theme are reset
- The `identifier` changed from `dev.erka.desktop` to `dev.kelpie.desktop` (`tauri.conf.json:5`). The WebView2 profile lives under `%LOCALAPPDATA%\<identifier>\EBWebView` (WKWebView likewise by bundle id).
- Effects:
  - Browser-pane cookies and logins are lost.
  - The `kelpie-theme` key starts empty, so light-theme users see a dark flash on the first launch.
  - The usage-meter cache is reset.
- The README upgrade note does not mention this.
- Fix: document it. Copying the profile folder before the webview starts is possible but fragile.

## Low
- **L1. "an Kelpie":** the user-visible error at `accounts.rs:121` ("not an Kelpie account folder") reads wrong. The same "an" appears in comments and docs: `accounts.rs:110`, `plugins.rs:1`, `app/src/lib/plugins.ts:1`, `docs/user-guide.md:348`, `scripts/e2e/phase5.py:32`.
- **L2. Legacy-name fallbacks show the wrong file name in the UI:**
  - `worktree-dialog.tsx:119` always says "Run .kelpie.yaml", even when `.erka.yaml` was found. `configAtRef` does not return which name it used.
  - `plugin-settings.tsx:125` reveals `kelpie-plugin.json` for a plugin that only has `erka-plugin.json`, so it fails silently.
  - The error text at `plugins.rs:132,189` names only the new file.
- **L3. Contrast below WCAG AA for small text:**
  - Accent text on `--bg-active`: 4.3:1 dark, 4.2:1 light. Affects `.palette .item.sel mark` (styles.css:352/355) and `.icon-btn.active` (icons, so 3:1 is acceptable there).
  - Light `.badge.working`: `#141823` on `#0f7c70` is about 3.5:1 for 10 px text. It was about 4.1:1 before. White text would give about 5.1:1; consider a per-theme `--on-working`.
- **L4. Keyring move:**
  - `secret_get` deletes the `Erka` entry on first read. Going back to Erka loses its saved secrets, and an old Erka still running at the same time breaks.
  - On macOS, reading or deleting keychain items created by the old Erka app may show an access prompt. This includes reads from `kelpied` when it runs as askpass under ssh. Not verifiable here.
- **L5. Other changes visible to users or their scripts:**
  - Run-task branches are now `kelpie/…` instead of `erka/…`.
  - `TERM_PROGRAM` is now `Kelpie`.
  - The `originator` header and `clientInfo.name` are now `kelpie`.
  - User scripts, quick commands and plugins that call `erkad …` or read `ERKA_SESSION_ID` break.
  - Worth one line in the upgrade note.
- **L6. Dev runs migrate real data:** the documented dev command `KELPIE_ENDPOINT=kelpie-dev pnpm tauri dev` (README) does not set `KELPIE_DATA_DIR`. A dev or debug build therefore runs the real one-shot migration of the developer's `%LOCALAPPDATA%\Erka`.
- **L7. Docs:** the ASCII diagrams in README and `docs/architecture.md` are misaligned (the names grew by 2 characters). `docs/screenshots/*` still show the Erka brand.

## Checked and found clean
- **Env vars, both sides match:** `KELPIE_ENDPOINT`, `_DATA_DIR`, `_DAEMON_PATH`, `_STT_PATH`, `_STT_TEST_INPUT`, `_E2E`, `_E2E_APP`, `_SSH_DIR`, `_ASKPASS`, `_SESSION_ID`, `_LINEAR_API`, `_LOG`, and the `KELPIE_TEST_*` set. Checked across Rust, TypeScript, `scripts/*.sh`, `scripts/kelpie-call.py` and `scripts/e2e/*`.
- **Endpoints:** the named pipe `kelpie-<user>-v1` and the socket `kelpied-v1.sock` match in Rust and `kelpie-call.py`.
- **Binaries and build:** sidecar names agree across `tauri.bundle.json`, `build-release.sh`, `daemon_exe()`, `voice::helper_path()` and `app/src-tauri/binaries/`. CI uses `-p kelpie-proto -p kelpied -p kelpie -p kelpie-stt`. The workspace members and `Cargo.lock` are clean. The e2e default app is `kelpie.exe`.
- **Webview and UI identifiers:** `window.__kelpie`, the `__KELPIE_NONCE__` / `__kelpieDesign` / `kelpie-pick.invalid` triple, chat ids (`PINNED_IDS` matches the adapters), `kelpie_exit` / `kelpie_stderr`, custom DOM events, and the i18n `SAME` list.
- **Regex coverage:** the only mid-word hits at HEAD were the `ErkaConfig` identifiers, which were renamed by hand. No UTF-16 or NUL-containing text files were skipped. The only remaining `erka` strings are the intended legacy ones.
- **Legacy-name fallbacks:** `.erka.yaml` and `erka-plugin.json` work. Plugin approvals are keyed by manifest hash, so they survive the rename. `.kelpie.yaml` approvals are keyed by content hash.
- **Regenerated files:** `claude-hooks.json` is skipped and rewritten at launch, and `ssh/config` is rewritten by `ssh_hosts::init()`. Neither leaves stale paths.
- **Install-folder leftovers:** the top-level skip list covers what an old NSIS install puts there (`*.exe`, `*.dll`, `*.lock`, `*.pid`, `*.sock`, `logs`).
- **Theme:**
  - No old blue accent or gradient remains in the desktop CSS. The `#6cb6ff` hits left are the ANSI blue, file-type icon colours and project swatches, which are intentional.
  - The terminal palette matches between `app/src/lib/theme.ts` and `crates/kelpied/src/vt.rs`.
  - `--on-accent` on the accent fill is 5.9:1 (dark) and 5.1:1 (light). Accent text on `--bg` / `--bg-elev` is at least 6:1 (dark) and at least 4.7:1 (light).

## Recommended actions (in order)
1. H1: detect or stop the legacy daemon before migrating, do not auto-resume on the migrating launch, and fix the README instructions.
2. H2 and M1: rewrite legacy paths and env keys in the copied JSON, accept the legacy account marker, and preferably stop persisting derived askpass and config paths.
3. H3: fall back to the legacy tmux session name.
4. H4: add a migration lock, a completion marker, state files copied last, per-entry error tolerance and symlink handling, and avoid copying the speech models.
5. M2: restore the `.gitignore` line.
6. M3: add the mobile token fallback and rebrand the mobile app.
7. M4 and L1–L7 as time allows.

## Unresolved questions
- Will the old Erka install be uninstalled automatically by a future installer hook, or is it left to the user? This decides whether a fix for H2 is required or only recommended.
- macOS: does reading or deleting keychain items created by the Erka app prompt for Kelpie / `kelpied`? This needs a manual check on a signed build.
