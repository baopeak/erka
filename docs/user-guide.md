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

1. **Add a project**: sidebar `+` (or palette → *Add Project Folder…*).
2. **Start a session**: click Claude / Codex / OMP / Terminal on the empty project screen, or
   `+` in the tab bar for options (extra args, name, split, *Chat view*).
3. **Switch projects**: click in the sidebar or `Alt+1…9` (`⌘1…9`). Badges show sessions that
   need you (amber), are working (blue) or finished unread (green).
4. **Dashboard** (`Ctrl+Shift+M` / `⌘⇧M`): every session of every project grouped by
   *Needs you / Working / Done / Idle* — click a card to jump there.
5. **Files**: the right panel has Files, Changes (git) and Search. Click a file to open it in
   the editor (`Ctrl+S` saves; external changes are detected); click a change to see its diff.
6. **Chat view**: in an agent pane header click the chat icon to continue the *same
   conversation* in a chat UI (messages, tool cards with diffs, Allow/Deny prompts); the
   terminal icon switches back to the TUI. Erka stops one front-end before starting the other,
   so a conversation never has two writers.

When an agent exits, the pane offers **Restart** / **Resume** (agents resume their
conversation). Desktop notifications fire when a session you are not looking at finishes or
needs input.

## Keyboard shortcuts

App shortcuts use `Ctrl+Shift` on Windows so plain `Ctrl+letter` keys reach the agent TUIs.

| Action | Windows / Linux | macOS |
|---|---|---|
| Command palette | Ctrl+Shift+P | ⌘⇧P |
| Go to file | Ctrl+Shift+O | ⌘P |
| Jump to session / project | Ctrl+Shift+K | ⌘K |
| Agent dashboard | Ctrl+Shift+M | ⌘⇧M |
| New terminal | Ctrl+Shift+T | ⌘T |
| New session… | Ctrl+Shift+N | ⌘⇧N |
| Split right / down | Ctrl+Shift+D / Ctrl+Shift+S | ⌘D / ⌘⇧D |
| Close pane | Ctrl+Shift+W | ⌘W |
| Next / previous pane | Alt+] / Alt+[ | ⌘] / ⌘[ |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | ⌃Tab / ⌃⇧Tab |
| Project 1…9 | Alt+1…9 | ⌘1…9 |
| Find in terminal | Ctrl+Shift+F | ⌘F |
| Explorer / Changes / Search panel | Ctrl+Shift+E / G / H | ⌘⇧E / G / F |
| Toggle sidebar | Ctrl+Shift+B | ⌘B |
| Font size + / − / reset | Ctrl+= / Ctrl+- / Ctrl+0 | ⌘= / ⌘- / ⌘0 |
| Settings | Ctrl+, | ⌘, |

In terminals: `Ctrl+C` copies when text is selected (otherwise it is sent to the program),
`Ctrl+V` pastes, `Shift+Enter` inserts a newline in agent prompts, `Ctrl/⌘+click` opens links.
Drop files from Explorer/Finder onto a terminal to paste their paths. Programs may set the
clipboard (OSC 52) only from the terminal you are looking at, and Erka shows a notice when
they do.

## Settings

Font, size, line height, scrollback, renderer (WebGL / DOM fallback), cursor blink,
notifications, default shell command and per-agent extra arguments (e.g. `--model opus` for
Claude, `--model gpt-6-astra` for Codex — also used by chat view). *Stop daemon & all
sessions* ends everything.

## Automation

`erkad call <method> [json]` talks to the running daemon, e.g.

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
