# Plan: Erka — IDE đa project, đa agent CLI, hiệu năng là ưu tiên số 1

Status: implemented (Windows verified; macOS via CI) · Created: 2026-10-20 · Nền tảng: Windows 10+ và macOS 12+
Phân tích nguồn: [orca-analysis report](../reports/orca-analysis-261020-0132-features-architecture.md)

## Outcome

Một app desktop (tên mã **Erka**) thay Orca cho workflow 10–20 agent CLI (Claude Code, Codex, OMP, shell) trên nhiều project (2–5 CLI/project):
- Mọi CLI chạy trong daemon `erkad`; đóng/crash UI hay đổi project không dừng CLI nào.
- Chỉ project đang mở được render; terminal hiển thị TUI chuẩn (true color, alt-screen, unicode, mouse, bracketed paste) và đẹp kiểu Termius.
- File tree + file viewer/editor + quick open + git status/diff.
- Sau phần CLI: chuyển một session CLI sang giao diện chat (như Claude Code extension) và ngược lại.

## Constraints

- Cross-platform: Windows (ConPTY) + macOS (openpty). Dev/test thực tế trên Windows 10 19045.
- Daemon KHÔNG bao giờ ngừng đọc PTY; parse VT tuần tự theo session; queue tới UI có giới hạn byte, tràn → RESYNC.
- Không mở cổng TCP; IPC = named pipe (Windows) / Unix socket (macOS) theo user.
- Không fake/mock trong code sản phẩm; test dùng tiến trình thật (shell, cmd, `claude`, `codex`, `omp` đã cài).

## Non-goals (bản này)

Mobile, remote server/SSH, cloud VM, Linear/Jira/GitLab, browser nhúng/design mode, plugins, orchestration DAG, telemetry, LSP đầy đủ, auto-update có ký số.

## Kiến trúc

```
┌────────────── Erka app (Tauri 2) ──────────────┐        ┌────────── erkad (Rust daemon) ──────────┐
│ WebView (SolidJS)                              │        │ SessionManager ── Session × N          │
│  Sidebar · Tabs · SplitTree · Terminal(xterm)  │        │   PTY (portable-pty) ─ reader thread ──┐│
│  FileTree · Viewer(CM6) · Diff · Chat · Palette│        │   writer thread ◄─ input queue         ││
│        ▲ Channel(raw bytes)   │ invoke          │        │   VT state (alacritty_terminal) ◄──────┘│
│ Rust core: DaemonClient · fs · git · search ·  │◄──────►│   ring buffer 1 MiB + seq · snapshotter │
│            watcher · state.json                │ local  │   status detector (output/title/hooks)  │
└────────────────────────────────────────────────┘ socket │ ChatHost: agent child (stdio JSON lines)│
                                                          │ Persist: sessions.json + <id>.ansi       │
   `erkad hook` (cùng binary) ◄── Claude/Codex hooks ─────►│ Subscribers: bounded byte budget/view  │
                                                          └─────────────────────────────────────────┘
```

Quy tắc luồng:
- 1 reader thread/session (blocking read bắt buộc với ConPTY) → lock state của riêng session → `vte` advance → append ring → fan-out `try_send` tới subscriber; KHÔNG block.
- 1 writer thread/session (tránh deadlock ConPTY read/write cùng thread).
- tokio runtime cho socket, control RPC, chat host, ticker trạng thái (500 ms).
- App: 1 task đọc socket daemon → route frame output tới `Channel` của đúng terminal; gom 4 ms/session trước khi gửi webview.
- WebView: xterm chỉ tồn tại cho project đang mở + LRU 1 project trước đó; WebGL addon chỉ gắn khi pane hiển thị.

Giao thức `erkad` (frame `u32 LE len | u8 kind | payload`):
- kind 1 JSON: `{"id":n,"method":"session.create",...}` → `{"id":n,"ok":true,"result":...}`; event `{"event":"session.status",...}`.
- kind 2 Output: `u32 handle | u64 seq | bytes` (daemon → client).
- kind 3 Input: `u32 handle | bytes` (client → daemon).
- Attach: `session.attach {handle, since_seq?}` → trả `{mode:"replay"|"snapshot", seq, data_b64}` rồi các Output frame có `seq` liên tục.

## Phases

| # | Phase | Status | Phụ thuộc |
|---|---|---|---|
| 1 | [Daemon core: PTY, VT, snapshot, protocol, persist, status](phase-01-daemon-core.md) | done | — |
| 2 | [App shell + terminals + project switch + palette/dashboard](phase-02-app-shell-terminals.md) | done | 1 |
| 3 | [File tree, viewer/editor, quick open, search, git](phase-03-files-git-search.md) | done | 2 |
| 4 | [Chat GUI mode: CLI ↔ chat cho Claude/Codex/OMP](phase-04-chat-gui-mode.md) | done (Codex model turn chặn bởi quota tài khoản) | 1,2 |
| 5 | [Hardening, benchmark, packaging, docs](phase-05-hardening-bench-packaging.md) | done (soak test nhiều giờ chưa chạy) | 1–4 |

## Acceptance criteria (tổng)

1. 20 session đồng thời (shell + agent) chạy; burst output từ 20 session không mất byte (kiểm bằng hash), UI vẫn phản hồi.
2. Đổi project 1000 lần không dừng CLI nào; reveal project < 200 ms (đo trong app).
3. Đóng app → mở lại: mọi session còn sống và attach lại đúng màn hình.
4. Claude Code, Codex, OMP, PowerShell, cmd chạy TUI hiển thị đúng; resize đúng; copy/paste, find, link hoạt động.
5. File tree lazy + watcher; mở file text lớn mượt; markdown/image preview; quick open < 50 ms trên repo 50k file sau khi index.
6. Git status/diff hiển thị trong app.
7. Session Claude/Codex/OMP chuyển sang chat GUI, gửi prompt, nhận stream, duyệt quyền, rồi quay lại terminal tiếp tục đúng conversation.
8. `cargo test`, `pnpm build`, `tauri build` (Windows) chạy sạch; code có cấu hình bundle macOS.

## Risks → mitigation

Xem mục 6 trong report. Chính: WKWebView chưa test được tại chỗ (fallback DOM renderer + checklist test Mac), throughput Channel (benchmark sớm), ConPTY edge cases (Job Object, guard resize sau exit), API alacritty (pin 0.26, gói trong `vt.rs`).

## Unresolved

- Cờ chính xác cho permission prompt qua stdio của Claude 2.1.x → xác minh khi làm phase 4.
- Codex TUI có dùng shared app-server không → phase 4 dùng stop+resume, không phụ thuộc.

## Kết quả

Xem [bench + e2e report](../reports/bench-261020-0430-erkad-and-e2e-results.md), [kiến trúc](../../docs/architecture.md), [hướng dẫn](../../docs/user-guide.md).
