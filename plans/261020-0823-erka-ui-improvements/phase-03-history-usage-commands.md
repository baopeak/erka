# Phase 3 — Lịch sử session, usage meters, quick commands

## 1. Agent Session History (tab *Sessions* ở panel phải)

- Quét transcript: Claude `~/.claude/projects/*/*.jsonl` (đã có reader), Codex qua `codex app-server` `thread/list` (rollout là `.jsonl.zst`), OMP `~/.omp/agent/sessions/*/*.jsonl` (header `session`).
- Phạm vi Workspace (cwd = project) / Project / All; tìm theo tiêu đề + prompt đầu; nhóm theo ngày.
- Mỗi hàng: agent, tiêu đề/prompt đầu, tuổi, số lượt; nút **Resume trong terminal**, **Mở trong chat**, Copy resume command.
- Cache kết quả quét theo mtime file (Rust, thread nền), cập nhật khi mở tab.

## 2. Usage meters (status bar)

- Bảng hiển thị: Claude 5h / tuần, Codex 5h / tuần, % và thời điểm reset; cảnh báo ≥ 80% (màu amber) và ≥ 100% (đỏ, kèm toast một lần).
- Nguồn dữ liệu (cần quyết định):
  - A. Như Orca: gọi `api.anthropic.com/api/oauth/usage` và `chatgpt.com/backend-api/wham/usage` bằng token người dùng — đầy đủ nhất, phải đọc credential, cần opt-in rõ ràng.
  - B. Không đụng credential: lấy từ dữ liệu agent tự phát ra (Codex app-server `account/rateLimits`/thông báo lỗi usage, Claude hook payload) — có thể thiếu.
- **RAM**: tổng working set app + WebView2 + daemon (và tuỳ chọn cây tiến trình agent) — daemon tính bằng `sysinfo`, tick 5 s.

## 3. Quick Commands

- Lưu lệnh (nhãn, nội dung, hành động *Terminal* = gõ vào terminal đang focus / mở tab mới, *Agent* = gửi làm prompt cho session agent đang focus, tuỳ chọn Append Enter), phạm vi Global/Project.
- Chạy từ menu `+` của tab bar, ô tìm kiếm (`>`), và phím số trong menu.

## Files

- `app/src-tauri/src/agent_history.rs` (mở rộng), `app/src/components/{history-panel.tsx,usage-meter.tsx,quick-commands.tsx,status-bar.tsx}`, `crates/erkad/src/daemon.rs` (`daemon.stats`)

## Validation

Quét lịch sử 1000 transcript < 1 s (cache nóng < 100 ms); resume từ lịch sử ra đúng conversation (e2e Claude); quick command chạy đúng terminal.
