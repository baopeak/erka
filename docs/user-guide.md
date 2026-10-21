# Erka — user guide

Erka runs many coding agents (Claude Code, Codex, OMP) and shells across many projects.
Sessions live in a background daemon (`erkad`): switching projects, closing the window or a
UI crash never stops them. Only the project you are looking at is rendered.

Architecture and protocol: [architecture.md](architecture.md).

## Install

- **Windows 10 1809+ / 11**: run the `Erka_x.y.z_x64-setup.exe` installer (per-user, no admin).
- **macOS 12+**: open the `.dmg` and drag Erka to Applications.

Agents are not bundled: install the CLIs you use (`claude`, `codex`, `omp`) as usual. Erka
finds them on your PATH (Windows) or through your login shell (macOS).

## Everyday use

1. **Add a project**: sidebar `+` (or search → *Add Project Folder…*). Any folder works; for a
   git repository its other worktrees are added under it.
2. **Start a session**: click Claude / Codex / OMP / Terminal on the empty project screen, or
   `+` in the tab bar for options (extra args, name, split, *Chat view*) and your quick commands.
3. **Sidebar**: every project with its branch (`*` = uncommitted changes, ↑↓ ahead/behind) and
   its sessions: status dot, task title, model and time since the last activity. Badges show
   sessions that need you (amber), are working (blue) or finished unread (green). The chevron
   folds a project; the toolbar filters (all / running / needs you) and sorts (manual /
   recent). Right-click a session to rename it inline, mark it unread, restart or resume it,
   continue it in chat view or stop it; right-click a project for worktrees, rename, reorder.
   Switch projects with a click or `Alt+1…9` (`⌘1…9`); `‹ ›` (or `Alt+Shift+←/→`,
   `⌘⌥←/→`) go back and forward through recently focused panes, across projects.
4. **Search everything** (`Ctrl+Shift+P` / `⌘⇧P`): recent items, sessions that need you,
   sessions, projects, files, commands and settings in one box. Prefix `@` sessions, `#` files,
   `>` commands, `/` settings, or press `Tab` to change scope.
5. **Dashboard** (`Ctrl+Shift+M` / `⌘⇧M`): every session of every project grouped by
   *Needs you / Working / Done / Idle* — click a card to jump there.
6. **Files**: the right panel has Files (filter by name, or search contents), Changes (git) and
   Sessions. Click a file to open it in the editor (`Ctrl+S` saves; external changes are
   detected); click a change to see its diff. Ignored files are dimmed.
7. **Panes**: hover a pane for split right / down, maximize (`Ctrl+Shift+Enter`) and close.
8. **Chat view**: in an agent pane header click the chat icon to continue the *same
   conversation* in a chat UI (messages, tool cards with diffs, Allow/Deny prompts); the
   terminal icon switches back to the TUI. Erka stops one front-end before starting the other,
   so a conversation never has two writers.

### Past conversations

The **Sessions** tab of the right panel lists earlier Claude, Codex and OMP conversations read
from their own transcripts: *This folder*, *Project* (folders inside it) or *All*, grouped by
day, searchable by title and first prompt, with the number of prompts. Resume one in a
terminal or in chat view (it opens in its own folder), or copy the resume command. The list is
built from the start of each transcript and cached; prompt counts fill in from a background
pass.

### Usage and memory

The status bar shows Claude and Codex plan usage (5 h and weekly windows, amber from 80 %, red
and a notice at 100 %) and Erka's memory (app + WebView, daemon, sessions). Usage is read with
the agents' own sign-in (`~/.claude/.credentials.json` or the macOS keychain, and
`~/.codex/auth.json`); tokens stay in Erka's Rust core and are sent only to the vendor's usage
endpoint, identifying as Erka. When a refresh fails (e.g. the endpoint's rate limit) the last
values stay shown, dimmed, with the reason in the tooltip. Both meters can be turned off in
Settings → Usage & Resources.

### Quick commands

Settings → Quick Commands saves commands and prompts. *Terminal* types into the focused shell
(or a new one), *Agent* sends a prompt to the focused agent session; optionally press Enter;
for all projects or one. Run them from search (`>` *Run: …*) or the new-session menu
(`Ctrl+1…9`).

### Worktrees and the workspace board

Right-click a repository → **New worktree…**: branch (a name is suggested), base (current
branch) and folder (`<repo>-worktrees/<branch>` next to the repository). The worktree appears
under the repository with its own sessions and layout. **Remove worktree…** first says what
would be lost (running sessions, uncommitted files, ignored files such as `.env`), then stops
its sessions and runs `git worktree remove`; the branch is always kept. A worktree on a
detached HEAD with commits no branch contains is not removed — create a branch first.

A repository may contain `.erka.yaml`. The new-worktree dialog shows its commands as they are
in the base commit and runs them only if you tick the box (it stays ticked for the same file
next time):

```yaml
setup:            # typed, one per line, into a "setup" terminal
  - pnpm install
tabs:             # sessions to open: claude, codex, omp, shell, or a command
  - claude
  - command: pnpm dev
```

The **workspace board** (`Ctrl+Shift+J` / `⌘⇧J`, or the board icon in the sidebar) shows every
project and worktree as a card in *Todo / In progress / Review / Done* with the agents running
in it; drag cards between columns, pin important ones, click to open.

`.erka.yaml` can also bring ignored files into new worktrees (a fresh checkout lacks them):

```yaml
copy:             # private copies (also read from .worktreeinclude, one path per line)
  - .env
link:             # shared with the repository (symlink; a junction on Windows)
  - node_modules
```

Only literal paths that exist in the repository and are ignored by git qualify; copies are
capped at 2 GiB / 50,000 files per worktree. The *From* field suggests local and remote
branches and tags (a commit id works too). After **Remove worktree…** a notice offers to
delete its branch (`git branch -d`; when it has unmerged commits Erka asks before `-D`).
In search, typing a name that matches nothing offers **Create worktree "…"**.

A worktree (or any folder) can carry a **comment** — what it is doing right now — and a board
status. Set them from the sidebar menu (*Add comment…*) or let an agent set them:

```
erkad worktree set --comment "reproduced the bug; testing a fix" --status progress
erkad worktree get
```

The comment shows under the sidebar row and on its board card.

When an agent exits, the pane offers **Restart** / **Resume** (agents resume their
conversation). Desktop notifications fire when a session you are not looking at finishes or
needs input.

### Agents

Besides Claude Code, Codex and OMP, Erka knows 20 more agent CLIs (Gemini, Cursor CLI,
OpenCode, GitHub Copilot, Grok, Qwen Code, Droid, Aider, Amp, Goose, Kimi, Crush, Cline, Kiro,
Continue, Devin, Auggie, CodeBuddy, Mistral Vibe, Pi). Installed ones appear in the launchers;
Settings → Agents shows them all, hides ones you do not want and edits their arguments and
environment. **Permissions: Yolo** starts agents with their skip-permission flags (agents
with their own permission mode set keep it). The new-session dialog takes an optional **first
prompt**; for a terminal it is a startup command.

- **Hand off**: right-click an agent terminal → *Hand Off to …* starts another agent next to
  it with the end of this session's transcript as its brief.
- **Hibernation** (Settings → Agents): agents that finished and sat unseen in a background
  project for N minutes are stopped; they resume their conversation when you open them
  again. *Sleep* in a project's menu does the same at once.
- **Keep computer awake**: off, while an agent works, or always (status bar coffee icon).

### Terminals

Right-click a terminal for copy / paste / select all / clear, **Copy Context** (the last 400
lines as text), splits, your quick commands and hand-offs. Settings → Terminal → *Colour
theme* offers Dracula, Nord, One Dark, Tokyo Night, Catppuccin, Gruvbox, Solarized and GitHub
Light (agents are told the same colours when they ask).

The **floating terminal** (`Ctrl+Shift+\`` / `⌘⌥A`, or the status bar) is a shell in your home
folder, above any project; hide it and it keeps running.

Scripts and agents can drive sessions:

```
erkad terminal list
erkad terminal read <session> --lines 80
erkad terminal send <session> "run the tests" --enter
erkad terminal wait <session>          # until it stops working
```

`<session>` is a handle, a session id (prefix) or a session name.

### Activity and notifications

The bell in the status bar lists what happened while you looked elsewhere: agents that
finished or need you, automation runs, new worktrees — with the agents working right now on
top. Click an entry to jump there; right-click toggles read. Settings → Notifications can add
a short chime to desktop notifications.

### Source control and review

The Changes panel pushes (publishing the branch the first time), pulls (fast-forward only)
and syncs; when the branch and its upstream diverged it offers an explicit **force push with
lease**. During a merge, rebase, cherry-pick or revert it shows the conflicts with **Abort**
and **Resolve with AI**. The ✦ button drafts a commit message from the diff (with the agent
chosen in Settings → Agents → *Agent for AI actions*, run once without a terminal); a failed
commit offers **Fix with AI**; *Amend* rewrites the last commit.

**Pull requests** (GitHub, through your `gh`): the branch's PR shows with its state and
checks (also as a chip in the sidebar); *Create pull request…* pushes and opens one, with
**Generate with AI** for the title and description. Failing checks offer *Fix with AI*.

**Review notes**: in a diff, click the gutter (`+`) to note a line; notes on all files of
the project collect in a bar above the diff. **Send to agent ▾** sends them as one prompt to
a running agent or a new one; resolve notes once addressed. `F7` / `Shift+F7` move between
changes.

### Files

Besides the editor and markdown preview, CSV / TSV files open as a sortable, filterable
table, PDFs in a viewer, Jupyter notebooks with their outputs, and Mermaid diagrams (`.mmd`
files and ```` ```mermaid ```` blocks in markdown). `Alt+Z` toggles word wrap. Right-click a
folder → **Find in Folder…** searches only there. A project's menu opens it in VS Code,
Cursor, Windsurf, Zed, Sublime Text or IntelliJ IDEA when installed.

### Automations

Settings → Automations runs an agent with a prompt every hour, day, weekday or week (local
time), in a project. They are stored and started by the session daemon, so they run while
the window is closed; *Run now* tries one immediately. Runs missed by more than 30 minutes
(computer asleep) are skipped, not caught up.

## Keyboard shortcuts

App shortcuts use `Ctrl+Shift` on Windows so plain `Ctrl+letter` keys reach the agent TUIs.

| Action | Windows / Linux | macOS |
|---|---|---|
| Search everything | Ctrl+Shift+P | ⌘⇧P |
| Go to file | Ctrl+Shift+O | ⌘P |
| Jump to session / project | Ctrl+Shift+K | ⌘K |
| Agent dashboard | Ctrl+Shift+M | ⌘⇧M |
| Workspace board | Ctrl+Shift+J | ⌘⇧J |
| Back / forward | Alt+Shift+← / → | ⌘⌥← / → |
| New terminal | Ctrl+Shift+T | ⌘T |
| New session… | Ctrl+Shift+N | ⌘⇧N |
| Split right / down | Ctrl+Shift+D / Ctrl+Shift+S | ⌘D / ⌘⇧D |
| Close pane | Ctrl+Shift+W | ⌘W |
| Maximize / restore pane | Ctrl+Shift+Enter | ⌘⇧↩ |
| Next / previous pane | Alt+] / Alt+[ | ⌘] / ⌘[ |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | ⌃Tab / ⌃⇧Tab |
| Project 1…9 | Alt+1…9 | ⌘1…9 |
| Find in terminal | Ctrl+Shift+F | ⌘F |
| Explorer / Changes / Search panel | Ctrl+Shift+E / G / H | ⌘⇧E / G / F |
| Toggle sidebar | Ctrl+Shift+B | ⌘B |
| Font size + / − / reset | Ctrl+= / Ctrl+- / Ctrl+0 | ⌘= / ⌘- / ⌘0 |
| Settings | Ctrl+, | ⌘, |
| Floating terminal | Ctrl+Shift+` | ⌘⌥A |
| Word wrap (editor focused) | Alt+Z | ⌥Z |
| Close all editor tabs | Ctrl+Alt+W | ⌘⌥W |
| Next / previous change (diff) | F7 / Shift+F7 | F7 / ⇧F7 |

Every shortcut can be changed in Settings → Shortcuts (record a key; Erka warns when another
command or terminal programs use it). When Erka keeps a key from the focused terminal it says
so once (Settings → Notifications turns these notes off).

In terminals: `Ctrl+C` copies when text is selected (otherwise it is sent to the program),
`Ctrl+V` pastes, `Shift+Enter` inserts a newline in agent prompts, `Ctrl/⌘+click` opens links.
Drop files from Explorer/Finder onto a terminal to paste their paths. Programs may set the
clipboard (OSC 52) only from the terminal you are looking at, and Erka shows a notice when
they do.

## Settings

Settings (`Ctrl+,`) is a page with a search box (`Ctrl+F`); `/` in search everything jumps to
a setting.

- **Agents**: permissions (Manual / Yolo); per agent extra arguments (e.g. `--model opus`),
  permission mode (Claude) or approval policy (Codex) and environment variables (stored in
  plain text) — used by terminal and chat sessions; which agent CLIs launchers show; the agent
  for AI actions; hibernation; keep computer awake.
- **Quick Commands**, **Automations**, **Shortcuts**: see above.
- **Terminal**: font, size, line height, scrollback, renderer (WebGL / DOM), cursor blink,
  default shell, colour theme, floating terminal.
- **Appearance**: dark or light theme, compact density, interface text size, editor word wrap.
- **Notifications**: desktop notifications and their sound, notes about shortcuts kept from
  the terminal, first-run tips.
- **Usage & Resources**: usage and memory meters.
- **Session Daemon**: status, data folder and log, *Stop daemon & all sessions*.

Settings and layouts live in `app-state.json` in the data folder; when its format changes the
old file is first copied to `app-state.v<N>.bak.json`.

## Automation

Besides `erkad terminal …` and `erkad worktree …` (above), `erkad call <method> [json]` talks
to the running daemon directly, e.g.

```
erkad call session.list
erkad call session.create '{"kind":"claude","cwd":"D:/proj"}'
erkad call session.input '{"handle":3,"data":"run the tests\r"}'
erkad call session.read '{"handle":3}'
```

## Build from source

Requirements: Rust (stable), Node 22+, pnpm, and on Windows the MSVC build tools.

```
cd app && pnpm install && cd ..
scripts/build-release.sh --bundles nsis      # Windows installer
scripts/build-release.sh --bundles app,dmg   # macOS
```

Development: `scripts/dev-daemon.sh run` (isolated endpoint/data dir), then in `app/`
`ERKA_ENDPOINT=erka-dev pnpm tauri dev`. Tests: `cargo test`, `pnpm typecheck`,
`erkad bench --sessions 20 --mb 2`, and the WebDriver end-to-end scripts in `scripts/e2e/`
(require `tauri-driver` + a matching `msedgedriver`).
