# Termius-style SSH hosts in Erka

Status: done (uncommitted) · Branch: master · Tested on the dev build first, release build last.

Results (dev build): `ssh_hosts.py` 25/25, `remote.py` 26/26, `restart.py` 3/3, `scrollback.py` 8/8,
`agent_resume.py` (Claude, Codex, OMP; daemon killed and restarted) all pass; `cargo test --workspace`,
`pnpm typecheck`, `i18n:check` clean. Bugs found on the way and fixed: host probe failed when the last
agent CLI was missing; Git Bash `ssh`/`scp` on PATH shadowed Windows OpenSSH (drive letters, agent);
saving `lastConnected` could overwrite other vault changes; WebDriver `window/rect` offset the UI in e2e.

## Outcome
Users manage SSH servers inside Erka the way Termius does, and start Claude Code (or any agent / shell) on a server in one click, kept alive in tmux.

## Constraints
- Keep the system OpenSSH client (user config, agent, known_hosts stay authoritative). No embedded SSH library.
- Everything lives in the user profile data dir (`%LOCALAPPDATA%\Erka`); secrets only in the OS credential store.
- Remote sessions stay daemon-owned (survive app close); existing remote projects keep working.

## Non-goals
Cloud vault sync / team sharing, mobile apps, Telnet / serial / Mosh, Termius' AI command autocomplete.

## Feature map (Termius → Erka)
| Termius | Erka |
|---|---|
| Hosts, groups, tags, notes, quick connect, recent | Hosts page; `hosts.json`; generated `ssh/config` (aliases) that `Include`s the user's config |
| Password / key / agent auth, keychain | Keyring secrets + `SSH_ASKPASS` = `erkad` (askpass mode); keys: list / generate / import / copy public / install on host / add to agent |
| Known hosts | list, remove (`ssh-keygen -R`), trust a new host after showing its fingerprint (`ssh-keyscan`) |
| Jump host, agent forwarding, keepalive, env, startup snippet | per-host fields → generated config (`ProxyJump`, `ForwardAgent`, `ServerAlive*`, `SetEnv`) + startup command |
| Port forwarding L / R / D | rules per host; each runs as a daemon-owned `ssh -N` session (survives app close) |
| SFTP | file browser on the host: list, upload / download (`scp`), drag-and-drop upload, new folder, rename, delete |
| Snippets on many hosts | run a quick command on selected hosts (one terminal each) |
| Terminal per host | shell / agent session on the host, in tmux when available; "Install Claude Code" when missing |

## Phases
1. Backend vault + config generation + askpass (app `ssh_hosts.rs`, `erkad` askpass mode) — unit tests.
2. Keychain, known hosts, transfers, forwards backend.
3. Hosts page UI + palette commands + vi locale.
4. e2e `scripts/e2e/ssh_hosts.py` against `ssh_test_server.py` (password + key auth, forwarding, scp) on the dev build.
5. Docs (README, user guide, architecture).

## Acceptance
- Save a host with password auth → terminal and file browsing log in without prompts; key auth works; unknown host key shows fingerprint before trusting.
- "Claude Code here" opens an agent session on the host in tmux.
- A local forward reaches a service on the host; stopping it frees the port.
- Upload / download round-trips a file.
- Existing `remote.py` e2e still passes.
