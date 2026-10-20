# Phase 1 — Quick wins

## Requirements

1. **Chân gợi ý phím** cho mọi palette/overlay: `Enter Mở · Esc Đóng · ↑↓ Chọn` (+ `Tab Lọc` khi có). Component dùng chung `KeyHints`.
2. **Toast khi chặn phím của terminal**: khi một chord của app khớp lúc terminal đang focus, hiện toast 1 lần/phím/phiên: "Đã dùng Ctrl+Shift+O cho *Go to File* — Mở phím tắt". Cài đặt tắt được.
3. **Explorer**: header (tên project, Collapse all, Refresh), ô *Lọc file* lọc cây theo tên (dùng index quick-open sẵn có), tab *Tên/Nội dung* (Nội dung = search panel hiện tại); làm mờ đường dẫn bị gitignore (thêm `ignored` từ `git status --ignored=matching` hoặc crate `ignore`).
4. **Env sạch cho session**: daemon xoá `ELECTRON_RUN_AS_NODE` và `VSCODE_*` (IPC hook, PID, NLS…) khi khởi động — nếu không, `code .`/app Electron chạy trong terminal Erka sẽ hỏng khi Erka được mở từ VS Code. (Phát hiện khi mở Orca.)
5. **Per-pane toolbar** khi hover: split phải/xuống, phóng to (zoom pane), đóng — như Orca.
6. **Overlay chặn phím xuống terminal**: khi overlay mở, terminal không nhận phím (Orca bị lỗi này).

## Files

- `app/src/components/{key-hints.tsx,palette.tsx,file-tree.tsx,right-panel.tsx,pane-view.tsx}`
- `app/src/lib/{commands.ts,terminal-host.ts}`, `app/src-tauri/src/fs_ops.rs` (cờ ignored)
- `crates/erkad/src/main.rs` (`PARENT_AGENT_ENV`)

## Validation

Unit test env scrub; e2e: mở palette thấy hints; gõ Ctrl+Shift+O trong terminal → toast; lọc explorer "session" → còn `session.rs`.
