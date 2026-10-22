# Deferred features, round 3

Status: done · 2026-10-21 · [completion report](../reports/completion-261021-1925-deferred-features.md)
Research: [platform tech](../reports/research-261021-1302-platform-tech.md) ·
[integrations & accounts](../reports/research-261021-1302-integrations-accounts.md) ·
[Orca implementation study](../reports/orca-impl-261021-1302-deferred-features.md)

## Outcome
Every item left out of round 2 ships as a working, tested feature, plus two new asks:
configurable multi-row / multi-column layouts for CLIs, and sessions that come back after the
app (or the computer) restarts so work continues where it stopped.

Constraints: Windows 10 dev machine, ~11 GB free on D: (no parallel worktree builds), no
cmake / clang, no Docker / WSL distro, no sshd installed. No telemetry, no network port unless
the user turns a feature on. Third-party services are reached only with the user's own token.

## Phases
| # | Feature | Approach (short) | Status |
|---|---|---|---|
| 1 | Grid layouts | n-ary splits (`children`/`sizes`, state v3 migration), grid presets, rows×columns picker, per-row counts, launch N agents in a grid, drag panes to swap/move, equalize, spatial focus keys, broadcast input, saved layouts (templates) in menu, launcher and settings | done · e2e 52/52 (incl. real Claude) |
| 2 | Resume after restart | daemon marks restored running sessions `interrupted` (chat ones too); app resumes them when shown / all / off; conversation id recovered from transcripts when never reported; shells restart below their old screen | done · e2e 52/52 (incl. real Claude) |
| 3 | Accounts | per-account `CLAUDE_CONFIG_DIR` / `CODEX_HOME` homes, sign-in in a terminal, status check, active account per agent, usage meters and history per account | done · e2e 27/27 |
| 4 | Orchestration | daemon runs: task DAG, deps, approval gates, worktree per task, agent reports with `erkad run report`, idle fallback; Runs page; AI planning of tasks | done · e2e 30/30 (real agent) |
| 5 | Linear / Jira / GitLab | Rust HTTP clients, tokens in the OS keychain, Issues panel, issue → worktree + agent, status changes, GitLab MR chip / create | done · e2e 25/25 (GitLab live) |
| 6 | Browser + design mode | Tauri child webview as a pane, picker script, element payload (allowlist + redaction + budgets), screenshot, send to agent | done · e2e 31/31 (real input) |
| 7 | SSH remote | remote hosts from `~/.ssh/config`, terminals/agents over `ssh -t` (tmux), remote files, search, git | done · e2e 26/26 (paramiko test host) |
| 8 | Mobile companion | opt-in LAN server in the daemon, pairing token / QR, PWA: sessions, output, reply, approve | done · e2e 20/20 |
| 9 | Plugins | `<data>/plugins/<id>/erka-plugin.json`: agents (daemon `agent.set_custom`, kept for restarts), palette commands with variables, quick commands, terminal themes, layouts, status items; install from folder / git, create; review lists every program, approval bound to the manifest SHA-256 (edits turn it off) | done · e2e 68/68 |
| 10 | Voice dictation | `erka-stt` helper process (sherpa-onnx 1.13.8 static, cpal mic): Vietnamese zipformer + Whisper tiny/base/small, downloads pinned by SHA-256; app bridge `voice.rs` (spawn on use, idle exit); Dictate shortcut, mic buttons (composer, terminal), recording pill, Settings → Voice; silence gate | done · e2e 31/31 (+ real mic capture) |
| 11 | i18n | `t("English")` keyed on English text, `locales/vi/*.json` (~1,100 entries incl. backend errors), Language setting (system / en / vi), Intl dates and relative times, phone app follows the phone; `pnpm i18n:check` (0 missing) in CI | done · e2e 35/35 (no untranslated text on 30 surfaces) |
| 12 | Docs, full regression, report | README, user guide, architecture, `docs/plugins.md`; CI runs helper tests and `pnpm i18n:check`; full regression (19 suites); fixed Ctrl+C in daemon-started sessions | done · all 19 suites green, see report |

## Acceptance
- Each feature works in the dev app and has an e2e script (or a Rust test where UI is not involved).
- `cargo test --workspace`, `pnpm typecheck`, and all existing e2e suites stay green.
- README / user guide describe the new features; a completion report lists what was verified and what could not be (e.g. services without an account).
