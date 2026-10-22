# Phase 11 — i18n (English + Vietnamese): working brief

Core is in place: `app/src/lib/i18n.ts` (`t`, `msg`, `formatDate`, `formatDateTime`, `formatTime`,
`formatRelative`, `formatDuration`, `formatNumber`, `locale`), dictionaries `app/src/locales/vi/*.json`
(merged at load), setting `settings.language` (system / en / vi), checker `app/scripts/i18n-check.mjs`.

## Rules

1. Every user-visible English string goes through `t("English text")`: JSX text, `title=`,
   `placeholder=`, `aria-label=`, option labels, `confirm()`/`alert()`, `store.notify(...)`,
   toasts, empty states, error prefixes shown to the user, status words shown to the user.
2. First argument is a **plain string literal** (double quotes). Dynamic parts use placeholders:
   `t("Delete {name}?", { name })`. Never template literals, never concatenated keys.
3. Plurals: separate keys — `n === 1 ? t("{n} session", { n }) : t("{n} sessions", { n })`.
4. Text in tables built at module load (command labels, catalog rows, option arrays outside
   components): wrap with `msg("…")`, and translate where shown with `t(x.label)`. Inside
   components, plain `t()` is fine (Solid re-runs it when the language changes) — but do NOT
   call `t()` at module top level (it would freeze the language).
5. Do NOT translate: text typed into terminals or sent to agents (prompts, commands), ids, CSS
   classes, `data-*` values, chord strings, file paths, URLs, log/console text, brand and product
   names (Claude Code, Codex, OMP, GitHub, GitLab, Linear, Jira, VS Code, Erka, erkad), agent CLI
   labels that are names. Mark a deliberate English-only line with a trailing `// i18n-ignore`
   only when the checker would flag it.
6. Dates/times: replace `toLocaleString(undefined | [] , …)` and hand-made "ago" text with the
   `format*` helpers from `lib/i18n.ts`.
7. Add every key you use to **your own** dictionary file (`app/src/locales/vi/<area>.json`, a flat
   JSON object `"English": "Tiếng Việt"`). Placeholders must match exactly. Keep JSON valid UTF-8,
   2-space indent. Keys that already exist in another fragment may be repeated with the same
   translation.
8. Behaviour must not change: same handlers, same `data-*` attributes, same classes.

## Glossary (use consistently; natural Vietnamese for developers, common English terms kept)

| English | Tiếng Việt |
|---|---|
| project | dự án |
| session | phiên |
| terminal | terminal |
| agent | agent |
| settings | Cài đặt |
| pane | khung |
| tab | tab |
| layout | bố cục |
| split right / down | chia sang phải / chia xuống dưới |
| close / cancel / save / delete / remove | đóng / hủy / lưu / xóa / gỡ |
| open / search / filter | mở / tìm kiếm / lọc |
| files / changes | tệp / thay đổi |
| branch / commit / push / pull / stash | nhánh / commit / push / pull / stash |
| worktree / pull request / merge request / issue | worktree / pull request / merge request / issue |
| plugin / account / sign in / sign out | plugin / tài khoản / đăng nhập / đăng xuất |
| shortcut / notification / theme | phím tắt / thông báo / giao diện (chủ đề màu: theme) |
| download / upload | tải xuống / tải lên |
| dictate / microphone | đọc chính tả / micrô |
| resume / restart / stop | tiếp tục / khởi động lại / dừng |
| run (orchestration) / task / approve | lượt chạy / tác vụ / duyệt |
| working / idle / waiting (needs you) / exited | đang làm / rảnh / cần bạn / đã thoát |
| remote / host | từ xa / máy chủ |
| quick command / automation | lệnh nhanh / tự động hóa |
| enable / disable / enabled | bật / tắt / đã bật |
| loading… / no results | đang tải… / không có kết quả |

## Ownership

| Agent | Files | Dictionary |
|---|---|---|
| A — app shell | components/app, sidebar, palette, workspace-view, welcome, new-session-menu, layout-menu, status-bar, pane-view, split-view, terminal-pane, usage-meter, inbox, dashboard, floating-terminal, context-menu, key-hints, tips, quick-commands, right-panel, explorer, voice, board (.tsx) | vi/shell.json |
| B — tool panels | components/git-panel, diff-view, file-viewer, file-tree, rich-viewers, history-panel, issues-panel, browser-pane, runs-page, chat-pane, search-panel, worktree-dialog, remote-dialog (.tsx); chat/*.ts | vi/tools.json |
| C — settings | components/settings/*.tsx; lib/settings-catalog.ts | vi/settings.json |
| D — lib | lib/store, commands, quick-commands, plugins, voice, accounts, agents, browser, integrations, pull-requests, remote, runs, worktrees, send-to-agent, terminal-host, terminal-themes, git-state, theme, codemirror (.ts); main.tsx | vi/lib.json |

Cross-file contracts: D wraps command labels (`lib/commands.ts`) and agent kind labels
("Terminal", "Command") with `msg()`, and `kindInfo()` returns the translated label; A renders
command labels in the palette with `t(c.label)`; C renders them in Shortcuts the same way and
translates catalog labels/descriptions where `SettingRow` shows them (search matches both the
English and the Vietnamese text).

## Done when

- `node scripts/i18n-check.mjs <your files>` (from `app/`) reports 0 missing, 0 problems, and
  every remaining "untranslated-looking" line is a false positive or carries `// i18n-ignore`.
- `pnpm -s typecheck` passes.
