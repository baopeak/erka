# Test report: split CLI picker and tab/pane arrangement

Date: 2026-10-22 · Plan: `plans/261022-1516-split-cli-picker-and-arrange/plan.md` · Branch: master (uncommitted)

## Results overview (final, rerun on rebuilt app)

Rerun after two product fixes (Esc focus capture in `pane-view.tsx`; hidden-window detach/replay in `terminal-host.ts`). App rebuilt from current tree.

| Gate | Result |
|------|--------|
| `pnpm typecheck` | PASS |
| `pnpm i18n:check` | PASS: 1207 keys used, 1256 translated, 0 missing, 0 problems |
| `pnpm build` | PASS. Only `INEFFECTIVE_DYNAMIC_IMPORT` warnings; not verified as pre-existing |
| Node layout invariant check (insertBeside, copy of layout.ts) | 5/5 PASS (first run, before fixes; layout.ts unchanged since) |
| e2e `split_picker.py` (new) | 46/46 PASS (includes Esc focus and hide/show checks) |
| e2e `smoke.py` | 16/16 PASS |
| e2e `phase1.py` (project = repo root) | 10/10 PASS |
| e2e `layouts.py` (no `--ai`) | 44/44 PASS on the build before the fixes; not rerun on the final build |

Totals on final build: 72 e2e checks run, 72 passed, 0 failed. Earlier-build layouts run: 44/44.

Hide/show check (`split_picker.py`, last section): on-screen terminal detaches when `document.hidden` is forced true and `visibilitychange` fires; output written while hidden is not rendered; on show the view re-attaches and the missed output appears in the buffer. Checked via `window.__erka.views()`, so it is a real code-path check, not a DOM-only one.

Diff-aware mode: analyzed changed frontend files (store.ts, layout.ts, pane-view.tsx, split-view.tsx, workspace-view.tsx, commands.ts, terminal-pane.tsx, new-session-menu.tsx, mode-switch.ts).
- Changed: the files above.
- Mapped (Strategy C, import/DOM use): `scripts/e2e/smoke.py`, `phase1.py`, `layouts.py`, plus new `split_picker.py`.
- Unmapped: no unit test suite exists in `app/` (no test script in `package.json`). `[!] No tests found for store.ts (splitPicker, moveTab, movePaneToTab, mergeTab) and layout.ts (insertBeside)`. Covered only through e2e. Consider adding a unit test runner for `lib/layout.ts`, which is pure and cheap to test.
- Ran: 4 e2e scripts (112 checks) plus static gates.

## Resolved product bug (verified on rebuilt app)

**Esc in empty picker did not refocus the split pane.** Before the fix: focus went to the first pane (`0fhvu2nndpc2`) instead of the split pane (`e4wvqb7iduj7`), reproduced on 2 runs. Root cause (per coordinator, confirmed by the rerun): `EmptyPane` read `props.pane.id` after the pane had left the tree, so the `.then` callback threw before `focusPane`. Fix in `pane-view.tsx` captures ids before closing. Rerun: "Esc refocuses the pane that was split" PASS.

## Concerns (non-blocking, from test-side review)

- Coordinator's point 2 (key auto-repeat) is verified with synthetic `KeyboardEvent(repeat: true)` dispatch, not a real held key. Effective, but not OS-level.
- Coordinator's point 1 (second start into filled pane keeps the first session) and "double-click starts one session" PASS. The fallback session lands in a new tab; the test closes it.
- Not covered: "More…" → chat view start (needs a real agent process; `layouts.py --ai` is the existing path for real Claude), terminal right-click context menu "Split Right…" (not driven), and real OS-level pointer drag of the tab bar beyond the `d.drag` used (it works for all drags tested).
- Tab-bar empty-space drop needed hit-testing for a free point (the bar is full with ~6 tabs at 1480 px). Not a product issue; the test finds the point at run time.

## Build and layout details

- `insertBeside`/`mergeTab`: nested same-direction splits are NOT produced. `makeSplit` flattens. Verified in Node (outputs such as `row[x1,y1,y2]@0.5,0.25,0.25`) and in e2e (3 merge cases, all invariant-clean, sizes sum to 1).
- Earlier concern about `insertBeside` comment mismatch: resolved, no bug.

## Process hygiene

Started and stopped (all isolated, under scratchpad, endpoint `erka-e2e-split`, data dir in scratchpad):
- Debug `erka.exe` built with `--features tauri/custom-protocol` into scratchpad target dir, not the repo `target/`. Frontend embedded from `app/dist` (rebuilt twice).
- Release `erkad.exe` in the same scratchpad target dir.
- First round: `tauri-driver` PID 15028 on 4446/4447 with `msedgedriver` (child 9064), app daemon `erkad` 14624. Stopped.
- Rerun round: `tauri-driver` PID 17416 on 4446/4447 with `msedgedriver` (17448) and daemon `erkad` 276. Stopped with `taskkill` (no force). Verified no leftover processes from the scratch dir and no listeners on 4446/4447.

NOT touched: another session's `tauri-driver` PID 17228 on 4444 (native 4445 with msedgedriver 4684), its `erka.exe` 3892, `erkad.exe` 616 and 17096, and vite on 1427 (PID 13212). Port 4444 was taken, so the harness override was used.

Harness changes (scripts/e2e only):
- New `scripts/e2e/split_picker.py`: 42 checks covering the plan's acceptance items plus the coordinator's five product changes.
- `scripts/e2e/wd.py`: `Driver` URL now honors `ERKA_E2E_DRIVER` (default unchanged, `http://127.0.0.1:4444`). Added `import os`. Needed because 4444 was in use.
- Note: `wd.py` already had uncommitted changes from earlier work; only the 3 lines above are mine.

No product code under `app/src` was modified.

## How to run

```
ERKA_E2E=1 ERKA_ENDPOINT=<isolated> ERKA_DATA_DIR=<scratch dir> ERKA_DAEMON_PATH=<erkad release exe> \
ERKA_E2E_APP=<debug erka.exe built with --features tauri/custom-protocol> ERKA_E2E_DRIVER=http://127.0.0.1:<port> \
python -X utf8 scripts/e2e/split_picker.py <shots-dir> <scratch-dir>
```
`phase1.py` expects the repo root as project argument (`D:/Works/Erka`); it reads `target` ignored entries and `crates/erkad/src/session.rs`. An empty fixture dir fails at the explorer step.

## Recommendations

1. Re-run `layouts.py` on the final build (last run was before the two fixes).
2. Add a unit test runner for `lib/layout.ts` (`insertBeside`, `movePane`, `cyclePane`, `removePane`). Fast and deterministic.
3. Add `split_picker.py` to the README e2e table (`README.md` ~line 295) when the fix lands.
4. Consider a chat-view start check in `More…` through `layouts.py --ai`-style real-agent run.

Status: DONE
Summary: Rerun on the rebuilt app: split_picker.py 46/46 (includes Esc focus fix and hide/show detach/replay), smoke.py 16/16, phase1.py 10/10; typecheck, i18n:check, build pass. layouts.py 44/44 on the pre-fix build only.
Concerns/Blockers: none blocking. layouts.py not rerun on the final build; other session's processes on 4444/4445/1427 left alone.

## Unresolved questions

- Whether the "More… → chat view" start works end-to-end (needs a real agent run; not executed).
- Whether `INEFFECTIVE_DYNAMIC_IMPORT` build warnings predate this change (not checked against HEAD).
