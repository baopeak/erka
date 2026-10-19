# Phase 4 — Chat GUI mode (CLI ↔ chat)

## Context
Giống Claude Code VS Code extension: conversation hiển thị dạng tin nhắn, tool call card, diff, duyệt quyền; chuyển qua lại với TUI mà giữ nguyên conversation.

## Thiết kế
- Daemon `chat` host = relay JSON-line trung lập (không hiểu giao thức). Adapter theo agent viết bằng TS ở UI → chuẩn hoá về model chung:
  `ChatItem = user | assistant(text, streaming) | thinking | tool(name, input, status, output) | permission(request) | system/result(cost, tokens)`.
- Claude adapter: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio --resume <id>`; prompt = `{"type":"user","message":{"role":"user","content":[...]}}`; interrupt = `control_request{subtype:"interrupt"}`; quyền = trả `control_response` cho `can_use_tool` (allow/deny, allow-always theo session); lịch sử = parse `~/.claude/projects/<escaped>/<id>.jsonl` phòng thủ.
- Codex adapter: `codex app-server` → `initialize`, `initialized`, `thread/resume {threadId}` (hoặc `thread/start {cwd}`) → `turn/start`, `turn/interrupt`; render `item/started|completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`; trả lời `*/requestApproval` (accept/acceptForSession/decline).
- OMP adapter: ACP `omp acp` → `initialize`, `session/load|session/new`, `session/prompt`, `session/update`, `session/request_permission`, `session/cancel`.
- Chuyển CLI → chat:
  1. Lấy agent session id: hook SessionStart (Claude), notify/rollout (Codex: `thread-id`), OMP: file session mới nhất theo cwd.
  2. Nếu đang working/waiting → hỏi xác nhận (sẽ ngắt turn).
  3. Dừng TUI êm (Claude: gửi `/exit`; Codex: Ctrl+C ×2; OMP: Ctrl+C ×2; timeout 3 s → kill tree).
  4. Spawn chat host với resume id; render history; pane đổi kind sang chat (cùng vị trí layout).
- Chuyển chat → CLI: interrupt nếu đang chạy, đóng stdin, chờ exit, spawn PTY `claude --resume <id>` / `codex resume <id>` / `omp --resume <id>` cùng cwd.
- Bắt đầu chat mới trực tiếp (không qua CLI) cho 3 agent.
- UI: danh sách message ảo hoá đơn giản, markdown + code highlight, tool card thu gọn được, diff cho Edit/Write/apply_patch, permission card (Allow / Allow for session / Deny), composer (Enter gửi, Shift+Enter xuống dòng, Esc interrupt), hiển thị model/cost/tokens.

## Files
- `crates/erkad/src/chat.rs` (đã có từ phase 1)
- `app/src/chat/{chat-model.ts,claude-adapter.ts,codex-adapter.ts,acp-adapter.ts,history-loader.ts}`
- `app/src/components/{chat-pane.tsx,chat-message.tsx,chat-tool-card.tsx,chat-composer.tsx}`
- `app/src-tauri/src/agent_history.rs` (đọc transcript Claude/Codex/OMP)

## Validation
Chạy thật: tạo session Claude TUI → gõ prompt → chuyển chat → hỏi tiếp → quay lại TUI thấy đủ lịch sử. Lặp với Codex, OMP.

## Risks
Giao thức nội bộ thay đổi theo version CLI → adapter phòng thủ, bỏ qua field lạ; ghi version CLI vào log.
