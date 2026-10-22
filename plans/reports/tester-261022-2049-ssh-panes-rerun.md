# Test report: SSH panes re-run after quick-connect fix

Date: 2026-10-22 · Branch: rebrand/kelpie == master == ea4cd7e · Prior run: `tester-261022-1841-ssh-panes.md`

## Results

| Suite | Result |
|---|---|
| `scripts/e2e/ssh_panes.py` (+3 new checks) | 43/43 PASS |
| `scripts/e2e/ssh_hosts.py` (regression) | 25/25 PASS, no edits |

Total: 68 checks, 68 passed. Edited: `scripts/e2e/ssh_panes.py` only (plus this report).

Build from current tree: `npm run build` (app/) passed; debug `kelpie.exe` (`--features tauri/custom-protocol`) and release `kelpied.exe` built into scratch cargo dir `…\scratchpad\ssh-panes\cargo-rerun` (fresh dir, full rebuild: 36 min debug, 11 min release).

## New checks (ssh_panes.py, quick-connect section, after save)

Added right after the drawer save from the Connect button path (typed `tester@127.0.0.1:47844`):

- PASS saving from the quick-connect box clears it (`[data-field=quick-connect]` value `''`)
- PASS the saved host is listed in the hosts page (`.host-item[data-host=panes-box]`, height > 0)
- PASS the add-typed row is gone after saving (`[data-action=add-typed-host]` absent)

Rest of the script unchanged.

## Failures

None on the product. One test-side problem, fixed in the run setup (not in the script):

- First attempt: `scenario ran to completion` FAIL, `run.boot()` timed out on `store.connected()`. Cause: `KELPIE_DAEMON_PATH` was passed to the Python run, not to tauri-driver, so the app looked for `kelpied` beside the debug exe. Fixed by restarting the driver with the variable set. Not a product bug.

## Not covered / caveats

- The new checks were not shown red on the pre-fix build. Reasoning only: pre-fix, `query` keeps the typed address, so the box is non-empty and the add-typed row shows.
- The fix is exercised via the Connect button path only. The Enter path opens the same drawer and uses the same `onDone`; the existing Enter check (prefill) stays, but no Enter-path save is run.
- The trust section still calls `fill("", …)` with the old comment about the box filtering the list. Harmless now; not edited (rest of script kept).
- Single run per suite; no flake re-run.

## Process hygiene

Started by me, all stopped:
- tauri-driver PID 9156, port 4446 (first attempt, no daemon; graceful refused, `/F`)
- msedgedriver PID 12720, port 4447 (child of 9156; gone with it)
- tauri-driver PID 15188, port 4446 (final run; graceful refused, `/F`)
- msedgedriver PID 15968, port 4447 (child of 15188; gone with it)
- kelpied release daemon PID 8996 from scratch dir (app-spawned; gone at stop)
- test SSH server on 47844: stopped by the script on exit (not listening at end)

Not touched: any driver on 4444/4445 (none listening at end), installed app, repo `target` dir, other cargo/python processes.

## Unresolved questions

- Should the quick-connect box also be cleared when the drawer is closed without saving (Esc)? Current behaviour kept: box stays, host list stays filtered.

Status: DONE_WITH_CONCERNS
Summary: rebuilt app and daemon from current tree; ssh_panes.py 43/43 (3 new checks for the quick-connect fix pass) and ssh_hosts.py 25/25. No product bugs found.
Concerns/Blockers: new checks not proven red on pre-fix build; fix covered via Connect-button save only, not Enter-path save.
