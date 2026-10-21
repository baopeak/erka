# Orca feature parity, round 2 — completion

Date: 2026-10-21 · Plan: [`../261021-0052-orca-feature-parity/plan.md`](../261021-0052-orca-feature-parity/plan.md)
Source compared: Orca `d406e0c8` (v1.4.232), 58 doc pages, onorca.dev, releases page.

## Delivered (every **do** row of the plan)

| Area | Feature | Where |
|---|---|---|
| Git | Push (publish + upstream), pull (ff-only), sync, explicit force-with-lease | `git_sync.rs`, `git-panel.tsx` |
| Git | Merge / rebase / cherry-pick / revert detection, abort, *Resolve with AI* | `git_sync.rs`, `git-panel.tsx` |
| Git | AI commit message (one-shot `claude -p` / `codex exec -`), *Fix with AI*, amend | `oneshot.rs`, `git-panel.tsx` |
| Review | Line notes in diffs, batch *Send to agent*, resolve; F7 / Shift+F7 | `diff-view.tsx`, `send-to-agent.ts` |
| GitHub | PR of the branch (state, checks) + sidebar chip, create PR with AI text, *Fix broken checks* | `github.rs`, `pull-requests.ts` |
| Agents | 23 presets (installed check, hide/show, args/env), Manual/Yolo, first prompt, hand-off | `agents.rs`, `lib/agents.ts`, settings |
| Agents | Hibernation (idle finished background agents), *Sleep* project, keep-awake | `store.ts`, `awake.rs` |
| Agents | Worktree comment + status via `erkad worktree set/get` | `meta.rs`, `cli.rs`, sidebar, board |
| Terminal | Context menu (copy context, insert quick command, hand-off), 9 colour themes (daemon palette follows), floating terminal | `terminal-pane.tsx`, `terminal-themes.ts`, `floating-terminal.tsx` |
| Terminal | `erkad terminal list/read/send/wait`, `session.read lines` (scrollback) | `cli.rs`, `vt.rs` |
| Navigation | Activity inbox (bell), notification chime, *Create worktree* search row, Find in Folder, *Open in* editor, close all editor tabs | `inbox.tsx`, `palette.tsx`, `external_editor.rs` |
| Viewers | CSV/TSV table, PDF, Jupyter, Mermaid (`.mmd` + markdown blocks), word wrap (Alt+Z) | `rich-viewers.tsx`, `file-viewer.tsx` |
| Worktrees | Start-from picker (branches, remotes, tags), `.worktreeinclude` / `copy:` / `link:`, delete branch after removal | `worktree_files.rs`, `worktree-dialog.tsx` |
| Automation | Scheduled prompts (hourly/daily/weekdays/weekly), run by the daemon | `automations.rs`, `automation-settings.tsx` |

Out of scope (unchanged from the plan): browser/design mode, SSH/remote/cloud, mobile, Linear/Jira/GitLab/Bitbucket, plugins, voice, i18n, artifacts, account hot-swap, orchestration DAG.

## Verification

- `cargo test -p erkad`: 22 pass (presets, typed prompts, text tail, palette, automations schedule, meta keys).
- `cargo test -p erka`: worktree file copy/link (junction with forward-slash paths), PR checks summary, existing tests.
- `pnpm typecheck` clean.
- New e2e `scripts/e2e/parity.py`: 73 checks pass in dev; with `--ai` 74 (one real one-shot call).
- Regression suites in dev (after the last fixes): smoke 15/15, restart 3/3, phase1 10/10,
  phase2 13/13, phase3 18/18, phase4 22/22, phase5 23/23, chat (claude) 4/4, parity 73/73.
  phase1 now turns shortcut notes on itself (other scenarios switch them off in the shared
  dev state).

## Defects found and fixed while testing

- Workspace notes keyed by the raw path: an 8.3 short path (`USERNA~1`) never matched git's long path. Both daemon (`meta::key`) and app (`canonKeys`) now key by the canonical path.
- `git check-ignore` does not match `dir/` patterns without the trailing slash: folders are checked as `rel/`.
- `mklink /J` rejects forward slashes: paths are converted first.
- Removing a worktree with a linked folder could delete the shared target: links inside a registered linked worktree are removed (links only) before `git worktree remove`; e2e asserts the repository's files survive.
- Hibernating a visible session woke it instantly while still exiting: wake only stopped sessions, and only after the user looked away and back.
- Yolo flags leaked into chat-view argv (chat asks Allow/Deny itself): excluded.
- `Open in` editor ran `cmd /c code.cmd <path>`: a folder name with `&` would run a second command; the `.cmd` is now spawned directly (std escapes for cmd).

## Unresolved

- Preset flags for agents not installed here (only claude, codex, omp, cline, pi are) come from Orca's table and the CLIs' docs; not run locally.
- macOS keep-awake (`caffeinate`) and the CI build are untested on a Mac in this round.
