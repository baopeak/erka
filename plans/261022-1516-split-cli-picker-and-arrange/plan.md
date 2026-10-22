# Split → choose CLI, unified new-pane flows, arrange existing CLI windows

Status: done (uncommitted) · Mode: auto · Branch: master

## Result

- All 6 acceptance criteria met. Steps 1–6 done.
- Review fixes applied: placePane only fills a still-empty pane (found by id across tabs);
  picker guards double start / key repeat; picker focus respects open overlays; stale-focus
  fallbacks in movePaneToTab / mergeTab; Esc refocuses the split pane.
- Not done: header drag of a lone pane (it has no header; drag its tab instead).
- Verification: typecheck, i18n:check, build pass. e2e: split_picker.py 46/46 (new),
  smoke.py 16/16, phase1.py 10/10. layouts.py 44/44 ran before the final two fixes.
- Same session, separate fix: terminal-host.ts stops streaming into on-screen terminals while
  the window is hidden and replays the missed delta on show (slow restore from background).
  Covered by split_picker.py hide/show check; real minimize not yet confirmed by the user.
- Reports: `plans/reports/tester-261022-1516-split-cli-picker-and-arrange.md`.

## Brainstorm contract

- **Outcome**: splitting never silently starts PowerShell; the new pane asks which CLI to run
  (installed agents, Terminal, or the full dialog). Every split entry point uses one store path.
  Existing CLI windows can be rearranged: tabs reordered, panes moved between tabs.
- **Constraints**: SolidJS + existing store/layout helpers; no new deps; Tauri on Windows blocks
  HTML5 DnD, so pointer events only; every new UI string gets a `vi` entry (`pnpm i18n:check`);
  command ids `split.right` / `split.down` keep their ids and default chords (user keybindings).
- **Non-goals**: backend/daemon changes; "New Terminal" (`new.shell`) stays an explicit shell;
  hand-off / plugin / browser splits keep their explicit kind.
- **Acceptance**
  1. Tab-bar split buttons, pane header split buttons, terminal context menu Split, `split.*`
     shortcuts/palette → an empty pane appears next to the focused pane, focused, showing a
     picker (agents + Terminal + "More…").
  2. Picker: click or keys 1–9 start that kind in place; Esc closes the empty pane.
  3. "More…" opens the New Session dialog targeting that pane ("This pane"), incl. chat view.
  4. Tabs can be dragged to reorder; palette commands "Move Tab Left/Right".
  5. Dragging a pane header onto another tab moves the pane into that tab; onto empty tab-bar
     space moves it to a new tab. Source tab disappears when emptied.
  6. `pnpm typecheck`, `pnpm build`, `pnpm i18n:check` pass.

## Scout evidence

- Split entry points hard-coding `"shell"`: `components/workspace-view.tsx` (tab bar),
  `components/pane-view.tsx` (`split`), `components/terminal-pane.tsx` (menu),
  `lib/commands.ts` (`split.right/down`).
- Picker already exists: `EmptyPane` in `components/pane-view.tsx` (used by grids/layouts).
- Placement: `store.placePane` / `newSession({ into })` in `lib/store.ts`; chat: `newChat` in
  `chat/mode-switch.ts` (no `into`).
- Pane drag: `startPaneDrag` in `components/split-view.tsx` → `store.dropPane`. No tab reorder.

## Steps

1. `store`: `placePane(..., into?)` handles in-place replacement (used by `newSession`, `newChat`);
   `splitPicker(projectId, where)`; `moveTab(projectId, tabId, toIndex)`;
   `movePaneToTab(projectId, fromTab, paneId, toTab | null)`.
2. Route all split entry points to `splitPicker`; relabel commands "Split Right…/Split Down…".
3. `EmptyPane`: focusable, digit shortcuts, Esc closes, "More…" → `openNewSession({ into })`.
4. `NewSessionMenu`: optional target pane → "This pane" placement (terminal + chat).
5. Tab bar: pointer-drag reorder + drop target for pane drags; `tab.moveLeft/Right` commands.
6. vi locale entries; typecheck/build/i18n; e2e check in dev if feasible.

## Risks / rollback

- Pane move across tabs remounts the terminal view (same as swap / reveal) — view is cached per
  session, so no scrollback loss. Rollback: revert the touched files (all frontend).
