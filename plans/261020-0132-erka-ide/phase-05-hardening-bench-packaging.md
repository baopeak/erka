# Phase 5 — Hardening, benchmark, packaging, docs

## Requirements
- `erka-bench` (bin trong erkad crate, chế độ `erkad bench`): N session (1/5/10/20) phát burst (pwsh/cmd hoặc `sh -c`), client attach/detach ngẫu nhiên 1000 lần; kiểm tổng byte = seq; đo throughput, p50/p95 attach latency; in bảng.
- Fault: kill app khi đang burst → mở lại attach đủ; kill daemon → app hiện "daemon disconnected", tự respawn, session cũ thành restorable.
- Giới hạn bộ nhớ: scrollback daemon 5000 dòng/session, ring 1 MiB, chat log 5000 dòng; đo RSS daemon với 20 session.
- Packaging: `tauri.conf.json` bundle Windows (nsis/msi) + macOS (dmg/app, `externalBin` erkad); script build daemon trước app.
- Docs: `README.md` (cài đặt, build, chạy, phím tắt), `docs/architecture.md` (kiến trúc + giao thức).

## Validation
Bảng benchmark trong report `plans/reports/bench-*.md`; `pnpm tauri build` ra installer Windows.
