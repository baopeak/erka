# Phase 1 — Daemon core (`erkad`)

## Context
Thành phần quyết định hiệu năng và độ bền. Mọi PTY, VT state, trạng thái agent, tiến trình chat sống ở đây. UI chỉ là client.

## Requirements
- Session lifecycle: create (cwd, command/argv, env, cols/rows, project_id, kind: shell|claude|codex|omp|custom), list, attach/detach, input, resize, kill (tree), rename, restart (dead session → spawn lại cùng command; agent dùng resume id nếu biết).
- Reader thread/session: read 64 KiB → `Processor::advance(term)` → ring buffer (1 MiB, seq u64 tổng byte) → fan-out.
- Query responses (DA/DSR, `PtyWrite`): daemon tự trả lời khi KHÔNG có view interactive attach; khi có, để xterm trả lời.
- Snapshot ANSI: scrollback (tối đa 2000 dòng) + màn hình, SGR (16/256/truecolor, bold/dim/italic/underline/inverse/strike/hidden), ký tự rộng, zerowidth, wrap; cursor pos + visibility; mode DECSET (app cursor 1, mouse 1000/1002/1003/1006, bracketed paste 2004, focus 1004, alt screen 1049); title.
- Attach: nếu `since_seq` còn trong ring và delta ≤ 256 KiB → `replay` raw; nếu toàn bộ output ≤ 256 KiB → replay từ 0; còn lại → `snapshot`.
- Subscriber budget 2 MiB chưa gửi; vượt → bỏ queue, gửi event `session.resync` → client gọi attach lại.
- Status detector: `running|working|idle|waiting|exited`, `unread` khi chuyển working→idle mà không có view focus; nguồn: hooks (ưu tiên), OSC title (spinner braille/✳ của Claude), BEL/OSC 9/777, activity (output trong 1.5 s, bỏ echo < 250 ms sau input).
- Hook client: `erkad hook <agent> <event>` đọc stdin JSON, env `ERKA_SESSION_ID`, gửi `hook.report` qua socket, thoát ≤ 50 ms; nếu daemon không chạy → thoát 0 im lặng.
- Agent launch: Claude thêm `--settings <json hooks>` (SessionStart/UserPromptSubmit/Stop/Notification/PreToolUse/PermissionRequest) → lấy `session_id`; Codex thêm `-c notify=[erkad,hook,codex,notify]`; OMP: heuristic.
- Persist: `sessions.json` (metadata) ghi atomic khi thay đổi; snapshot `<id>.ansi` mỗi 30 s cho session có output mới + khi daemon tắt êm. Khởi động: session cũ → trạng thái `exited` (restorable) với snapshot cuối.
- Windows: Job Object (KILL_ON_JOB_CLOSE, handle thuộc daemon) cho cây tiến trình; daemon tách khỏi job/console của app (`CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NO_WINDOW`). macOS: kill process group.
- Single instance: bind tên cố định; bind lỗi + connect được → thoát.
- Chat host (dùng ở phase 4): spawn child stdio, relay JSON line hai chiều, log 5000 dòng gần nhất để replay khi attach.

## Files
- `crates/erka-proto/src/lib.rs` — frame codec (async read/write), kinds, message structs, socket name.
- `crates/erkad/src/main.rs` — CLI: `serve` (mặc định), `hook`, `ping`.
- `crates/erkad/src/server.rs` — accept loop, client connection, RPC dispatch.
- `crates/erkad/src/session.rs` — Session, PTY spawn, reader/writer thread, subscribers, ring.
- `crates/erkad/src/vt.rs` — wrapper alacritty Term + event listener + snapshot serializer.
- `crates/erkad/src/status.rs` — detector.
- `crates/erkad/src/agents.rs` — launch profiles (claude/codex/omp), hook args.
- `crates/erkad/src/persist.rs` — sessions.json + snapshots.
- `crates/erkad/src/proc_tree.rs` — Job Object / process group kill.
- `crates/erkad/src/chat.rs` — chat host.
- `crates/erkad/tests/` — integration: spawn shell, echo roundtrip, attach replay/snapshot, resync, kill tree, 20-session burst.

## Steps
1. Proto + codec + unit test codec.
2. vt.rs + snapshot serializer + unit test (feed chuỗi SGR/wide/alt-screen → snapshot → feed snapshot vào Term mới → so sánh grid).
3. session.rs + server.rs; test echo qua socket thật.
4. status/agents/hook; persist; proc_tree; chat host.
5. Integration tests + burst test (20 × 5 MiB, so hash ring/seq).

## Validation
`cargo test -p erka-proto -p erkad`; burst test đạt 0 byte mất; `erkad ping` hoạt động.

## Risks / rollback
alacritty API → gói trong vt.rs. ConPTY passthrough không có trên Win10 → chấp nhận ConPTY re-render. Rollback: crate độc lập, không ảnh hưởng app.
