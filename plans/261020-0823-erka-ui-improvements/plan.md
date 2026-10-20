# Plan: cải thiện giao diện Erka sau khi so sánh với Orca

Status: proposed · Created: 2026-10-20
Phân tích: [ui-compare report](../reports/ui-compare-261020-0823-orca-vs-erka.md) · Ảnh: [assets/](assets/) (gitignored)

## Outcome

Erka giữ lợi thế hiệu năng/terminal nhưng đạt mức "biết mọi agent đang làm gì, ở đâu, tốn bao nhiêu" ngang Orca: sidebar giàu ngữ cảnh, một ô tìm kiếm cho mọi thứ, lịch sử session, usage meters, quick commands, settings đầy đủ, gợi ý phím.

## Constraints

- Không làm chậm đường nóng: thêm UI không được tăng thời gian chuyển project (p95 hiện 65 ms; ngân sách ≤ 100 ms) hay RAM nền (≤ +50 MB).
- Sidebar/status bar cập nhật theo sự kiện đã coalesce 250 ms của daemon — không polling mới trên UI thread.
- Không đọc credential agent nếu người dùng chưa bật (xem câu hỏi mở).

## Non-goals

Mobile, remote/SSH, browser nhúng, GitHub/Linear/Jira, orchestration, plugins.

## Phases

| # | Phase | Ưu tiên | Ước lượng | Status |
|---|---|---|---|---|
| 1 | [Quick wins: gợi ý phím, toast phím bị chặn, explorer filter, sửa env Electron](phase-01-quick-wins.md) | P0 | 1 ngày | todo |
| 2 | [Sidebar giàu ngữ cảnh + ô tìm kiếm hợp nhất](phase-02-sidebar-unified-search.md) | P0 | 2 ngày | todo |
| 3 | [Lịch sử session, usage meters, quick commands](phase-03-history-usage-commands.md) | P1 | 3 ngày | todo |
| 4 | [Trang Settings đầy đủ + chỉnh phím tắt + điều hướng](phase-04-settings-navigation.md) | P1 | 2 ngày | todo |
| 5 | [Worktree + workspace board](phase-05-worktrees-board.md) | P2 | 3 ngày | todo (chờ quyết định) |

## Acceptance (tổng)

1. Từ sidebar thấy agent của **mọi** project: trạng thái, tiêu đề task, tuổi, model.
2. Một phím (`Ctrl+Shift+P` / `⌘K`) tìm được: lệnh, file, session, project, setting.
3. Mọi palette có chân gợi ý phím; phím bị app chặn trong terminal báo bằng toast (tắt được).
4. Có lịch sử session Claude/Codex/OMP theo Workspace/Project/All, resume vào terminal hoặc chat.
5. Status bar hiện RAM app+daemon và usage agent (khi bật).
6. Smoke e2e vẫn xanh; chuyển project p95 ≤ 100 ms.

## Unresolved

- Usage: đọc OAuth credential (đầy đủ như Orca) hay chỉ dùng số liệu agent tự báo?
- Có áp dụng mô hình worktree (phase 5) không?
