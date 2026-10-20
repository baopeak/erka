# Phase 4 — Trang Settings đầy đủ, chỉnh phím tắt, điều hướng

## Requirements

- **Settings thành trang riêng** (thay modal): menu trái theo nhóm — Agents (tham số, môi trường, chế độ quyền), Terminal (font, cỡ, line height, cursor, scrollback, renderer, shell mặc định), Appearance (theme, mật độ compact/comfortable, cỡ chữ UI), Notifications, Shortcuts, Daemon (thư mục dữ liệu, dừng daemon, xem log), About.
- **Tìm trong settings** (`Ctrl+F`), mỗi mục có mô tả một dòng.
- **Shortcuts editor**: bảng lệnh + phím hiện tại, ghi phím mới, cảnh báo trùng/đụng phím TUI hay dùng (Ctrl+C/J/K/P/R…), lưu override vào `app-state.json`; `commands.ts` đọc override.
- **Back/Forward** (Alt+←/→, nút góc trái): lịch sử focus (project, tab, pane) giới hạn 50 mục.
- **Gợi ý lần đầu** (không quá 1 popover mỗi lần): giới thiệu dashboard, chat view, phím tìm kiếm; tắt vĩnh viễn được.

## Files

- `app/src/components/settings/*.tsx` (tách theo nhóm), `app/src/lib/{commands.ts,store.ts,nav-history.ts}`

## Validation

Đổi phím `Go to file` sang Ctrl+Alt+P → hoạt động sau khi khởi động lại; tìm "font" trong settings ra mục Terminal; Back/Forward quay lại pane trước qua 2 project.
