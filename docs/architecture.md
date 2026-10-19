# Erka architecture

Erka is a desktop workbench for running many coding-agent CLIs (Claude Code, Codex, OMP,
shells) across many projects at once. Performance comes from one rule: **the UI owns
nothing that must keep running**. Every PTY and agent process lives in a background daemon,
and the UI renders only what is on screen.

## Processes

```
Erka (Tauri app)                          erkad (session daemon, one per user)
├─ WebView: SolidJS UI, xterm.js, CM6     ├─ Session × N  (PTY + VT state + ring buffer)
├─ Rust core: daemon client, fs, git,     ├─ ChatSession × N (agent stdio JSON relay)
│  search, file watcher                   ├─ status ticker (250 ms) + persistence (30 s)
└─ local socket ◄──────────────────────►  └─ local socket server
                                          erkad hook  ◄── agent hooks (Claude/Codex)
```

| Process | Lifetime | Owns |
|---|---|---|
| `Erka` | while the window is open | layout, settings (`app-state.json`), views |
| `erkad` | until stopped explicitly (or logoff) | PTYs, agent processes, terminal state, `sessions.json`, snapshots |
| agent CLIs | per session | — |

Closing or crashing the app never stops a session. If `erkad` itself stops, sessions are
restored as *exited* with their last screen and can be restarted (agents resume their
conversation with `--resume` / `resume <id>`).

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

RPC methods: `daemon.info|shutdown`, `session.list|create|attach|detach|input|resize|focus|kill|close|restart|update|read`, `chat.close_stdin`, `hook.report`.
Events: `session.updated` (coalesced, 250 ms), `session.closed`, `session.resync`, `session.clipboard`.

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
interactive view is attached; an attached xterm answers itself.

Windows: each session runs in its own Job Object (kill-on-close, owned by the daemon) so a
kill reaches the whole process tree; a modern `conpty.dll`/`OpenConsole.exe` is sideloaded
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

- Only the active project's active tab is mounted. Hidden terminals are *parked*: WebGL
  renderer disposed (browsers cap live WebGL contexts), daemon subscription dropped, xterm
  buffer kept. Re-showing is a delta replay of what was missed. At most 16 parked views are
  kept; older ones are rebuilt from a snapshot.
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

## Measured (Windows 10, see `plans/reports/`)

- 20 sessions × 2 MiB output: 40 MiB in 3.9 s through the daemon, 0 sequence gaps.
- Attach (snapshot) p50/p95: 4.4 / 5.8 ms.
- Project switch (3 projects, rendered): p50 ≈ 55 ms, p95 ≈ 76 ms.
