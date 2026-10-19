# Phân tích Orca IDE + nghiên cứu stack cho Erka

Nguồn: `docs/Orca_Native_Design_Canvas.html` (+ .docx cùng nội dung), source `stablyai/orca` @ `69157847` (v1.4.214, MIT, clone tại `D:/Works/orca-ref/orca`), 6 lượt phân tích/nghiên cứu song song (docs Orca, terminal/daemon, native-chat/hooks, workbench UI, tech stack, giao thức chat của agent CLI). Ngày: 2026-10-20.

## 1. Tóm tắt bản thiết kế người dùng (Design Canvas)

- Mục tiêu: workbench 10–30 project, 20–30+ CLI song song, chỉ render terminal của project đang mở; CLI ở nền KHÔNG bao giờ bị dừng.
- Nguyên tắc sống còn: daemon sở hữu PTY + VT state; UI chỉ attach/detach; không để render gây backpressure lên pipe CLI; parse tuần tự theo session; queue có giới hạn + RESYNC.
- Render policy: active = 1–4 terminal live; background = đọc PTY liên tục, update VT state, 0 GPU frame; UI crash = daemon giữ session.
- NFR mục tiêu: switch project p95 < 200 ms, input-to-paint p95 < 50 ms, 20 CLI burst không mất byte, 30 CLI idle không rò CPU/RAM.
- Bản gốc chọn WinUI3 (Windows-only). Người dùng cần macOS + Windows và cho phép tự chọn stack → điều chỉnh (mục 5).

## 2. Kiến trúc Orca (Electron 43 / React 19 / Zustand 5, ~4.8M dòng TS)

Topology:
- Daemon Node riêng/1 user sở hữu node-pty; mỗi session có `@xterm/headless` + serialize làm screen model chuẩn. 2 socket/client: control NDJSON + stream binary `[kind u8][len u32][meta][bytes]`.
- Đường dữ liệu: node-pty → headless xterm (daemon) → batcher 2 ms → socket → main → Electron IPC → xterm.js renderer (parse LẦN 2).
- Backpressure: high/low water 4 MiB/1 MiB mỗi client, PAUSE PTY fd khi nghẽn (failsafe 5 s, watchdog 60 s), session nền chỉ giữ tail + `dataGap`, reveal = snapshot.
- Renderer: giữ xterm mounted cho ~4 worktree gần nhất (cold-park 30 s, hot-retain 5 phút); remount ~170 ms; WebGL hidden cap 6, context-loss retry 3/60 s; một lần đo 1.3 GB heap do pane mounted.
- Restore: checkpoint 5 s, log framed `OCKL` có length prefix (phát hiện đuôi rách), strip query sequence khi replay để terminal không tự trả lời.
- Windows: ConPTY + Job Object kill-on-close, taskkill tree, WSL path; macOS: launchd job, process group.
- Bài học đau: race endpoint socket (23 defect / 7 vòng review), head-of-line blocking 1 FIFO, consumer half-open, sync spawn ở main, selector fanout zustand, watcher (FSEvents bỏ exclusion > 8 path, Windows tạo watcher 500 ms+).

Agent status:
- Hooks (ưu tiên): Claude `settings.json` (SessionStart, UserPromptSubmit, Stop, StopFailure, PreToolUse, PostToolUse, PermissionRequest, PostCompact…), Codex `hooks.json` + poll rollout. Listener loopback + token, endpoint file.
- Fallback: OSC title, OSC 7501 (program status), OSC 133 (shell prompt), heuristic output activity.
- Trạng thái: working / waiting (needs you) / done / blocked / idle.

Native chat (CLI ↔ GUI):
- Claude: Agent SDK = `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --replay-user-messages --permission-prompt-tool stdio`; control_request `interrupt`, `set_model`, `set_permission_mode`, `can_use_tool`.
- Codex: `codex app-server` (stdio JSON-RPC, không có field `jsonrpc`): initialize → thread/start|thread/resume → turn/start, turn/interrupt; notify `item/*`, `turn/completed`; approval là server→client request.
- OMP/Grok/OpenCode: ACP (`omp acp`) — session/new|load|prompt, session/update, session/request_permission. OMP còn có `--mode rpc` (NDJSON).
- Chuyển chế độ = dừng TUI rồi resume cùng session id (không có live-attach chung stdin). Session id: hook SessionStart (`session_id`, `transcript_path`), `claude agents --json`, file transcript `~/.claude/projects/<cwd-escaped>/<id>.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)`, `~/.omp/agent/sessions/`.

Workbench:
- File tree: virtualized (`@tanstack/react-virtual`), lazy readDir khi expand, watcher debounce + giới hạn concurrency, git decoration bằng CSS var, natural sort, context menu, drag path vào terminal.
- Editor: Monaco 1 model/file, autosave, ghi file có precondition chữ ký nội dung; viewer image/PDF/CSV paged/markdown (rich ≤600 KB)/mermaid/ipynb.
- Quick open: ripgrep liệt kê file (2 pass: tôn trọng ignore + ignored), fuzzy multi-term, top-50, ưu tiên filename + recency.
- Layout: per-worktree; tab groups + cây split nhị phân `{leaf}|{split dir first second ratio}`; leaf id ổn định.
- Git: `git status --porcelain=v2` stream có limit, debounce 125 ms theo file event, stage/discard/commit/push an toàn (không force-push ngầm).

## 3. Danh mục tính năng Orca (rút gọn theo mức ưu tiên cho Erka)

MUST (bản đầu): project/repo registry, worktree list/create/delete; sidebar theo project với chấm trạng thái từng agent; daemon sống qua UI restart; scrollback/restore; terminal GPU, tabs, split lồng nhau, find, link, OSC 52, theme, font, login shell, PowerShell/WSL; launcher agent cấu hình được (args/env); status qua hooks + OSC/heuristic; notification khi agent xong; restore layout; Quick Open; jump palette; command palette; keybindings; file explorer live; file viewer/editor; markdown preview; image viewer; git status + diff.
SHOULD: chat GUI (Claude/Codex/OMP), session history + resume, hibernation, usage/rate-limit, annotate diff → gửi agent, GitHub PR qua `gh`, dashboard kanban, quick commands, floating terminal, SSH worktree, CLI `erka terminal read/send/wait`.
LATER: mobile, remote server, cloud VM, computer use, Linear/Jira/GitLab, orchestration DAG, design mode/browser, plugins, i18n, telemetry.

Phím tắt Orca đáng giữ: Mod-T tab mới, Mod-W đóng, Mod-\ split phải, Mod-Shift-\ split xuống, Mod-F find, Mod-P quick open, Mod-J jump, Mod-1..6 nhảy, Mod-, settings, Ctrl+Tab tab gần nhất, F7 change kế.

## 4. Điểm Orca làm tốt cần giữ — và chỗ Erka làm tốt hơn

| Orca | Erka |
|---|---|
| Daemon Node + headless xterm, parse 2 lần | Daemon Rust + `alacritty_terminal` (vte, rất nhanh), parse 1 lần ở daemon; UI chỉ parse cho pane đang hiện |
| Pause PTY khi consumer chậm (có thể làm treo agent) | KHÔNG BAO GIỜ pause: reader thread luôn drain vào VT state; subscriber chậm bị cắt queue → RESYNC snapshot |
| Nhiều lớp timer 2 ms + water marks | 1 queue byte-budget/subscriber, gom chunk theo frame |
| Giữ xterm mounted cho ~4 worktree (tốn heap) | LRU 2 project mounted, WebGL chỉ cho pane hiển thị; reveal = replay delta (≤256 KB) hoặc snapshot |
| Endpoint socket dance phức tạp | Tên pipe/socket cố định theo user + single-instance bằng bind exclusive |
| Hooks qua HTTP loopback + token | Hooks qua chính binary `erkad hook` → local socket (không mở cổng TCP) |
| Electron ~150 MB+/cửa sổ | Tauri (WebView2/WKWebView), backend Rust |

## 5. Quyết định stack Erka (macOS + Windows)

- Daemon `erkad`: Rust, tokio, `portable-pty` 0.9 (ConPTY / openpty), `alacritty_terminal` 0.26 headless, `interprocess` 2.4 local socket (named pipe / UDS), JSON control + binary frame.
- App: Tauri 2.12 (Rust core: client daemon, fs/git/search/watch) + SolidJS (reactivity mịn, tránh fanout re-render) + Vite.
- Terminal: `@xterm/xterm` 6.0 + addon webgl/fit/search/unicode11/web-links; WebGL chỉ cho pane đang hiển thị (giới hạn ~16 context/page).
- Viewer/editor: CodeMirror 6 (nhẹ hơn Monaco, lazy language), `@codemirror/merge` cho diff, marked + DOMPurify cho markdown.
- Persistence: JSON ghi atomic (dữ liệu metadata nhỏ; KISS) + file snapshot ANSI theo session. SQLite chưa cần.
- Loại bỏ: GPUI (pre-1.0, phải tự viết editor/tree/chat), Electron (nặng), WinUI3+AppKit (2 codebase), libghostty (chưa embed tốt trên Windows).

## 6. Rủi ro chính

1. WKWebView (macOS) WebGL/font chưa kiểm được trên máy dev Windows → cần chạy thử trên Mac; có fallback DOM renderer.
2. Throughput Tauri Channel chưa có số công bố → benchmark tuần đầu; batch 4–8 ms, gửi raw bytes.
3. ConPTY: kill tree (Job Object), resize sau exit, DSR/cursor inject.
4. API `alacritty_terminal` thay đổi giữa bản → pin version, gói trong 1 module.
5. Định dạng transcript agent là nội bộ/không ổn định → parse phòng thủ, bỏ qua type lạ.

## Nguồn

- https://github.com/stablyai/orca · https://onorca.dev
- https://github.com/xtermjs/xterm.js/issues/4379 (giới hạn WebGL context)
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts
- https://v2.tauri.app/develop/calling-frontend/ (Channel)
- https://superset.sh/cs/blog/terminal-daemon-deep-dive
- https://code.claude.com/docs/en/headless · https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/vs-code
- https://learn.chatgpt.com/docs/app-server · https://learn.chatgpt.com/docs/hooks
- https://agentclientprotocol.com/protocol/overview · https://omp.sh/docs/rpc · https://github.com/can1357/oh-my-pi
- https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session · https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

## Câu hỏi còn mở

- Giá trị chính xác của cờ cho permission prompt qua stdio (Claude) — kiểm bằng chạy thật.
- Codex TUI thường có dùng shared app-server daemon không (ảnh hưởng live-attach).
- Event hook của OMP (extension TS) — dùng heuristic + ACP trước.
