# Orca feature parity, round 2

Status: implemented · 2026-10-21 · report: [`../reports/completion-261021-1148-orca-feature-parity.md`](../reports/completion-261021-1148-orca-feature-parity.md)

Source: Orca `stablyai/orca` @ `d406e0c8` (v1.4.232, 182 commits newer than the first analysis), its
58 doc pages (`docs/site/content/docs`), onorca.dev and the releases page. Compared with Erka
`0b99ee5` (README, `docs/user-guide.md`, source).

## Gap list — Orca features Erka lacks

Legend: **do** = implemented in this round · **out** = out of scope (reason).

### Git & review
| # | Orca feature | Plan |
|---|---|---|
| G1 | Push (sets upstream), Pull, Sync; force-with-lease only as an explicit action | do |
| G2 | Abort merge / rebase when one is in progress | do |
| G3 | Generate commit message with AI (from the staged diff) | do |
| G4 | Annotate diff: line notes, batch *Send to agent* | do |
| G5 | Create GitHub pull request (`gh`), PR state chip on the worktree | do |
| G6 | Diff: next / previous change (F7 / Shift+F7) | do |
| G7 | Attribution (AI vs human lines), image diff modes, three-way merge UI | out — needs agent write tracking / large UI; low use |

### Agents
| # | Orca feature | Plan |
|---|---|---|
| A1 | ~40 preset agents (Gemini, Cursor CLI, OpenCode, Copilot, Aider, Grok, Amp, Qwen, …): detected on PATH, enable/disable, resume | do (presets with launch / resume / yolo flags) |
| A2 | Global agent permissions *Manual / Yolo* | do |
| A3 | Agent hibernation: stop idle finished background agents, resume when reopened | do (opt-in) |
| A4 | Hand off to another agent (new session seeded with a bounded transcript) | do |
| A5 | Worktree comment / checkpoint, settable by agents from the CLI | do (`erkad worktree set --comment`) |
| A6 | Account hot-swap (multiple Claude / Codex logins) | out — rewrites agent credentials; needs its own design + user consent |
| A7 | Orchestration (runs, tasks, dispatch, gates) | out — large protocol; `erkad terminal` CLI covers the basic loop |

### Terminal
| # | Orca feature | Plan |
|---|---|---|
| T1 | Terminal context menu: copy, paste, copy context, clear, insert quick command, split | do |
| T2 | Floating terminal (global shell, one chord away) | do |
| T3 | Terminal colour themes library | do (built-in set; daemon palette follows) |
| T4 | Keep computer awake: Off / while agents work / always | do |
| T5 | CLI to drive terminals: `list / read / send / wait` | do (`erkad terminal …`) |
| T6 | Ghostty / Warp theme import, kitty keyboard protocol, JIS Yen | out — niche |

### Navigation, notifications
| # | Orca feature | Plan |
|---|---|---|
| N1 | Notification inbox (bell) with unread list, jump, mark read | do |
| N2 | Agents activity feed | do (same inbox, grouped) |
| N3 | Notification sound | do |
| N4 | Jump palette: *Create worktree "…"* row when nothing matches | do |
| N5 | Find in folder (file tree → search scoped to a folder) | do |
| N6 | Open project in external editor (VS Code, Cursor, …) | do |
| N7 | Close all editor tabs | do |

### Editor & viewers
| # | Orca feature | Plan |
|---|---|---|
| E1 | Word wrap toggle (Alt+Z), default in settings | do |
| E2 | CSV / TSV table viewer (sortable, filter) | do |
| E3 | PDF viewer | do |
| E4 | Mermaid diagrams in markdown preview | do |
| E5 | Jupyter notebook viewer (read-only) | do |
| E6 | Rich WYSIWYG markdown editor, minimap | out — CodeMirror raw + preview is enough |

### Worktrees
| # | Orca feature | Plan |
|---|---|---|
| W1 | Start-from picker: any local / remote branch, tag or commit | do |
| W2 | `.worktreeinclude` (copy ignored files) and shared directories (link) | do |
| W3 | Delete the branch when removing a worktree (opt-in, safe `-d`, `-D` asks) | do |
| W4 | Sleep a worktree (stop its agents, resumable) | do (with A3) |

### Automation
| # | Orca feature | Plan |
|---|---|---|
| S1 | Scheduled automations: run an agent prompt hourly / daily / weekdays / weekly | do (daemon-side, runs without the window) |

### Out of scope this round
Built-in browser & design mode, SSH / remote servers / cloud VMs, mobile companion, Linear / Jira /
GitLab / Bitbucket / Azure, plugins, voice dictation, i18n, public artifact links, iOS emulator /
computer use, telemetry, MiniMax / Gemini usage meters. Each is a product of its own or needs
third-party accounts; none affects the local multi-agent workflow Erka targets.

## Acceptance
- Every **do** row works in the dev app and is covered by an e2e script (`scripts/e2e/parity.py`).
- `cargo test`, `pnpm typecheck` and the existing e2e suites stay green.
- User guide and README list the new features.
