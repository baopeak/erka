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
7. **Panes**: hover a pane for split right / down, maximize (`Ctrl+Shift+Enter`) and close. A
   split (button, terminal menu or shortcut) opens an empty pane asking what to run: click an
   agent or *Terminal*, or press `1`–`9`; *More…* opens the new-session dialog for that pane
   (arguments, account, chat view); `Esc` closes it.
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

**Long output.** Scrolled up in a long conversation, a pill in the corner counts the lines that
arrived meanwhile and takes you back to the bottom. Every line you submit (Enter) is a mark:
`Ctrl+Shift+↑ / ↓` (`⌘↑ / ↓`) jumps to the previous / next prompt you sent, so a Claude Code
conversation of thousands of lines reads turn by turn; `Ctrl+Shift+End` (`⌘End`) goes back to
the bottom. Settings → Terminal → *Scrollback* sets how many lines each terminal keeps.

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

### Layouts

The grid button in the tab bar (or `Ctrl+Shift+L` / `⌘⇧L`) arranges the tab: presets from
2 columns to 3×3, any number of rows or columns, or per-row counts such as `3,2` (three panes
on top, two below). Existing panes keep their place; new cells are empty panes with a launcher.
The new-session dialog's *Grid…* placement starts one agent per cell of a new grid tab. Drag a pane by its header onto another pane to
swap them or onto its edge to move it there, onto another tab to move it into that tab, or onto
empty tab-bar space to give it its own tab. Drag a tab along the tab bar to reorder it, or onto
an edge of a pane of the open tab to merge its panes in there (palette: *Move Tab Left / Right*,
*Move Pane to New Tab*). Drag gutters to resize, double-click a gutter (or
*Make all panes equal*) to even them out. `Ctrl+Alt+←/→/↑/↓` (`⌃⌥` arrows) focus the pane in
that direction. **Broadcast input** sends what you type to every terminal of the tab (a badge
marks them). Double-click a tab to rename it.

*Save this layout* stores the arrangement with what each pane runs; saved layouts open from
the layout menu and a project's start page, and are renamed or deleted in Settings → Layouts.

### Resuming after a restart

When the session daemon stops while sessions run (computer restart, update, crash), its
sessions come back *interrupted* with their last screen. Settings → Agents → *Resume after a
restart* decides what happens next: resume each one when you open it (default), all at once,
or only with its **Resume** button. Agents continue the same conversation (Claude Code
`--resume <id>`, Codex `resume <id>`, others with their "continue latest" flag); shells start
again below their old output.

### Several Claude Code / Codex accounts

Settings → Accounts adds sign-ins: each account gets its own config folder
(`<data>/accounts/<agent>/<id>`, used as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and you sign in
once in a terminal Erka opens there. The *active* account per agent is used by new sessions,
chat view, automations and AI actions; running sessions keep theirs. Right-click a usage meter
to switch; each account has its own meter. The new-session dialog can pick an account, and the
Sessions panel lists the conversations of every account and resumes each with its own.

### Orchestration runs

**Runs** (`Ctrl+Shift+R` / `⌘⇧R`) split a larger job into agent tasks: each task has a prompt,
an agent, the tasks it waits for, optionally an **approval** before it starts and its own
**worktree** (a new branch, so parallel tasks never edit the same checkout). *Plan tasks with
AI* drafts the tasks from an objective for you to review. The session daemon runs them —
also with the window closed — starting each task when its dependencies are done. A task ends
when its agent reports (`erkad run report done "summary"` / `failed "why"`, which Erka adds to
the prompt), exits, or worked and then stayed idle for 5 minutes. Failed tasks can be retried,
skipped or marked done; the status bar shows active runs and tasks waiting for approval.

```
erkad run create run.json          # {"name", "objective", "tasks": [{"id", "title", "prompt",
erkad run list                     #   "kind", "deps": [...], "approve", "worktree"}]}
erkad run show <run> | approve|retry|done|skip <run> <task> | cancel|delete <run>
erkad run wait <run>
```

### Issue trackers and GitLab

Settings → Integrations connects **Linear** (personal API key), **Jira** (Cloud: site, e-mail
and API token; Server / Data Center: personal access token) and **GitLab** (gitlab.com and
self-hosted hosts; public projects work without a token). Tokens go to the OS credential store
(Windows Credential Manager, macOS Keychain), never to Erka's files. The **Issues** panel lists
your open issues; start an agent on one, create a worktree for it, or move it to another state.
For a GitLab repository the Changes panel shows the branch's merge request with its pipeline,
creates merge requests (with AI-written description) and offers *Fix with AI* on a failing
pipeline.

### Browser panes and design mode

`Ctrl+Shift+U` (or the globe in the tab bar) opens a web page in a pane: address bar, back /
forward / reload, developer tools and a page screenshot. **Design mode** lets you click
elements on the page: each pick records its selector, text, HTML, attributes (passwords and
token-like values removed) and size, with a screenshot of the element; add a note and **send
to an agent** as one prompt. With Settings → Terminal → *Open localhost links in a browser
pane*, `Ctrl/⌘+click` on a dev-server address in a terminal opens it next to the terminal.

### Remote projects (SSH)

*Add Remote Project (SSH)…* (search, or the server icon in the sidebar's project toolbar) picks a host
(a saved one, or one from your SSH config) and a folder on it. Terminals and agents run there over
`ssh -t` — inside `tmux` when the host has it, so they survive a dropped connection — and the file
tree, editor, search and git work through ssh as well. Erka uses your OpenSSH client and config
(Settings → Remote picks another config file): keys, agents, users, ports and jump hosts apply.
The launchers show the agents installed on the host; *Open in VS Code* uses its Remote-SSH
extension. Chat view is not available for remote sessions.

### SSH hosts

The **SSH hosts** page (the server icon at the bottom of the sidebar, `Ctrl+Alt+H` / `⌘⌥H`, or
*SSH Hosts…* in search) keeps your servers the way Termius does:

- **Hosts** with a name, group, tags, colour and notes; address, user and port; log in with a key
  (or the SSH agent) or a **password** saved in the system credential store (Windows Credential
  Manager / macOS keychain) — never in Erka's files. Jump host, agent forwarding, keepalive,
  environment variables, a start folder and a **startup command** typed into every new shell.
  *Import* adds the hosts of your SSH config. Search filters by name, address, group or tag.
- **One click on a host**: *Terminal*, **Claude Code here** or any other agent the host has, in
  its folder and inside tmux. *Install Claude Code* types the official installer into a terminal
  when the host lacks it. *Open as project* adds the host's folder to the sidebar (files, git,
  search). Sessions on a host resume like local ones.
- **First connection**: Erka shows the host's key fingerprints before trusting it, and warns
  loudly when a known host's key changed.
- **Files**: browse the host, upload files or folders (or drop them from Explorer / Finder onto
  the list), download, new folder, rename, delete (`scp` / SFTP).
- **Run a command on several hosts**: tick hosts in the list, type the command, one terminal
  each.
- **Keychain**: the keys in `~/.ssh` with type and fingerprint; generate (Ed25519, RSA 4096,
  ECDSA), import, copy the public key, **install it on a host** (`authorized_keys`), add it to the
  SSH agent, save its passphrase, move it to the trash.
- **Known hosts**: every entry with its fingerprint; forget one.
- **Port forwarding**: local (`-L`), remote (`-R`) and SOCKS (`-D`) rules per host, started and
  stopped from the page; rules marked *Start when Erka opens* come back with the app.

Saved hosts become entries of a config Erka generates (`ssh/config` in its data folder) that
ends by including your own SSH config, so `ssh <alias>` aliases keep working and every remote
project can use a saved host.

### Phone access

Settings → Mobile turns on a small web app for your phone on your network (off by default;
port 4817; choose a private or Tailscale address — never every interface; HTTPS with your own
certificate, e.g. from `tailscale cert`). **Pair a phone** shows a QR code valid for two
minutes; scan it, name the phone and approve it on the computer. The phone lists every session
grouped by *Needs you / Working / Idle / Stopped*, buzzes when one starts needing you, shows a
session's screen and — if you allow that device to type — sends replies and keys (Enter, Esc,
Ctrl+C, arrows, y / n, 1–3). Unpairing a device disconnects it at once.

### Voice dictation

Settings → Voice downloads a speech model once (checked against a pinned checksum): a fast
Vietnamese model (26 MB) or Whisper tiny / base / small for about 100 languages (104–375 MB).
Then `Ctrl+Shift+Space` (`⌘⇧Space`) or a microphone button (chat composer, terminal panes,
Settings) starts listening; press it again (or **Done**) and the words are inserted where you
were typing — at the cursor of a text field, or pasted into the focused terminal without
pressing Enter. `Esc` cancels. Speech is recognised on this computer by a separate helper
process (`erka-stt`) that exits after ten idle minutes; nothing is sent anywhere.

### Plugins

A plugin is a folder with an `erka-plugin.json` manifest that adds agents, palette commands,
quick commands, terminal themes, layouts and status-bar items. Settings → Plugins installs one
from a folder or a git URL, or creates a starter to edit. A plugin does nothing until you
**Review & enable** it: the review lists every program it would run. Editing the manifest turns
the plugin off until you review it again. Format: [plugins.md](plugins.md).

### Language

Settings → Appearance → *Language*: English or Tiếng Việt (Vietnamese); *System* follows your
computer. Dates and times follow the language. The phone app follows the phone's language.

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
| Layout menu | Ctrl+Shift+L | ⌘⇧L |
| Focus pane left / right / up / down | Ctrl+Alt+← / → / ↑ / ↓ | ⌃⌥← / → / ↑ / ↓ |
| Runs (orchestration) | Ctrl+Shift+R | ⌘⇧R |
| Open browser | Ctrl+Shift+U | ⌘⇧U |
| Dictate (start / stop) | Ctrl+Shift+Space | ⌘⇧Space |
| Close all editor tabs | Ctrl+Alt+W | ⌘⌥W |
| Next / previous change (diff) | F7 / Shift+F7 | F7 / ⇧F7 |
| Previous / next prompt sent (terminal) | Ctrl+Shift+↑ / ↓ | ⌘↑ / ↓ |
| Terminal: back to the bottom | Ctrl+Shift+End | ⌘End |
| SSH hosts | Ctrl+Alt+H | ⌘⌥H |

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
- **Accounts**, **Integrations**, **Remote (SSH)**, **Mobile**, **Voice**, **Plugins**,
  **Layouts**, **Quick Commands**, **Automations**, **Shortcuts**: see above.
- **Terminal**: font, size, line height, scrollback, renderer (WebGL / DOM), cursor blink,
  default shell, colour theme, floating terminal.
- **Appearance**: language, dark or light theme, compact density, interface text size, editor
  word wrap.
- **Notifications**: desktop notifications and their sound, notes about shortcuts kept from
  the terminal, first-run tips.
- **Usage & Resources**: usage and memory meters.
- **Session Daemon**: status, data folder and log, *Stop daemon & all sessions*.

Settings and layouts live in `app-state.json` in the data folder; when its format changes the
old file is first copied to `app-state.v<N>.bak.json`.

## Automation

Besides `erkad terminal …`, `erkad worktree …` and `erkad run …` (above), `erkad call <method> [json]` talks
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

Voice dictation needs the speech helper: `cargo build --release -p erka-stt` (the build script
does it; it downloads the speech engine's prebuilt library, ~120 MB, at build time). A
development build finds it in `target/release`.

Development: `scripts/dev-daemon.sh run` (isolated endpoint/data dir), then in `app/`
`ERKA_ENDPOINT=erka-dev pnpm tauri dev`. Tests: `cargo test`, `pnpm typecheck`,
`pnpm i18n:check` (every interface text has a Vietnamese translation), `erkad bench --sessions
20 --mb 2`, and the WebDriver end-to-end scripts in `scripts/e2e/`
(require `tauri-driver` + a matching `msedgedriver`).
