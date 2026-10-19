# Phase 2 — App shell, terminals, chuyển project

## Context
Tauri 2 + SolidJS. Phải nhẹ: không re-render diện rộng khi 20 session đổi trạng thái; chỉ project đang mở có xterm.

## Requirements
- Rust core (`app/src-tauri`): kết nối `erkad` (tự spawn detached nếu chưa chạy, retry 5 s), reader task route Output → `Channel<InvokeResponseBody::Raw>` của view, gom 4 ms; events → `app.emit("daemon-event")`; reconnect khi daemon restart.
- Commands: `daemon_call(method, params)` (JSON passthrough), `term_attach(handle, since_seq, channel)`, `term_detach`, `term_input(handle, data)`, state load/save.
- State app (`state.json` atomic): projects [{id, name, path, color, agents preset}], layout per project (tabs → split tree → pane {kind, session/file}), settings (font, size, theme, shell, scrollback, keybindings override).
- UI:
  - Sidebar: project list (drag reorder, màu, đếm session, badge trạng thái tổng hợp: waiting > working > unread > idle), mở rộng ra session list; Alt/Cmd+1..9.
  - Tabs/project; mỗi tab = split tree (ngang/dọc, kéo ratio); pane = terminal | file | diff | chat.
  - New session menu: Shell / Claude / Codex / OMP / Custom (cấu hình args/env).
  - Terminal: xterm 6 + WebGL (chỉ khi hiển thị, fallback DOM khi context loss) + fit + search + unicode11 + web-links; font JetBrains Mono/Cascadia/Nerd fallback; theme kiểu Termius; copy/paste chuẩn mỗi OS; drag file → paste path; find bar; resize debounce 50 ms; replay chặn auto-response.
  - Project switch: detach view project cũ (giữ LRU 1 project mounted, không subscribe), attach project mới; đo thời gian, log vào status bar dev.
  - Dashboard (Mod+Shift+D): mọi session mọi project, nhóm theo trạng thái (Needs you / Working / Done / Idle), click nhảy.
  - Command palette (Mod+Shift+P), project jump (Mod+K… xem keymap), notifications hệ thống khi agent xong/cần input lúc app không focus hoặc project khác.
  - Settings view (JSON-backed form tối thiểu: font, size, line height, theme, default shell, scrollback).
- Keymap mặc định: Windows/Linux Ctrl+Shift+T/W/D/E/F, Ctrl+P, Ctrl+Shift+P, Alt+1..9, Ctrl+Tab; macOS Cmd tương ứng. Phím trùng terminal (Ctrl+C khi có selection = copy).

## Files
- `app/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- `app/src-tauri/{Cargo.toml,tauri.conf.json,build.rs,capabilities/default.json,src/main.rs,src/daemon_client.rs,src/state.rs}`
- `app/src/main.tsx`, `app/src/app.tsx`, `app/src/styles.css`
- `app/src/lib/{ipc.ts,store.ts,keymap.ts,layout.ts,platform.ts}`
- `app/src/components/{sidebar.tsx,tab-bar.tsx,split-view.tsx,terminal-pane.tsx,dashboard.tsx,command-palette.tsx,new-session-menu.tsx,settings-view.tsx,status-bar.tsx}`

## Steps
1. Scaffold Tauri + Solid; build trống chạy được.
2. DaemonClient + commands; terminal pane end-to-end với shell.
3. Store/layout/projects/persist; sidebar; tabs/split.
4. Project switch + LRU + WebGL policy; dashboard; palette; notifications; settings.

## Validation
`pnpm build`, `cargo build -p erka`; chạy app, mở 3 project × 3 session (pwsh, claude, codex), đổi project, đóng/mở app → session còn; screenshot kiểm tra.

## Risks
Channel throughput (đo với `cat` file lớn); WebGL limit (policy); IME tiếng Việt trên xterm (kiểm thử nhập Telex).
