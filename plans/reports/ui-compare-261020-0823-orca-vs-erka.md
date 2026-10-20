# So sánh giao diện Orca 1.4.x và Erka 0.1.0

Ngày: 2026-10-20. Orca mở trên máy với 8 workspace thật và 1 agent OMP; chụp qua CDP ở 2560×1400.
Erka chụp ở bản release và qua WebDriver (1480×920). Ảnh: [`../261020-0823-erka-ui-improvements/assets/`](../261020-0823-erka-ui-improvements/assets/) (không commit vì chứa tên project và đường dẫn riêng).

## Tóm tắt

Erka thắng về hiệu năng và chất lượng terminal; Orca thắng về **mật độ thông tin quanh agent** và **khả năng khám phá tính năng**. Phần cần học không nằm ở terminal mà ở các lớp UX bao quanh: sidebar giàu ngữ cảnh, ô tìm kiếm hợp nhất, lịch sử session, đồng hồ usage, quick commands, trang settings đầy đủ, gợi ý phím.

| | Orca | Erka |
|---|---|---|
| RAM (app, không tính agent) | ~899 MB, 7 tiến trình (8 workspace, 1 terminal) | ~359 MB (app 23 + WebView2 326 + daemon 10), 1 project, 1 terminal |
| Mở terminal đã có lúc khởi động | trống vài giây rồi mới hiện nội dung (ảnh 01) | snapshot hiện ngay |
| Quick open lần đầu | "Loading files…" | index song song (ignore crate) |
| Chuyển project | không đo | p50 55 ms, p95 65 ms |

## Những gì Orca làm tốt, nên học

1. **Sidebar 3 tầng giàu ngữ cảnh** (ảnh `orca-01-main`): Project → worktree (tên branch, badge `primary`, dòng phụ) → **từng agent** với glyph, tiêu đề task, model/provider (`openai-codex/g…`), tuổi (`7h`), icon trạng thái. Mọi project đều thấy agent của mình, không chỉ project đang mở. Erka chỉ liệt kê session của project active, không có tuổi hay model.
2. **Một ô tìm kiếm cho tất cả** (ảnh `orca-04-search`): "Search chats, terminals, worktrees, settings, and actions…" kèm Filter (Tab), danh sách *Recent worktrees* có tuổi và chip project. Erka tách thành 3 overlay (palette, quick open, jump).
3. **Gợi ý phím ở chân mọi palette**: `Enter Open · Esc Close · ↑↓ Move · Tab Filter`. Erka không có.
4. **Toast khi app chặn một phím của terminal** (ảnh `orca-03`): "Terminal shortcut handled — Go to File (Ctrl+P) — Open Shortcuts". Người dùng biết vì sao phím không tới TUI và cách đổi. Erka chặn im lặng.
5. **Status bar đo lường**: usage Claude (5h / tuần / Fable), usage Codex, RAM của app, số terminal, cổng đang mở, keep-awake. Erka chỉ có trạng thái daemon, branch, số session. Usage là thông tin sống còn khi chạy 10–20 agent (Codex của bạn hôm nay hết quota mà không có cảnh báo).
6. **Agent Session History** ở sidebar phải (ảnh `orca-06`): phạm vi Workspace/Project/All, tìm kiếm, resume. Erka chưa có, dù đã có sẵn bộ đọc transcript cho chế độ chat.
7. **Quick Commands** (nút *Command*, ảnh `orca-12`): lưu lệnh hay dùng, chọn chạy trong Terminal hay gửi cho Agent, có "Append Enter".
8. **Trang Settings đầy đủ** (ảnh `orca-10`): trang riêng, menu nhóm (AI, Set up, Workflows, Interface, Remote), ô tìm settings, mỗi toggle có mô tả. Erka là modal nhỏ.
9. **Explorer có ô lọc và tab Names/Contents** ngay trong panel, header có tên project + Collapse all/Refresh/More. Erka tách search sang tab khác và chưa làm mờ file bị gitignore (`target` hiện như thường).
10. **Workspace board** (ảnh `orca-05`): kanban theo trạng thái công việc (Todo/In progress/In review/Done, ghim). Erka có dashboard theo trạng thái agent — bổ sung cho nhau.
11. **Nút per-pane** (góc phải pane: split, phóng to, đóng) và **Back/Forward** lịch sử điều hướng ở góc trái.
12. **Onboarding gợi ý theo ngữ cảnh** ("Plan work on the board · 1 of 2").

## Những gì Erka đang tốt hơn — giữ

- Terminal có padding, font JetBrains Mono, theme đồng bộ màu với daemon; Orca dày đặc, sát mép.
- Chuyển chat ↔ TUI giữ nguyên hội thoại, có thẻ tool/diff/duyệt quyền.
- Daemon không bao giờ pause PTY, ít RAM hơn ~2.5 lần.

## Điểm yếu của Orca cần tránh

- Board mở bằng toggle nhưng Esc không đóng; overlay đè lên terminal mà terminal vẫn nhận phím (ảnh `orca-03`: Ctrl+J bị terminal nhận).
- Nhiều tầng onboarding/popup cùng lúc (toast + tour + board).
- Không chạy được khi kế thừa `ELECTRON_RUN_AS_NODE` (môi trường VS Code). **Erka có lỗi tương tự tiềm ẩn**: session kế thừa `ELECTRON_RUN_AS_NODE`/`VSCODE_*` nên `code .` hoặc app Electron chạy từ terminal Erka sẽ hỏng khi Erka được mở từ VS Code.

## Ghi chú kỹ thuật

- Orca lấy usage bằng token OAuth của người dùng: Claude `https://api.anthropic.com/api/oauth/usage`, Codex `https://chatgpt.com/backend-api/wham/usage` (`src/main/rate-limits/`). Làm tương tự nghĩa là Erka phải đọc credential của agent — cần người dùng đồng ý.

## Câu hỏi còn mở

- Có muốn Erka đọc credential Claude/Codex để hiện usage (giống Orca), hay chỉ hiện số liệu agent tự in ra (statusline/hook) — kém đầy đủ hơn nhưng không đụng credential?
- Có cần mô hình worktree (mỗi task một git worktree) như Orca, hay giữ "project = thư mục"?
