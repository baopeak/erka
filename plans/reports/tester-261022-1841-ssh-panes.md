# Test report: SSH panes in any project (+ Termius-style host UX)

Date: 2026-10-22 · Plan: `plans/261022-1841-ssh-panes-in-any-project/plan.md` · Branch: rebrand/kelpie (uncommitted tree)

## Results overview

Final build: frontend `npm run build` (tsc + vite) passed; debug app `kelpie.exe` (`--features tauri/custom-protocol`) and release `kelpied.exe` built into a scratch target dir, after the coordinator's review fixes.

| Suite | Result |
|---|---|
| `scripts/e2e/ssh_panes.py` (new) | 40/40 PASS |
| `scripts/e2e/ssh_hosts.py` (regression) | 25/25 PASS, no edits needed |
| `scripts/e2e/split_picker.py` (launcher regression) | 46/46 PASS |

Total: 111 checks, 111 passed. Edited files: `scripts/e2e/ssh_panes.py` (new) and this report only. `ssh_hosts.py` and `split_picker.py` untouched.

## ssh_panes.py: checks

Quick connect and host setup
- PASS typing `tester@127.0.0.1:47844` offers "Add …"
- PASS Enter opens the drawer prefilled (user, hostname, port)
- PASS drawer has sticky Connect and Save; Esc closes without saving
- PASS button path opens the drawer; host saved with alias `panes-box`; password in credential store
- PASS unknown host key → fingerprint check → trust → check OK
- PASS OS recorded from check: `mingw64_nt-10.0-19045`

Split → Run on → remote pane (local project)
- PASS split (Ctrl+Shift+D) shows the Run on row (`own` chip, Other host…)
- PASS Other host… offers the saved host as a chip
- PASS Terminal kind offered for the host
- PASS shell starts on the host: `remote.dest == panes-box`, `cwd` = picked folder
- PASS `.pane[data-pane-host]` + header host chip; tab title host chip
- PASS commands run on the host in its folder (`pwd` in PTY)
- PASS local shell starts beside the remote pane, same tab
- PASS split of the remote pane preselects its host chip
- PASS Tab cycles machines (own ↔ host)

Links
- PASS link from launcher saves `{hostId, path}` on the project
- PASS new pane starts in the linked folder
- PASS a second project links the same host with another folder
- PASS host lists both projects (`[data-host-link]`)
- PASS unlink removes only that link; host stays in vault; other link kept

Hosts page and layouts
- PASS "Open in → current project" offered and used: terminal's `project_id` is the local project
- PASS no remote project created for the host; local project stays active
- PASS saved layout remembers the remote pane's host (and folder)
- PASS applying the layout reopens every remote pane on the host in its folder

Terminal theme
- PASS Appearance section lists themes; chosen theme (`nord`) saved in vault

Screenshots (`<scratch>/ssh-panes/shots/`): `01-quick-connect-drawer`, `02-host-drawer`, `02b-hosts-after-save`, `03-trust-host-key`, `05-launcher-run-on`, `06-mixed-tab`, `07-split-preselects-host`, `08-linked-folder-pane`, `09-host-used-in-projects`, `10-layout-reopened`, `11-hosts-drawer-appearance`. Paths: `C:\Users\BAOPEA~1\AppData\Local\Temp\claude\d--Works-Erka\d63eff6c-2ff9-44ce-9198-929defeb892a\scratchpad\ssh-panes\shots`.

Timing: ssh_panes run about 3–4 min; ssh_hosts about 4 min.

## Product findings

1. **Stale typed address hides the saved host** (UX, medium)
   - Repro: hosts page → type `tester@127.0.0.1:47844` → Enter → fill drawer → Save.
   - Observed: the search box still holds the typed address. The list shows only "Add tester@127.0.0.1:47844" and no host row. The saved host appears only in the detail pane (screenshot `02b-hosts-after-save`).
   - Cause: `HostsTab` `query` is not cleared after the host is saved from the typed address, and `matches()` finds no field containing the full `user@host:port` string.
   - Guess: `app/src/components/hosts-page.tsx` (`HostsTab`: `quickConnect`, `typed`, `matches`, drawer `onDone`). Suggested fix: clear the query when a host is saved from it.

No other product bugs found. Earlier failures in this run were test-side and are fixed in the script (see below).

## Test-side fixes (scripts/e2e/ssh_panes.py only)

- Pane selectors use `data-pane-host` (per coordinator's change). Host-list clicks use `.host-item[data-host=…]`.
- `open_hosts()` runs the `hosts` command only when the page is not already open. That command toggles the overlay.
- Quick-connect box cleared before the trust step (see finding 1). Screenshot after save added.
- Overlay closed after the trust step, so it does not intercept clicks on the workspace.
- Layout round trip compares the set of remote folders before and after reapply (a saved layout may hold two remote leaves; the one whose folder is the project's usual folder is stored as `""` and reopens in the linked folder).

## Process hygiene

Started and stopped (all isolated, scratch dir `…\scratchpad\ssh-panes`, endpoint `kelpie-e2e-panes`, data dir and SSH dir in scratch):
- tauri-driver on 4446 / native msedgedriver on 4447; chain restarted once after the other session stopped msedgedriver 8112. Stopped: tauri-driver 1100 (`/F`, graceful refused), tauri-driver 16292 (`/F`), msedgedriver 6236 (already gone at stop).
- daemon `kelpied` from scratch release dir: 7088 (`/F`; it locked the release exe during rebuild), later daemon 4908 (gone at stop).
- test SSH servers on 47844 and 47824 stopped by each script on exit.

NOT touched: another session's tauri-driver on 4444/4445 and its msedgedriver, `erka.exe` 7468 (installed app), `kelpied.exe` 15520 under `D:\Works\Erka\target`, and the rest of the repo.

## Unresolved questions

- Should the quick-connect query clear after saving a host from it (finding 1), or should the new host be selected while the query stays?
- "Open in → current project" only renders when the active project is local and not linked to the host. Intended, or should the seg show for linked projects too?
- Background `hosts` command toggles the overlay (`commands.ts:170`). Intended for keyboard use; the test works around it.

Status: DONE_WITH_CONCERNS
Summary: ssh_panes.py 40/40 on the final rebuilt app; ssh_hosts.py 25/25 and split_picker.py 46/46 as regressions, no product bugs in those paths. One UX bug: typed address stays in the hosts search box after saving the host, hiding it from the list.
Concerns/Blockers: finding 1 is open. Other session stopped my msedgedriver mid-session; I restarted the chain and re-ran the final scenario.
