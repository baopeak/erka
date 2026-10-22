# Erka architecture

Erka is a desktop workbench for running many coding-agent CLIs (Claude Code, Codex, OMP,
shells) across many projects at once. Performance comes from one rule: **the UI owns
nothing that must keep running**. Every PTY and agent process lives in a background daemon,
and the UI renders only what is on screen.

## Processes

```
Erka (Tauri app)                          erkad (session daemon, one per user)
├─ WebView: SolidJS UI, xterm.js, CM6     ├─ Session × N  (PTY + VT state + ring buffer)
├─ child webviews (browser panes)         ├─ ChatSession × N (agent stdio JSON relay)
├─ Rust core: daemon client, fs, git,     ├─ status ticker (250 ms) + persistence (30 s)
│  search, file watcher, transcript       ├─ runs engine, automations
│  history, usage, accounts, plugins,     ├─ phone server (opt-in, HTTP/WS on the LAN)
│  integrations, remote (ssh), voice      │
├─ local socket ◄──────────────────────►  └─ local socket server
└─ stdin/stdout ◄──► erka-stt (speech)    erkad hook  ◄── agent hooks (Claude/Codex)
```

| Process | Lifetime | Owns |
|---|---|---|
| `Erka` | while the window is open | layout, settings (`app-state.json`), views |
| `erkad` | until stopped explicitly (or logoff) | PTYs, agent processes, terminal state, `sessions.json`, snapshots |
| `erka-stt` | while dictation is used (exits after 10 idle minutes) | the loaded speech model, the microphone stream |
| agent CLIs | per session | — |

`app-state.json` carries a format `version` (currently 3: n-ary pane splits). A file with an older version, an
unknown format or one that cannot be read is first copied to
`app-state.<label>-<time>.bak.json`; if that copy fails, or the file comes from a newer Erka,
the app runs without saving rather than overwrite it.

Closing or crashing the app never stops a session. If `erkad` itself stops, sessions that
were running are restored *interrupted* with their last screen; the app resumes them when they
are shown, all at once, or on request (Settings → Agents). Agents resume their conversation
(`--resume <id>` / `resume <id>`; a Claude id that was never saved to a transcript is not
resumed, and the id is recovered from transcripts when hooks never reported it); shells
restart below their old output.

Data: `%LOCALAPPDATA%\Erka` (Windows), `~/Library/Application Support/Erka` (macOS).
`ERKA_DATA_DIR` and `ERKA_ENDPOINT` override both (used by the dev scripts and tests).

## Transport

Local socket only — no TCP port. Windows: named pipe `\\.\pipe\erka-<user>-v1` with a
protected DACL (SYSTEM + owner). macOS: `erkad-v1.sock` (mode 0600) in the data dir.
Single instance is enforced with an exclusive lock file.

Frames (`crates/erka-proto`): `u32 LE length | u8 kind | payload`

| kind | direction | payload |
|---|---|---|
| 1 JSON | both | `{"id","method","params"}` / `{"id","result"\|"error"}` / `{"event","params"}` |
| 2 Output | daemon → app | `u32 handle \| u64 seq \| bytes` (`seq` = stream offset after the bytes) |
| 3 Input | app → daemon | `u32 handle \| bytes` |

RPC methods: `daemon.info|set_theme|set_awake|shutdown`, `session.list|create|attach|detach|input|resize|focus|kill|close|restart|update|read|set_unread`, `chat.close_stdin`, `hook.report`, `agent.presets|run|set_custom`, `meta.list|get|set`, `automation.list|save|delete|run`, `run.list|get|create|approve|retry|task_done|task_skip|cancel|delete|report`, `mobile.status|enable|disable|pair_start|approve|revoke|set_write|set_projects`.
`daemon.info` reports an `api` feature level (`erka_proto::API_LEVEL`); an app built for a
higher level offers to restart an older daemon still running from a previous version.
Events: `session.updated` (coalesced, 250 ms), `session.closed`, `session.resync`, `session.clipboard`, `meta.updated`, `automation.ran`, `run.updated`, `mobile.pair_request`.

## Session threading (daemon)

Per terminal session:
- **reader thread** — blocking PTY read (64 KiB) → `Session::ingest`: feed `alacritty_terminal`
  (the only VT parser in the system), append to a 1 MiB ring, fan out to subscribers.
  It never blocks on consumers.
- **writer thread** — owns the PTY master; input and resizes are serialised here, so a large
  paste can never deadlock against the reader (ConPTY requirement).
- **waiter thread** — waits for exit, closes the pseudoconsole, records the exit code.

Each subscriber has a 4 MiB unsent-byte budget. A slow view is marked stalled and told to
`resync`; the PTY keeps draining and the other sessions are unaffected.

Terminal queries (DA, DSR, OSC 10/11 colours) are answered by the daemon only while no
interactive view is attached; an attached xterm answers itself. The daemon answers colour
queries with the palette of the app's current theme (`daemon.set_theme`).

Windows: each session runs in its own Job Object (kill-on-close, owned by the daemon) so a
kill reaches the whole process tree; the daemon (started by the app in a new process group,
which Windows marks as ignoring Ctrl+C) clears that mark at start so sessions still get Ctrl+C; a modern `conpty.dll`/`OpenConsole.exe` is sideloaded
(see `third_party/conpty`). macOS: process groups (`killpg`) and a login shell (`$SHELL -l -c
exec …`) so agents see the user's PATH.

## Attach semantics

`session.attach {handle, since_seq?}` replies (inline, under the session lock, so no output
can slip between the reply and the live stream) with one of:

| mode | when | client action |
|---|---|---|
| `delta` raw | `since_seq` still in the ring, ≤ 256 KiB behind, no resize since | append bytes |
| `reset` raw | whole stream ≤ 256 KiB and never resized | reset, write bytes |
| `reset` snapshot | otherwise | reset, write ANSI snapshot (scrollback ≤ 2000 lines, SGR, wide chars, cursor, modes, title) |

Raw replays may contain terminal queries, so the view suppresses its own replies while
writing them.

## UI rendering policy

- Only the active project's active tab is mounted. Hidden terminals are *parked*: daemon
  subscription dropped, xterm buffer kept, element moved to a hidden holder that stays in the
  document (detaching a live WebGL canvas costs Chromium 100–200 ms). The 6 most recently
  hidden views keep their WebGL context (creating one costs 100–400 ms); older ones drop it,
  since browsers cap live contexts at ~16. Re-showing is a delta replay of what was missed. At
  most 16 parked views are kept; older ones are rebuilt from a snapshot.
- Output reaches the webview through one binary `Channel` per visible terminal, coalesced
  every 4 ms (`daemon_client.rs`).
- Solid's fine-grained stores mean a status change on one session re-renders only its dot.
- The file watcher and git status only run for the active project; git commands are capped
  at 3 concurrent processes and debounced (300 ms).

## Agent status

Priority: agent hooks → bell → output activity.
- Claude Code: launched with `--settings <erka hooks file>`; every hook runs `erkad hook claude`,
  which reports the event (and the Claude session id) over the socket.
- Codex: `-c notify=[erkad, hook, codex]` (turn completion + thread id).
- Others: output activity (≥ 1.5 s of output after the echo window = working) and BEL.

States: `working`, `waiting` (needs you), `idle` (+ `unread` after ≥ 3 s of work while not
visible), `exited`. Desktop notifications fire on working → idle/waiting when the session is
not visible.

## Chat mode

A chat session is a daemon `ChatSession`: the agent runs with piped stdio and the daemon
relays JSON lines (logged for replay on re-attach). Adapters in `app/src/chat` map each
dialect to one item model (user, assistant, thinking, tool card with diff, permission, result):

| Agent | Process | Protocol |
|---|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages --permission-prompt-tool stdio [--resume id]` | stream-json + `control_request`/`control_response` |
| Codex | `codex app-server` | JSON-RPC: `initialize`, `thread/start|resume|list`, `turn/start|interrupt`, approvals |
| OMP | `omp acp` | ACP: `session/new|load|prompt|cancel`, `session/update`, `session/request_permission` |

Terminal ↔ chat switching hands off the *conversation*: find the conversation id (hooks,
transcript directory, or `thread/list`), stop the old front-end (Ctrl+C twice, then kill)
so there is never a second writer, and start the other front-end resuming the same id in
the same pane. Claude history from before the switch is read from its transcript file.

## App-side services (Rust core)

| Module | Does |
|---|---|
| `agent_history.rs` | Lists past Claude / Codex / OMP conversations from their transcripts (`~/.claude/projects`, `~/.codex/sessions` incl. `.jsonl.zst`, `~/.omp/agent/sessions`). Only the first 512 KB of a file (plus Claude's tail for its latest title) is read; results are cached by mtime/size in `history-cache.json`. Prompt counts run on two background threads, resume from the last counted line of append-only files, and emit `agent-history-counted`. |
| `usage.rs` | Claude (`api.anthropic.com/api/oauth/usage`) and Codex (`chatgpt.com/backend-api/wham/usage`) plan windows, using the agents' own OAuth sign-in. Tokens never leave this module; the webview gets percentages and reset times only. |
| `sys_stats.rs` | Memory of the app + WebView tree, the daemon and its descendants (PID-reuse safe). |
| `git.rs` | Status, branch summary, diffs, staging, commits, worktrees (`add` / `remove` / `prune`, file at a revision, commits only a detached HEAD reaches). |

## Worktrees

A git worktree is a project with `parentId` (its repository) and `branch`; it has its own
tabs, layouts and sessions and switches like any project. Removal checks for changes and
commits only the worktree holds, leaves the worktree, stops sessions in its folder and waits
for their processes (Windows cannot delete a folder in use), then runs `git worktree remove`
— never deleting the branch. `.erka.yaml` (setup commands, default tabs) is read from the base
commit, shown in full, and runs only when the user opts in; approval is remembered per
repository by the file's hash.

## Daemon services beyond sessions

- **Agent presets** (`agents.rs` `PRESETS`): binary, launch args, skip-permission flags,
  "continue latest" flags and how a first prompt is passed (argument, flag, or typed). The UI
  reads them with `agent.presets` (with an installed check) and adds the Yolo flags itself.
  Agents without hooks restart with their "continue latest" flags.
- **Typed prompts** (`session.rs` `PendingPrompt`): a prompt for an agent that takes none at
  launch, or a shell startup command, is written once the program has run ≥ 2.5 s and been
  quiet for 1.2 s (30 s at most): a bracketed paste for agents, keystrokes for shells, then
  Enter as a separate write.
- **One-shot runs** (`oneshot.rs`, `agent.run`): `claude -p` / `codex exec -` with the prompt on
  stdin, on its own thread; the reply is sent later on the client's channel, so a slow model
  never blocks that client's ordered request queue.
- **Workspace notes** (`meta.rs`, `meta.*`, `workspace-meta.json`): comment + board status
  per canonical folder path; `meta.updated` is broadcast. `erkad worktree get|set` defaults to
  the git top level of the current folder.
- **Automations** (`automations.rs`, `automation.*`, `automations.json`): hourly / daily /
  weekdays / weekly in local time (chrono). The ticker checks every 10 s; a run creates an
  ordinary session with the prompt and is broadcast as `automation.ran`. Runs missed by more
  than 30 min are skipped.
- **Keep awake** (`awake.rs`, `daemon.set_awake`): Windows `SetThreadExecutionState` from one
  dedicated thread, macOS a `caffeinate -i -w <pid>` child; mode *agents* holds it while any
  non-shell session is working.
- **Terminal palette**: `daemon.set_theme` takes an optional palette (16 ANSI + fg/bg/cursor)
  so colour-query answers match the chosen terminal theme.
- **CLI** (`cli.rs`): `erkad terminal list|read|send|wait` and `erkad worktree get|set` over
  the same RPCs.

## Features beyond sessions

| Area | Where | How |
|---|---|---|
| Layouts | `app/src/lib/layout.ts` | A tab is a tree of n-ary splits (`children`, `sizes`) with pane leaves; grids are built from `{mode: rows\|cols, counts}`; saved layouts are templates (tree shape + session kind per leaf). Version-2 binary trees migrate on load. |
| Accounts | `app/src-tauri/src/accounts.rs`, `lib/accounts.ts` | One config home per account under `<data>/accounts/<agent>/<id>`, passed as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to every launch (terminal, chat, automations, runs, one-shot AI actions); history and usage read each home. |
| Orchestration | `crates/erkad/src/runs.rs` | A run is a task DAG (cycle-checked) persisted in `runs.json`. `Runs::step` starts ready tasks (deps done, approval given) as ordinary sessions, optionally in a new worktree; tasks end on `erkad run report`, session exit, or idle after working (default 300 s). |
| Integrations | `app/src-tauri/src/integrations.rs` | Linear GraphQL, Jira REST (Cloud v3 `search/jql`, Server v2), GitLab REST v4. Tokens live in the OS keyring (`keyring`, service `Erka (<endpoint>)`) and never reach the webview. |
| Browser panes | `app/src-tauri/src/browser.rs`, `browser_picker.js` | Tauri child webviews positioned over the pane (hidden while an overlay covers them). Design mode injects a picker; picks travel through a cancelled navigation to a sentinel URL, are redacted and size-capped, and the element screenshot uses the WebView2 DevTools protocol (end-to-end tests also send trusted page input through it, `browser_test_input`, dev / e2e builds only). |
| Remote (SSH) | `app/src-tauri/src/remote.rs`, `agents.rs` `build_remote_launch` | The system OpenSSH client (on Windows `System32\OpenSSH`, never a Git Bash one from PATH): sessions run `ssh -t host` with a login shell, inside `tmux new-session -A` when available; files, search and git run as remote commands with quoted arguments. Commands never prompt: secrets come from askpass, anything else fails. |
| SSH hosts | `app/src-tauri/src/ssh_hosts.rs`, `crates/erkad/src/askpass.rs`, `app/src/components/hosts-page.tsx` | Saved hosts and forward rules in `<data>/ssh/hosts.json`, rendered into `<data>/ssh/config` (one `Host` per saved host, then `Match all` + `Include` of the user's config) that every Erka `ssh` / `scp` reads with `-F`. Passwords and key passphrases live in the OS keyring (service `Erka (<endpoint>)`); ssh gets them through `SSH_ASKPASS=erkad` + `SSH_ASKPASS_REQUIRE=force` + `ERKA_ASKPASS=<host id>` — `erkad` answers password / passphrase prompts and declines host-key questions, which the page settles with `ssh-keyscan` fingerprints first. Connecting to a host opens a remote project on it. Port forwards are `ssh -N` children of the app (stopped with it; auto-start rules restart on launch); transfers are `scp -r -p` (SFTP). Keys, agent and known hosts go through `ssh-keygen` / `ssh-add` and the known_hosts file. `ERKA_SSH_DIR` replaces `~/.ssh` for the tests. |
| Phone server | `crates/erkad/src/mobile.rs`, `crates/erkad/mobile/` | axum on a chosen address (default port 4817), optional rustls (ring). Pairing: a one-time code shown as a QR (2 min) and approved in the app; device tokens are stored as SHA-256 and compared in constant time; Origin checks, CSP, rate limits; revoking closes the device's sockets. |
| Plugins | `app/src-tauri/src/plugins.rs`, `lib/plugins.ts` | Declarative manifests (see [plugins.md](plugins.md)); approval bound to the manifest SHA-256; agents are sent to the daemon (`agent.set_custom`, kept in `custom-agents.json`). |
| Voice | `crates/erka-stt`, `app/src-tauri/src/voice.rs`, `lib/voice.ts` | A separate helper process: sherpa-onnx (static, offline) with a Vietnamese zipformer or Whisper; `cpal` microphone capture mixed to mono; JSON lines over stdin/stdout; models downloaded on request and verified by pinned SHA-256. Kept out of the app and daemon so the native engine can never take them down. |
| Language | `app/src/lib/i18n.ts`, `app/src/locales/vi/*.json` | `t("English text")` looks the text up in the Vietnamese dictionaries (English is the key and the fallback); reactive on the language setting; dates through `Intl`. `pnpm i18n:check` reports missing translations. |

## Measured (Windows 10, see `plans/reports/`)

- 20 sessions × 2 MiB output: 40 MiB in 3.9 s through the daemon, 0 sequence gaps.
- Attach (snapshot) p50/p95: 4.4 / 5.8 ms.
- Project switch (3 projects with terminals): release p50 ≈ 30 ms, p95 40–52 ms; dev build p95 35–105 ms.
- Session history, 421 transcripts / 1.2 GB (release build): first scan 0.5 s, later launches
  (disk cache) 34 ms; the first full prompt count runs in the background (~15–30 s).
