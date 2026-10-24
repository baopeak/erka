# Kelpie architecture

Kelpie is a desktop workbench for running many coding-agent CLIs (Claude Code, Codex, OMP,
shells) across many projects at once. Performance comes from one rule: **the UI owns
nothing that must keep running**. Every PTY and agent process lives in a background daemon,
and the UI renders only what is on screen.

## Processes

```
Kelpie (Tauri app)                        kelpied (session daemon, one per user)
├─ WebView: SolidJS UI, xterm.js, CM6     ├─ Session × N  (PTY + VT state + ring buffer)
├─ child webviews (browser panes)         ├─ ChatSession × N (agent stdio JSON relay)
├─ Rust core: daemon client, fs, git,     ├─ status ticker (250 ms) + persistence (30 s)
│  search, file watcher, transcript       ├─ runs engine, automations
│  history, usage, accounts, plugins,     ├─ phone server (opt-in, HTTP/WS on the LAN)
│  integrations, remote (ssh), voice      │
├─ local socket ◄──────────────────────►  └─ local socket server
└─ stdin/stdout ◄──► kelpie-stt (speech)  kelpied hook  ◄── agent hooks (Claude/Codex)
```

| Process | Lifetime | Owns |
|---|---|---|
| `Kelpie` | while the window is open | layout, settings (`app-state.json`), views |
| `kelpied` | until stopped explicitly (or logoff) | PTYs, agent processes, terminal state, `sessions.json`, snapshots |
| `kelpie-stt` | while dictation is used (exits after 10 idle minutes) | the loaded speech model, the microphone stream |
| agent CLIs | per session | — |

`app-state.json` carries a format `version` (currently 3: n-ary pane splits). A file with an older version, an
unknown format or one that cannot be read is first copied to
`app-state.<label>-<time>.bak.json`; if that copy fails, or the file comes from a newer Kelpie,
the app runs without saving rather than overwrite it.

Closing or crashing the app never stops a session. If `kelpied` itself stops, sessions that
were running are restored *interrupted* with their last screen; the app resumes them when they
are shown, all at once, or on request (Settings → Agents). Agents resume their conversation
(`--resume <id>` / `resume <id>`); shells restart below their old output. A new Claude Code
terminal session gets its id from Kelpie (`claude --session-id <uuid>`, unless the user's own
arguments pick the conversation), so the id is known before any hook runs — also on an SSH
host, where hooks never run. Hooks still follow it when it changes (`/clear`, `/resume` inside
Claude). An id never saved to a transcript (nothing sent yet) starts again under the same id;
on an SSH host the remote shell checks for the transcript and runs `--resume` or
`--session-id`. Other agents' ids come from hooks or are recovered from transcripts.

Data: `%LOCALAPPDATA%\Kelpie` (Windows), `~/Library/Application Support/Kelpie` (macOS).
`KELPIE_DATA_DIR` and `KELPIE_ENDPOINT` override both (used by the dev scripts and tests).

## Transport

Local socket only — no TCP port. Windows: named pipe `\\.\pipe\kelpie-<user>-v1` with a
protected DACL (SYSTEM + owner). macOS: `kelpied-v1.sock` (mode 0600) in the data dir.
Single instance is enforced with an exclusive lock file.

**Callers** (`crates/kelpied/src/auth.rs`). A connection names itself with `auth` before
anything but `daemon.info` answers:
- the **user token**, written at start to `<data base>/Kelpie/auth/<endpoint>.token` (owner-only,
  new per daemon run, keyed by endpoint so a dev app and dev daemon agree): the app, `kelpied`
  outside a session, `scripts/kelpie-call.py`. Full access; raw Input frames are accepted from it only.
- a **session token** (`KELPIE_SESSION_ID` + `KELPIE_SESSION_TOKEN`, derived from a per-daemon
  secret, set in each session's environment with `KELPIE_SESSION_ENDPOINT`): `kelpied` inside a
  session of that daemon (against another endpoint it uses that daemon's user token). The scripting
  surface (`session.list|read|input|create`, `meta.*`, `run.*` except `approve` — approval gates wait
  for the user — and `delete`, `hook.report`); `hook.report` and `run.report` always speak for the
  caller's own session, and `session.list` leaves other sessions' `env` out. With *Agents can control
  other sessions* off (`daemon.set_policy`, saved in `policy.json`) or a session created `restricted`,
  only its own session (`meta.set` compared on canonical paths, `..` refused). Everything else
  (settings, custom agents, automations, phone access, closing sessions) is the user's.
- a **claimed** session (`KELPIE_SESSION_ID` without its token, which some agents strip from the
  programs they run): hook reports for that session only. `kelpied` never falls back to the user
  token inside a session.

Programs run as the same OS user and could read the user token if not sandboxed: this scopes
what agents do through Kelpie by default; it is not a boundary against deliberate same-user code.

Text Kelpie types into a session as a prompt, and every paste into a terminal view (clipboard,
drops, inserted paths, quick commands), drops control characters first (`session::typed_text`,
`typedText` in `typed-text.ts`, applied in `TerminalHost.paste`), so quoted content cannot end a
bracketed paste early. Text sent out of a
session (hand-off, Copy Context, notes or issues sent to an agent) passes `kelpie_proto::redact`.

Frames (`crates/kelpie-proto`): `u32 LE length | u8 kind | payload`

| kind | direction | payload |
|---|---|---|
| 1 JSON | both | `{"id","method","params"}` / `{"id","result"\|"error"}` / `{"event","params"}` |
| 2 Output | daemon → app | `u32 handle \| u64 seq \| bytes` (`seq` = stream offset after the bytes) |
| 3 Input | app → daemon | `u32 handle \| bytes` |

RPC methods: `auth`, `daemon.info|set_theme|set_awake|set_priority|policy|set_policy|shutdown`, `session.list|create|attach|detach|input|answer|resize|focus|kill|close|restart|update|read|set_unread`, `chat.close_stdin`, `hook.report`, `agent.presets|run|set_custom`, `meta.list|get|set`, `automation.list|save|delete|run`, `run.list|get|create|approve|retry|task_done|task_skip|cancel|delete|report`, `mobile.status|enable|disable|pair_start|approve|revoke|set_write|set_projects`.
`daemon.info` reports an `api` feature level (`kelpie_proto::API_LEVEL`); an app built for a
higher level offers to restart an older daemon still running from a previous version.
Events: `session.updated` (coalesced, 250 ms), `session.turn` (API 9: `{session, event, transcript_path?, agent_session_id?}`, from every agent hook and when a session leaves `working`; built by the daemon from the hook payload, so no program can publish one — the app reads a session's usage on it, see "Context, tokens and cost"), `session.closed`, `session.resync`, `session.clipboard`, `meta.updated`, `automation.ran`, `run.updated`, `mobile.pair_request`.

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

Priority: agent hooks → bell → prompt on screen → output activity.
- Claude Code: launched with `--settings <kelpie hooks file>` (and `--session-id`, see above);
  every hook runs `kelpied hook claude`, which reports the event (and the Claude session id,
  which changes on `/clear`) over the socket.
- Codex: `-c notify=[kelpied, hook, codex]` (turn completion + thread id). Codex also runs
  unsaved background threads of its own that notify too; `kelpied hook` keeps a thread id only
  when Codex saved that thread (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, the day
  read from the UUIDv7 id), so a restart resumes the conversation, not a helper thread.
- Others: output activity (≥ 1.5 s of output after the echo window = working) and BEL.
- Any terminal session (agents without hooks above all — Codex approvals, Gemini, Aider,
  OpenCode — and shells): once output has been quiet 700 ms and the screen changed since the
  last look, `choices::detect` reads its last 14 lines for a prompt waiting at the cursor
  (a numbered menu starting at 1 with a marker or a question above it, `(y/n)` / `[Y/n]`,
  `(Y)es/(N)o`, `Yes (y)`…). Found → `waiting` until input or new output; `waiting_since`
  (wall-clock ms) is kept while it waits. `session.read` returns the prompt (`keys`,
  `question`, `line` = needs Enter). `session.answer {handle, waiting_since, data|key, enter}`
  types only while the session still waits on that same prompt, text through `typed_text`,
  Enter as a separate write; programs in a session may not call it. The app hides quick
  answers on daemons below API 7.

States: `working`, `waiting` (needs you), `idle` (+ `unread` after ≥ 3 s of work while not
visible), `exited`. Desktop notifications fire on working → idle/waiting when the session is
not visible.

## CPU priority (Windows)

A keystroke crosses daemon → console host → agent → console host → daemon → webview, and
Windows' foreground boost goes to Kelpie's window only. On a busy machine every hop queues
behind other work, so with `daemon.set_priority {enabled}` (the app's *Prioritize visible
terminals*, on by default) the 250 ms ticker applies `proc_tree::Priority` per session:

| Session | Agent process + its ConPTY host | Rest of the tree |
|---|---|---|
| has an interactive view (on screen) | above normal | normal |
| no view | normal | normal |
| chat session | normal (its input is the app's own field) | normal |

Nothing is ever lowered: measured, a shell or agent at below-normal priority printed nothing for
30 s and more while other programs kept a 4-core CPU busy, which would freeze every hidden
session.

"Agent process" is the session's root, or — when the root only launches the agent (an npm shim
runs `node codex.js`, which starts `codex.exe`) — the root's child named after the agent's
binary too. The daemon runs above normal while the policy is on (children still start
normal); a hidden session's output-reader thread drops to the lowest thread priority, so
parsing its output does not run ahead of other programs. The console host is the
`OpenConsole.exe`/`conhost.exe` child that appears while the pseudoconsole is created
(serialised). A raised session is raised again every 5 s (a launcher starts the agent's own
process a moment later); other states are applied once. A `custom` session on screen stays
normal (its root is usually the workload itself). The Win32 calls run in a blocking task, off
the session locks and the async ticker. Measured with `kelpied bench-echo` (keystroke → daemon screen, optional
`--load N` busy sessions / `--external N` busy processes) and `scripts/e2e/typing_latency.py`
(→ rendered frame). Unix: no-op, an unprivileged process cannot raise niceness back.

## Chat mode

A chat session is a daemon `ChatSession`: the agent runs with piped stdio and the daemon
relays JSON lines (logged for replay on re-attach). The agents' lines carry no time, so the
daemon puts a `{"type":"kelpie_time","at":<unix ms>}` line ahead of the first line of each
second; a replay dates every item from it (Claude history read from its transcript uses the
entries' own `timestamp`). Adapters in `app/src/chat` map each
dialect to one item model (user, assistant, thinking, tool card with diff, permission, result):

| Agent | Process | Protocol |
|---|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages --permission-prompt-tool stdio [--resume id]` | stream-json + `control_request`/`control_response`: `initialize` (commands, models + effort levels, permission mode), `set_model`, `set_permission_mode`, `apply_flag_settings{effortLevel}`, `interrupt`; slash commands are sent as text and run by the CLI |
| Codex | `codex app-server` | JSON-RPC: `initialize`, `thread/start|resume|list`, `turn/start|interrupt` (model, effort, approval/sandbox ride on `turn/start`), `model/list`, `skills/list`, `thread/compact/start`, `review/start`, `thread/shellCommand` (`!cmd` typed in the composer — it runs outside the sandbox, as in the TUI; never for text Kelpie sends for the user), approvals; `$skill` adds a `skill` input item |
| ACP agents: OMP `omp acp`, Gemini `gemini --acp`, OpenCode `opencode acp`, Copilot `copilot --acp`, Goose `goose acp`, Qwen `qwen --acp`, Kimi `kimi acp`, Auggie `auggie --acp`, Cursor `cursor-agent acp`; plugin agents with an `acp` field | `ACP_ARGS` (`lib/agents.ts`) | ACP v1 (`protocolVersion: 1`; another answer stops with a message): `initialize` (no fs/terminal — the agent uses its own tools; `auth.terminal`, form `elicitation`), `session/new|load` (load only when `loadSession`; the ACP session id is the session's conversation id), `prompt`, `cancel`, `session/update` (chunks, tool calls, `plan`, `usage_update`, `available_commands_update`, `config_option_update`, `current_mode_update`), `set_config_option` (older `modes` / `models` blocks: `set_mode` / `set_model`), `request_permission` (the agent's option ids echoed), `elicitation/create` (form → a card with questions; url → declined), sign-in: `auth_required` → `agent` methods via `authenticate`, `terminal` methods named for the user to run, then retry. The daemon counts only message, thought and tool-call updates as work (usage, title, plan, mode and command updates arrive between turns), elicitation as waiting, and takes `session_info_update` titles as the session's title. |

The composer (`components/chat-composer.tsx`) completes `/` from the adapter's command list,
`$` from Codex skills and `@` from Kelpie's file index (`quick_open`), and shows the adapter's
settings (model / effort / mode) as pickers. `/clear`, `/new` and `/reset` start a new
conversation with an empty transcript in every agent. Claude Code runs them itself
(`conversation_reset`); for Codex and ACP agents chat view runs them as `thread/start` /
`session/new`, whatever the agent lists: in ACP mode most agents pass `/clear` to the model as a
prompt (Gemini, OpenCode, OMP, Copilot) and the rest only empty the context of the same session
(Goose, Qwen, Kimi), so an agent's own `clear` is not listed. Those lines and answers sit in the
replay log, so a replay clears at the same point. The model picker keeps the model a Codex
thread was started with even when Codex's catalog does not list it (one set in `config.toml`).
A command chat view cannot run (Claude's
`terminal_slash_commands`, a Codex command without an app-server request) offers *Run it in
the terminal*: the hand-off below, with the command as the new session's prompt. A resumed
launch passes it as an argument (`claude --resume <id> "/cmd"`, `codex resume <id> "/cmd"`), so
the agent runs it in that conversation itself; a typed prompt (too long for a command line) waits
for the program's first output before the quiet period counts. The daemon keeps the
command/model/skill answers when it trims a chat's replay log. Streaming replies render
finished markdown blocks once and only the open block as text; off-screen messages use
`content-visibility: auto`.

Beyond the items, adapters fill shared state the UI renders the same way for every agent:

| State | Claude | Codex | ACP |
|---|---|---|---|
| plan | `TodoWrite` input | `turn/plan/updated` | `plan` update |
| usage (context used / window, cost) | `assistant.message.usage` (input + cache + output) / `result.modelUsage[model].contextWindow`, `total_cost_usd` | `thread/tokenUsage/updated` (`last.totalTokens` / `modelContextWindow`) | `usage_update` when sent |
| turn diff | from Edit/Write inputs | `turn/diff/updated` | from `diff` contents |
| tool category | tool name | `commandActions` (read / listFiles / search) | tool `kind` |

`chat/tool-view.ts` turns a tool item into a row (verb, target, detail, IN/OUT) and diffs
edit strings line by line. `ChatController` queues what is sent while the agent is busy and
sends it when the turn ends (adapters set `busy = false` last); *Send now* uses the adapter's
`steer` (Claude: written mid-turn, the CLI reads it at its next step; Codex: `turn/steer`,
queued again if refused) or stops the turn; stopping holds the queue. Approvals carry what they
are about (command, edit diff, plan) and Claude's `AskUserQuestion` / `ExitPlanMode` are
answered in their card (`updatedInput.answers`, `updatedPermissions: setMode acceptEdits`).

Terminal ↔ chat switching hands off the *conversation*: find the conversation id (hooks,
transcript directory, or `thread/list`), stop the old front-end (Ctrl+C twice, then kill)
so there is never a second writer, and start the other front-end resuming the same id in
the same pane. Claude history from before the switch is read from its transcript file.
The conversation's settings come along (`chat/agent-settings.ts`): Claude Code restores none of
them on `--resume`, so its transcript's last `permission-mode` entry and latest reply's `effort` /
requested model become `--permission-mode` / `--effort` / `--model` for the chat process (and seed
its pickers until a turn reports the model); back in the terminal, chat view's picks become those
flags (Codex: `-s`/`-a` or `--dangerously-bypass-approvals-and-sandbox`, `-m`,
`-c model_reasoning_effort`), replacing the profile's own. Codex's app-server and OMP restore a
conversation's own settings themselves.

## Context, tokens and cost

Per session: context fill (a ring on the sidebar row, pane header and tab: amber from 70 %, red
from 85 %, one-time Compact / Hand off hint at 85 %), tokens and cost. **No number without an
exact source**: a terminal session maps to its transcript only by the conversation id the daemon
recorded (`spec.agent_session_id`) — never "the newest file in the folder". No id, no numbers.

| Agent | File | Context | Cost |
|---|---|---|---|
| Claude Code | hook `transcript_path`, else `<config home>/projects/<slug>/<id>.jsonl`; plus its sub-agents `<slug>/<id>/subagents/agent-*.jsonl` (cost and tokens only) | last `assistant` line of the **main** file: input + cache read + cache write + output (none after a `compact_boundary`); window from `pricing.json` | estimate at API prices (shown "≈ $"), once per `message.id` at its highest output (a message is written as several lines; sub-agent files repeat it with a growing `output_tokens`) |
| Codex | `rollout-*-<thread id>.jsonl` under `sessions/YYYY/MM/DD`, found by thread id (cached) | `token_count.info.last_token_usage` and `model_context_window`; `info: null` records skipped | none: tokens only |
| OMP | `<ts>_<session id>.jsonl` | `contextSnapshot.promptTokens`, no window → no ring | the agent's own `usage.cost.total` (shown without "≈") |
| Chat view | the chat controller's `state.usage` | from the adapter (ACP `usage_update`, Claude / Codex) | as reported |

`session_usage.rs` keeps a per-file aggregate (`usage-cache.json`, resumed from the last complete
line, message ids hashed with the output counted so far) that also remembers the main file's last context,
so an update reads only what is new (at most 64 KB in all, sub-agent files included); a transcript without
an aggregate, or with a bigger gap, is counted on one background thread (context then comes from the
last 64 KB of the file, reverse scan, a cut or half-written line skipped) and the totals follow. A hook's
`transcript_path` is used only when it is exactly `<this session's config home>/projects/<slug>/<conversation id>.jsonl`,
local (UNC / `//` / `..` are refused by their text before any file access) and still inside `projects`
after symlinks resolve; otherwise the lookup by id applies. `pricing.json` holds the Claude prices; a model not in it
has tokens but no cost and no window. A line that looks like a usage record but does not parse is
counted and logged per agent (format drift hides numbers, it never invents them).

The app reads on `session.turn` (debounced 1 s, only for a visible or working session, or at a turn
end) and, against a daemon older than API 9, polls visible working sessions. The Usage & cost page
(`cost-page.tsx`, lazy) folds the same per-file aggregates by day / week / project / agent / model
(`usage_report`; a warm report only stats the files, ≤ 100 ms) and listens for `usage-scanned`.
An optional per-session cost cap (Settings → Usage & Resources, off by default) counts a Kelpie
session's conversations together (a `/clear` keeps the sum) and puts a red chip on the session and an
entry in the inbox; "Press Esc" interrupts the session once, the first time it is over the cap and
working, only when its numbers came from its own exact transcript. The hint, the cap's reactions and
the ring menu load lazily (`usage-alerts.ts`); the page's folding is in `usage-report.ts`.
Day boundaries on the page use today's UTC offset for all history (hourly buckets: no :30 / :45
splits, DST shifts an hour); Codex context uses `last_token_usage.total_tokens` (reasoning included).

## App-side services (Rust core)

| Module | Does |
|---|---|
| `agent_history.rs` | Lists past Claude / Codex / OMP conversations from their transcripts (`~/.claude/projects`, `~/.codex/sessions` incl. `.jsonl.zst`, `~/.omp/agent/sessions`). Only the first 512 KB of a file (plus Claude's tail for its latest title) is read; results are cached by mtime/size in `history-cache.json`. Prompt counts run on two background threads, resume from the last counted line of append-only files, and emit `agent-history-counted`. |
| `session_usage.rs`, `usage_report.rs` | Context / tokens / cost of a conversation from its transcript (Claude, Codex, OMP parsers, reverse tail, per-file aggregate cache, prices from `pricing.json`) and the cost report for the Usage page. See "Context, tokens and cost". |
| `usage.rs` | Claude (`api.anthropic.com/api/oauth/usage`) and Codex (`chatgpt.com/backend-api/wham/usage`) plan windows, using the agents' own OAuth sign-in. Tokens never leave this module; the webview gets percentages and reset times only. |
| `sys_stats.rs` | Memory of the app + WebView tree, the daemon and its descendants (PID-reuse safe). |
| `git.rs` | Status, branch summary, diffs, staging, commits, worktrees (`add` / `remove` / `prune`, file at a revision, commits only a detached HEAD reaches). |
| `updater.rs` | Updates through `tauri-plugin-updater`: `latest.json` from GitHub Releases, verified with the minisign public key in `tauri.conf.json`. Install = download (signature checked) → installer (Windows, passive with restart; the app exits) or in-place bundle swap and restart (macOS). The daemon is never stopped. Dev builds and `KELPIE_E2E` runs never check. Endpoint/key overrides and a dry install exist only with the `e2e-updater` feature. |

**Updates keep sessions running.** Windows cannot replace a running program, so the app
(`daemon_runtime.rs`, release builds) starts the daemon from a copy in one of two fixed slots,
`<data dir>/daemon/a` or `…/b` (`kelpied.exe`, `conpty.dll`, `OpenConsole.exe` — the sideloaded ConPTY
starts its console hosts from its own folder; `build.txt`, written last, names the build). A new
build goes into the slot no daemon runs from; two fixed paths keep firewall rules (phone access)
and paths an agent was told valid across updates. The installer replaces the install folder while that daemon
and every session keep running; the installer restarts the app, which reconnects to them.
`checkDaemonApi` (run before interrupted agents resume) sees the older daemon and keeps it until no
session runs on it — checked again from the daemon's own list after 10 s of quiet, since a session can
be down for a moment (restart keeping the conversation, terminal↔chat switch); newer daemons also
refuse `daemon.shutdown {if_idle}` while anything runs — then it shuts it down and the app starts
the new copy; or the user picks *Switch now* (graceful stop: sessions come
back interrupted, agents resume). An updated app therefore has to work with an older daemon (API level
6 or newer): features that need newer RPCs check `daemon.info.api` and stay hidden until the
switch. A daemon started from a slot
removes anything else in `daemon/` no daemon runs from (`runtimes.rs`). A release that fixes a
daemon security problem raises `DAEMON_SECURITY_LEVEL`; against an older daemon the app then keeps a
*Switch session daemon* chip in the status bar until the user switches — it never stops sessions
by itself. macOS replaces
the bundle in place while the daemon keeps running from the old inode.

The NSIS hooks (`installer/hooks.nsh` → `installer/stop-daemon.ps1`) close the app first (Tauri's
`CheckIfAppIsRunning`), then stop only programs **directly in `$INSTDIR`** — a daemon started by
Kelpie 0.1.x before copies existed, gracefully with `kelpied stop --wait` and a wait for its exit —
compared in 8.3 form. The uninstaller an upgrade runs in place ("uninstall before installing",
`$EXEDIR == $INSTDIR`) does the same; only a real uninstall also stops and removes the copies in
`$LOCALAPPDATA\Kelpie\daemon`. `daemon.info.exe` tells the update dialog whether this update still has
to stop sessions (a daemon from the install folder: the one-time move from 0.1.x). A legacy daemon whose session runs the installer makes it refuse
(exit 3) rather than end that session. A graceful stop keeps sessions resumable: `persist(true)`
saves them as running before the process exits, and `restore()` marks them interrupted. Releases: tag `v<version>` → `.github/workflows/release.yml` builds and signs
(`tauri.updater.json` turns on updater artifacts; macOS as one `universal-apple-darwin` build whose
sidecars `build-release.sh` joins with `lipo` when `KELPIE_TARGET` says so), and
`scripts/release/latest_json.py` writes the manifest (`darwin-aarch64` and `darwin-x86_64` both point
at the universal bundle) into a **draft** release; apps see it once the draft is published.

## Worktrees

A git worktree is a project with `parentId` (its repository) and `branch`; it has its own
tabs, layouts and sessions and switches like any project. Removal checks for changes and
commits only the worktree holds, leaves the worktree, stops sessions in its folder and waits
for their processes (Windows cannot delete a folder in use), stops watching the folder (an
unwatch that arrives while the watcher is still being created cancels it), then runs `git
worktree remove` — never deleting the branch; a deleted folder that something still holds open
lingers until the handle closes, so the leftover check waits up to 3 s. `.kelpie.yaml` (setup commands, default tabs) is read from the base
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
  per canonical folder path; `meta.updated` is broadcast. `kelpied worktree get|set` defaults to
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
- **CLI** (`cli.rs`): `kelpied terminal list|read|send|wait` and `kelpied worktree get|set` over
  the same RPCs.

## Features beyond sessions

| Area | Where | How |
|---|---|---|
| Layouts | `app/src/lib/layout.ts` | A tab is a tree of n-ary splits (`children`, `sizes`) with pane leaves; grids are built from `{mode: rows\|cols, counts}`; saved layouts are templates (tree shape + session kind per leaf). Version-2 binary trees migrate on load. |
| Accounts | `app/src-tauri/src/accounts.rs`, `lib/accounts.ts` | One config home per account under `<data>/accounts/<agent>/<id>`, passed as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to every launch (terminal, chat, automations, runs, one-shot AI actions); history and usage read each home. |
| Orchestration | `crates/kelpied/src/runs.rs` | A run is a task DAG (cycle-checked) persisted in `runs.json`. `Runs::step` starts ready tasks (deps done, approval given) as ordinary sessions, optionally in a new worktree; tasks end on `kelpied run report`, session exit, or idle after working (default 300 s). |
| Integrations | `app/src-tauri/src/integrations.rs` | Linear GraphQL, Jira REST (Cloud v3 `search/jql`, Server v2), GitLab REST v4. Tokens live in the OS keyring (`keyring`, service `Kelpie (<endpoint>)`) and never reach the webview. |
| Browser panes | `app/src-tauri/src/browser.rs`, `browser_picker.js` | Tauri child webviews positioned over the pane (hidden while an overlay covers them). Design mode injects a picker; picks travel through a cancelled navigation to a sentinel URL, are redacted and size-capped, and the element screenshot uses the WebView2 DevTools protocol (end-to-end tests also send trusted page input through it, `browser_test_input`, dev / e2e builds only). |
| Remote (SSH) | `app/src-tauri/src/remote.rs`, `agents.rs` `build_remote_launch` | The system OpenSSH client (on Windows `System32\OpenSSH`, never a Git Bash one from PATH): sessions run `ssh -t host` with a login shell, inside `tmux new-session -A` when available; files, search and git run as remote commands with quoted arguments. Commands never prompt: secrets come from askpass, anything else fails. |
| SSH hosts | `app/src-tauri/src/ssh_hosts.rs`, `crates/kelpied/src/askpass.rs`, `app/src/components/hosts-page.tsx` | Saved hosts and forward rules in `<data>/ssh/hosts.json`, rendered into `<data>/ssh/config` (one `Host` per saved host, then `Match all` + `Include` of the user's config) that every Kelpie `ssh` / `scp` reads with `-F`. Passwords and key passphrases live in the OS keyring (service `Kelpie (<endpoint>)`); ssh gets them through `SSH_ASKPASS=kelpied` + `SSH_ASKPASS_REQUIRE=force` + `KELPIE_ASKPASS=<host id>` — `kelpied` answers password / passphrase prompts and declines host-key questions, which the page settles with `ssh-keyscan` fingerprints first. Connecting to a host opens a remote project on it. Port forwards are `ssh -N` children of the app (stopped with it; auto-start rules restart on launch); transfers are `scp -r -p` (SFTP). Keys, agent and known hosts go through `ssh-keygen` / `ssh-add` and the known_hosts file. `KELPIE_SSH_DIR` replaces `~/.ssh` for the tests. |
| Phone server | `crates/kelpied/src/mobile.rs`, `crates/kelpied/mobile/` | axum on a chosen address (default port 4817), optional rustls (ring). Pairing: a one-time code shown as a QR (2 min) and approved in the app; device tokens are stored as SHA-256 and compared in constant time; Origin checks, CSP, rate limits; revoking closes the device's sockets. |
| Plugins | `app/src-tauri/src/plugins.rs`, `lib/plugins.ts` | Declarative manifests (see [plugins.md](plugins.md)); approval bound to the manifest SHA-256; agents are sent to the daemon (`agent.set_custom`, kept in `custom-agents.json`). |
| Voice | `crates/kelpie-stt`, `app/src-tauri/src/voice.rs`, `lib/voice.ts` | A separate helper process: sherpa-onnx (static, offline) with a Vietnamese zipformer or Whisper; `cpal` microphone capture mixed to mono; JSON lines over stdin/stdout; models downloaded on request and verified by pinned SHA-256. Kept out of the app and daemon so the native engine can never take them down. |
| Language | `app/src/lib/i18n.ts`, `app/src/locales/vi/*.json` | `t("English text")` looks the text up in the Vietnamese dictionaries (English is the key and the fallback); reactive on the language setting; dates through `Intl`. `pnpm i18n:check` reports missing translations. |

## Measured (Windows 10, see `plans/reports/`)

- 20 sessions × 2 MiB output: 40 MiB in 3.9 s through the daemon, 0 sequence gaps.
- Attach (snapshot) p50/p95: 4.4 / 5.8 ms.
- Project switch (3 projects with terminals): release p50 ≈ 30 ms, p95 40–52 ms; dev build p95 35–105 ms.
- Session history, 421 transcripts / 1.2 GB (release build): first scan 0.5 s, later launches
  (disk cache) 34 ms; the first full prompt count runs in the background (~15–30 s).
