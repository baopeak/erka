# SSH panes in any project + Termius-style host UX

Status: implemented, verified, not committed · Branch `rebrand/kelpie` (on top of rename af10e12). Verification 2026-10-22: tsc, i18n, vite build, cargo tests (app crate 37 + ssh_hosts incl. new fields) pass; e2e on a rebuilt app: ssh_panes 40/40 (new), ssh_hosts 25/25, split_picker 46/46. Review: plans/reports/code-reviewer-261022-1841-ssh-panes.md (12 findings, all fixed); test: plans/reports/tester-261022-1841-ssh-panes.md (1 UX bug, fixed after the run).
Research: [../reports/research-261022-1811-multi-ssh-sessions-in-project.md](../reports/research-261022-1811-multi-ssh-sessions-in-project.md)

## Outcome

- A local project hosts any number of terminal / agent panes on any saved host (Claude Code remote in tmux), mixed with local panes in tabs, splits and grids.
- Hosts stay global (vault); projects only *link* hosts with a folder each (n–n). Any project can still run on any host without linking.
- Remote panes are unmistakable: host colour stripe, host chip in the header, host name on the tab, optional per-host terminal theme.
- Hosts page gains Termius ideas: one box to search or `ssh user@host`, OS badge, a right-side drawer to add/edit a host with a sticky **Connect**.

Non-goals: worktrees on the host, cloud/team vault sync, autocomplete/history (need shell integration on the server), serial, connection logs, grid/list toggle.

## Audit of the research design (corrections)

| # | Finding (verified in code) | Decision |
|---|---|---|
| 1 | Daemon already takes `remote` per session (`RemoteSpec`, `build_remote_launch`); only `startSession` binds it to the project | Frontend change; daemon untouched |
| 2 | `sessionEnv(project)` picks the askpass env by the *project's* alias | Resolve env and spec from the session's own destination |
| 3 | Vault is a typed Rust struct (`ssh_hosts.rs::Host`): unknown fields are dropped on save | Add `os`, `terminal_theme` to Rust `Host`; record `os` in `ssh_host_touch` |
| 4 | `uname -sr` gives "Linux 6.x", no distro | Probe `/etc/os-release` `ID` as `distro` in `remote_check` |
| 5 | Terminal "Hand off to…" starts the new agent with `newSession(project, kind)` → it would run **locally** from a remote pane | Hand off on the same target |
| 6 | Saved layouts store only `kind` per leaf | Leaf gets optional `target`; old layouts keep working |
| 7 | `splitPicker` makes a bare empty pane; launcher has no idea where the split came from | Empty pane carries `target` copied from the focused pane |
| 8 | `findConversation` reads local transcripts; a remote session could be matched to a local one | Skip it for remote sessions (tmux re-attach resumes them) |
| 9 | First connect may hit an unknown host key → ssh prompts inside the PTY | Check host before starting; on host-key error open the host's trust panel |
| 10 | Per-host theme: view theme is global (`terminalThemeFor(settings)`), daemon colour-query palette is global | Per-view override from the host; daemon palette stays global (documented limit) |
| 11 | Agents offered for a remote target must be the host's (`HostCheck.agents`), not local presets | Cache checks per host; launcher shows that host's agents |

## Phases

1. **Target per pane** — `SessionTarget` (dest, port, path, tmux, hostId); `startSession`/`newSession`/`launchGrid`/`applyLayout`/`saveLayout` accept it; empty-pane launcher row "Run on"; New session dialog "Run on / Folder / tmux"; split inherits; hand-off keeps target; header chip + colour stripe + tab prefix; inbox title with host. Files: `types.ts`, `remote.ts`, `store.ts`, `layout.ts`, `ssh-hosts.ts`, `pane-view.tsx`, `new-session-menu.tsx`, `workspace-view.tsx`, `terminal-pane.tsx`, `styles.css`.
2. **Project ↔ host links** — `Project.hosts: {hostId, path}[]`; launcher lists linked hosts first, "Other host…" search, "Link to this project"; hosts page: "Used in" + "Open in current project"; warn when another project's agent runs in the same host folder.
3. **Termius UX** — quick connect box (filter, or `user@host[:port]` → prefilled drawer); OS badge (`os` from check); per-host terminal theme; host editor as right drawer with sticky Save / Connect; "Run on selected hosts" can pick a quick command.
4. **Verify** — `pnpm typecheck`, `pnpm build`, `node scripts/i18n-check.mjs`, `cargo test -p kelpie` (or workspace), launch app and exercise; e2e `scripts/e2e/ssh_hosts.py` if a local test host is available.

## Acceptance

- In a local project: split → pick a host → Claude Code starts on the host in the linked folder inside tmux; a second split inherits that host; a local shell can sit next to it.
- Restart daemon → remote panes resume (tmux re-attach); saved layout reopens panes on their hosts.
- Password hosts log in from a local project (askpass by session destination).
- Two projects can link the same host with different folders; removing a link never deletes the host.
- Host colour/theme visible on every remote pane and tab; hosts page shows OS badge; new/edit host opens as a drawer with Connect.
- Typecheck, build, i18n check, cargo tests pass.

## Risks / rollback

- Vault schema grows (additive, serde `default`) → old files load; rollback = ignore fields.
- Project state grows `hosts` (optional) → no state version bump.
- Rollback: revert the commits; daemon and saved sessions unaffected (sessions already carry their own `remote`).
