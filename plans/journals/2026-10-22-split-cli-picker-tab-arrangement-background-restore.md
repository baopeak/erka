---
title: "Split CLI picker, tab arrangement, background restore"
date: 2026-10-22
summary: Split asks which CLI to start; tabs/panes rearrangeable; on-screen terminals stop streaming while the window is hidden
---

# Split CLI picker, tab arrangement, background restore

## What happened
- Every split entry point (tab bar, pane header, terminal menu, Ctrl+Shift+D/S, palette) hard-coded `"shell"`, so splits always opened PowerShell. They now call `store.splitPicker`, which inserts an empty pane whose launcher lists agents + Terminal (keys 1–9), "More…" (New Session dialog with "This pane"), Esc to cancel.
- Arranging: tabs drag-reorder in the bar (pointer events; Tauri on Windows blocks HTML5 DnD), a tab dropped on a pane edge merges via new `layout.insertBeside`, a pane header dropped on a tab moves it there (or to a new tab). Palette: Move Tab Left/Right, Move Pane to New Tab.
- Review caught: double click / key repeat started a second session that replaced the first in the same pane (orphaned running agent) — `placePane(into)` now only fills a still-empty pane, found by id across tabs; picker took focus from behind open dialogs. Esc-refocus failed because the `.then` read Solid props after the leaf left the tree (getter throws) — capture ids before closing.
- Slow restore from background: on-screen terminals kept streaming while the window was minimized; Chromium throttles hidden-page timers (down to 1/min), xterm's WriteBuffer parses on timers, so output piled up and was parsed on restore. Views now detach on `visibilitychange` hidden and replay the missed delta on show.

## Decision
- Splits never pick a kind implicitly; explicit-kind flows (New Terminal, hand-off, plugins, browser) stay explicit.
- Hidden-window terminals follow the same rule as parked ones: the daemon owns the stream, the UI catches up by delta/snapshot.

## Verification
typecheck, i18n:check, build pass; e2e split_picker.py 46/46 (new), smoke.py 16/16, phase1.py 10/10; layouts.py 44/44 before the last two fixes.

## Next steps
- User to confirm restore speed after a real minimize with agents running.
- Lone pane (no header) can only move by dragging its tab.
- Plan: plans/261022-1516-split-cli-picker-and-arrange/plan.md

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
