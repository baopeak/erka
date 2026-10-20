# Phase 5 — Worktree + workspace board (đã quyết: làm, giữ thư mục thường)

## Context

Orca coi mỗi task là một git worktree (branch riêng, terminal riêng, layout riêng) và có board kanban theo trạng thái công việc. Erka hiện coi project = thư mục. Backend Erka đã có `git_worktrees/add/remove`.

## Requirements (nếu chấp nhận)

- Project có danh sách worktree con trong sidebar (tên branch, badge `primary`, dirty); tạo worktree mới từ base ref với tên branch gợi ý; xoá có xác nhận và không xoá branch chưa merge.
- Session/layout gắn theo worktree (cwd = đường dẫn worktree); chuyển worktree như chuyển project (cùng cơ chế park/attach, cùng ngân sách ≤ 100 ms).
- Workspace board: cột Todo / Đang làm / Review / Xong + ghim; kéo thả đổi trạng thái; thẻ hiện agent đang chạy trong worktree. Bổ sung cho dashboard theo trạng thái agent hiện có.
- `orca.yaml`-style setup script tuỳ chọn (`.erka.yaml`: lệnh setup, tab mặc định).

## Risks

Thay đổi mô hình dữ liệu (project → worktree) ảnh hưởng `app-state.json`: cần migration có backup trước khi ghi.

## Validation

Tạo 3 worktree, chạy agent ở mỗi cái, đổi trạng thái trên board, xoá 1 worktree → session của nó dừng sạch, branch còn nguyên.
