# Phase 3 — File tree, viewer/editor, quick open, search, git

## Requirements
- File tree (panel phải, Mod+Shift+E): lazy `fs_list_dir` khi expand; virtualized (chỉ render dòng trong viewport); dirs trước, natural sort; ẩn `.git`; mờ file gitignored; màu git status (M/A/U/D); context menu: new file/folder, rename, delete (vào thùng rác nếu có, xác nhận), copy path/relative path, reveal in OS, open in terminal; drag vào terminal = chèn path.
- Watcher: `notify` recursive cho project đang mở (chỉ project active + LRU 1), bỏ qua `.git/objects`, `node_modules`, `target`, `dist`, `build`, `.next`, `.venv`, `__pycache__`; debounce 150 ms; emit dirs thay đổi → tree reload dir đó.
- Viewer/editor (CodeMirror 6): highlight lazy theo extension, line numbers, find/replace, Mod+S save, ghi có precondition (mtime+size khớp lúc mở, lệch → hỏi), file > 5 MB mở read-only, > 50 MB từ chối/mở phần đầu; binary → hex/thông báo; image viewer (png/jpg/gif/svg/webp, zoom); markdown preview (toggle raw/preview).
- Quick open (Mod+P): index bằng crate `ignore` (tôn trọng .gitignore, song song), cache per project, refresh khi watcher báo; fuzzy (nucleo-matcher phía Rust), top 50, ưu tiên filename + recent.
- Search in files (Mod+Shift+F): Rust `grep-searcher`/`ignore` + regex, stream kết quả, giới hạn 2000 match, click mở file tại dòng.
- Git panel (Mod+Shift+G): `git status --porcelain=v2 -z` (debounce 300 ms theo watcher, cap 2 git process đồng thời), branch/ahead/behind; diff file (HEAD vs working) bằng `@codemirror/merge`; stage/unstage/discard (xác nhận), commit message + commit; worktree list/create/remove cho project.

## Files
- `app/src-tauri/src/{fs_ops.rs,watcher.rs,file_index.rs,search.rs,git.rs}`
- `app/src/components/{file-tree.tsx,file-viewer.tsx,markdown-view.tsx,image-view.tsx,quick-open.tsx,search-panel.tsx,git-panel.tsx,diff-view.tsx,right-panel.tsx}`
- `app/src/lib/{cm-languages.ts,fuzzy-highlight.ts}`

## Validation
Unit test Rust cho natural sort, path guard (không thoát khỏi project root), parser porcelain v2; mở repo Orca (38k file) đo index + quick open; mở file 10 MB.

## Risks
Watcher Windows tốn tài nguyên với repo lớn → chỉ watch project active; FSEvents exclusion → lọc phía app.
