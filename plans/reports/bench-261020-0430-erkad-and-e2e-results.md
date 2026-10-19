# Benchmark + e2e results — 2026-10-20 (Windows 10 19045, dev machine)

## Daemon (`erkad bench`, release build, sideloaded ConPTY 1.25)

| Scenario | Result |
|---|---|
| 20 sessions × 2 MiB coloured output (64 KiB writes) | 40.0 MiB in 3.90 s (10.3 MiB/s aggregate), 0 seq gaps, 0 final-seq mismatches, 0 resyncs, 20/20 exited |
| Attach (snapshot) × 300 | p50 4.38 ms, p95 5.81 ms, max 7.70 ms |
| Spawn 20 sessions | 190 ms total |
| 1 session `cmd /c type` 4 MiB | 7.2 s through daemon vs 5.0 s raw portable-pty (ConPTY emits ~70 B reads) |
| 1 session single 4 MiB console write (pwsh) | 3.0 s incl. pwsh start |

Before sideloading ConPTY (inbox Win10 conhost): same 20×2 MiB took 70 s → bottleneck was
ConPTY, not the daemon. Raw portable-pty with inbox ConPTY: 4 MiB in 11.4 s.

## UI end-to-end (WebDriver via tauri-driver + msedgedriver 155)

`scripts/e2e/smoke.py` — 14/14 pass: boot+connect, 3 projects, terminal render, keyboard
input → PTY → render, split, **project switch p50 53–59 ms / p95 60–76 ms** (30 switches,
measured to second animation frame), sessions alive after switches, content restored after
switch, quick open (`session.rs`), CodeMirror viewer, file tree, git panel, dashboard, palette.

`scripts/e2e/restart.py` — 3/3: session survives app exit; reopened app restores layout and
terminal content.

Daemon stop → restart (manual, `scripts/erka-call.py`): session restored as exited with
last screen (marker present), `session.restart` brings it back alive.

`scripts/e2e/chat.py` (real agents):
- Claude Code 2.1.x: 4/4 — TUI turn (hooks report idle + session id) → chat view shows TUI
  history → chat turn streams reply → back to TUI, same conversation (both turns visible).
- OMP 18.12: 2/2 — chat turn via ACP → resumes in TUI with history.
- Codex 0.158: handshake, thread start, turn submission and error rendering verified; the
  model turn itself failed with the account's usage limit (resets 2026-10-25) and the user's
  configured `model = "gpt-6.1-sol"` is not offered to ChatGPT auth (`model/list` returns
  gpt-6-astra default). Not an Erka defect; rerun with `ERKA_E2E_CODEX_MODEL=gpt-6-astra`
  once quota resets.

## Unit tests

`cargo test -p erka-proto -p erkad` — 17 pass (codec, VT snapshot round-trips incl. wide
chars/alt-screen/modes, status heuristics, ring buffer, npm shim parsing, dialect classifier).

## Not verified here

- macOS runtime (no Mac available). Daemon crates `cargo check` cleanly for
  `x86_64-apple-darwin`; the Tauri crate needs the Apple SDK — covered by `.github/workflows/ci.yml`.
- Multi-hour soak (RAM leak slope) and IME/Vietnamese input under WebView2.
