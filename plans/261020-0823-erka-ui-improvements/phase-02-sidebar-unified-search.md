# Phase 2 — Sidebar giàu ngữ cảnh + ô tìm kiếm hợp nhất

## Requirements

**Sidebar**
- Mọi project hiển thị danh sách session con (thu gọn được từng project; nhớ trạng thái), không chỉ project active.
- Hàng session: chấm trạng thái, glyph agent, tiêu đề task (title OSC / tên chat), **model** (từ hook SessionStart `model`, Codex thread `model`, OMP status line), **tuổi** (`7h`), badge `unread`. Click = reveal; menu chuột phải: Đổi tên, Mark unread, Restart/Resume, Chuyển chat/TUI, Đóng.
- Header Projects: nút thêm, lọc (chỉ project có agent đang chạy / cần bạn), sắp xếp (thủ công / hoạt động gần nhất).
- Dòng phụ dưới tên project: branch hiện tại (từ git status đã cache), dấu `*` nếu dirty.

**Ô tìm kiếm hợp nhất** (`Ctrl+Shift+P` / `⌘K`, nút *Search* đầu sidebar)
- Một input, kết quả nhóm theo: Sessions, Projects, Files (project active), Commands, Settings; rỗng = *Gần đây* (session/project mở gần nhất, có tuổi + chip project).
- Tiền tố: `>` lệnh, `@` session, `#` file, `/` setting; `Tab` đổi bộ lọc. Chân gợi ý phím.
- Giữ các phím cũ (quick open, jump) như lối tắt mở sẵn bộ lọc.

## Data

- Daemon thêm `model` vào `SessionSpec`/`SessionInfo` (cập nhật từ hook/chat) và `last_activity_ms`.
- App lưu `recent` (id + thời điểm) trong `app-state.json`.

## Files

- `crates/erkad/src/{session.rs,daemon.rs,status.rs}`; `app/src/components/{sidebar.tsx,palette.tsx}`; `app/src/lib/{store.ts,types.ts}`

## Validation

e2e: 3 project × 2 session → sidebar hiện 6 hàng có tuổi; gõ `@claude` ra session Claude; chuyển project p95 ≤ 100 ms; status update 20 session không làm render lại toàn sidebar (đếm render bằng Solid dev hook).
