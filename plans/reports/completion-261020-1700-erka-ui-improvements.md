# Completion — Erka UI improvements (plan 261020-0823)

Date: 2026-10-20 · Plan: [plan.md](../261020-0823-erka-ui-improvements/plan.md) · Branch: master

## Delivered

| Phase | Commits | e2e | Review |
|---|---|---|---|
| 1 Quick wins (key hints, intercepted-key notes, explorer filter, pane tools, editor-host env scrub) | af95b0a | phase1 10/10 | 11 findings fixed (in af95b0a) |
| 2 Rich sidebar + unified search | 6571162, fe5c67c | phase2 13/13 | 3 High / 5 Med / 4 Low fixed in fe5c67c |
| 3 Session history, usage/RAM meters, quick commands | b61718f, fixes in 1611a35 | phase3 18/18 | 2 High / 5 Med / 13 Low fixed |
| 4 Settings page, shortcut editor, back/forward, theme/density/scale, tips | 1611a35, f16fd55 | phase4 22/22 | 2 High / 7 Med / 7 Low fixed |
| 5 Worktrees + workspace board + `.erka.yaml` + state migration | 3562575, + review fixes (this commit) | phase5 23/23 | 2 High / 10 Med / 6 Low fixed |

Each phase: implement → e2e with screenshots (scratchpad `shots/p<N>-*.png`) → independent code review → fixes → re-run.

## Notable fixes found by review / measurement

- Memory meter could loop forever on Windows PID reuse (visited set + start-time parent check).
- Quick prompts to Codex never submitted (Enter inside its 120 ms paste window): delivered as a real paste, Enter after 250 ms.
- `.erka.yaml` from a PR branch could run unseen: now read from the base commit, shown in full, opt-in, approval remembered by content hash.
- Removing a detached-HEAD worktree could drop commits: refused when HEAD holds commits no branch/tag/remote has.
- Worktree removal on Windows: dirty check before stopping anything; waits for processes to exit; prunes after a partial delete.
- State file: only "not found" means fresh; unreadable / unknown / newer formats are copied (`app-state.<label>-<time>.bak.json`) or saving is disabled.
- Project switch stalls up to 4.7 s: synchronous Tauri commands (file watcher create/drop, file read/write, state save, transcripts) ran on the main thread → all moved to the blocking pool.
- History scan of 1.2 GB transcripts took 16.6 s cold: head-only parse, libzstd, on-disk cache → 0.5 s first launch, 34 ms after; prompt counts in the background.

## Measurements (Windows 10, debug build + Vite dev server unless noted)

- History list, 421 transcripts / 1.2 GB (release): first scan 506 ms, warm 28–61 ms, later launches 34 ms.
- Project switch: p50 ≈ 35 ms in-page, 55–60 ms via WebDriver. p95 varies 45–305 ms between runs; an A/B with the right panel open vs closed shows the same spread (worst p95 271 ms came from a panel-closed run), so the outliers are long tasks from the dev environment, not from the switch path. Release-build p95 not re-measured.
- Smoke suite 14/14 (after making its keyboard check independent of prompt wrapping).

## Docs

- `docs/user-guide.md`: sidebar, search everything, past conversations, usage/memory, quick commands, worktrees + board + `.erka.yaml`, settings, shortcuts.
- `docs/architecture.md`: state versioning/backups, `set_unread`, API level, app-side services, worktrees, history measurements.

## Follow-up (2026-10-20 evening)

All previously open items resolved; every e2e suite green on the dev environment (smoke 15,
restart 3, phase1 10, phase2 13, phase3 18, phase4 22, phase5 23, chat 8 incl. real Claude /
Codex / OMP turns).

- Project switch: long frames traced (Long Animation Frames API) to WebGL context re-creation
  and to detaching live canvases. Hidden terminals now keep recent WebGL contexts and stay in the
  document → p50 ≈ 25 ms, p95 35–105 ms (was p50 60, p95 270–370). Status bar no longer runs a
  second full `git status` per switch.
- Daemon answers terminal colour queries with the light palette in light mode (`daemon.set_theme`).
- Usage requests identify as `erka/<version>` (verified: both endpoints answer); last good values
  survive failed refreshes.
- UI review from a 41-shot tour (`scripts/e2e/ui_tour.py`, dark / light / compact 120 % / 1100×700):
  segmented controls padded, settings column centred, long values wrap, wide rows fixed, collapsed
  sidebar footer stacked, tabs share width and keep the active one in view, panel toggles hide
  in a narrow centre column, toggles use the UI font, "Claude · claude" → "Claude", search no
  longer matches letters scattered across words, Switch-to-Project-N only for existing projects,
  terminal find colours per theme, no dark flash when starting in light mode.
- Release build (after dev testing passed): smoke 15/15 three times, project switch p50 29–33 ms, p95 40–52 ms.
