# Code review: SSH panes in any project + host UX

Scope: feature hunks only (rename ignored). `npx tsc --noEmit`: clean. `node scripts/i18n-check.mjs`: 0 missing / 0 problems. Cargo tests not run (shell hook blocks them).

## High

1. **`data-host` on `.pane` collides with the hosts-list selector, which breaks e2e.** `pane-view.tsx:67` adds `data-host={target()?.dest}` to every pane with a remote session, including panes in remote projects. The hosts list uses the same attribute (`hosts-page.tsx:164`). The workspace stays mounted under the fixed overlay (`app.tsx:118` comes before `:136`, `.runs-page` is `position: fixed; inset: 0`). So `d.click("[data-host=…]")` matches the hidden pane first, and WebDriver fails with "element click intercepted".
   - Certain failures: `scripts/e2e/ssh_hosts.py:190` and `:268` (a terminal on test-box is open in the active remote project), and `scripts/e2e/ssh_panes.py:410` (project B now holds a remote pane).
   - Fix: rename the pane attribute (for example `data-pane-host`, and update `ssh_panes.py:299`), or scope the selectors to `.host-item[data-host=…]`.

## Medium

2. **The host colour stripe never shows.** `styles.css`: `.pane.on-host { box-shadow: inset 3px 0 0 var(--host-color) }`. An inset shadow is painted under the element's children. `.pane` has no padding, and its children are opaque: `.pane-header` uses `--bg-elev`, and `.term-wrap` is `absolute; inset: 0` with a background (now also `hostBg`). This fails the acceptance item "Host colour visible on every remote pane".
   - Fix: use a `::before` strip (`position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--host-color); z-index: 6; pointer-events: none`), the same way `.pane.focused::after` does.

3. **Drawer Connect fails on the usual first-connect case.** `hosts-page.tsx` `connect()` closes the overlay, then calls `connectHost` → `hostProject` → `checkHost`. A brand-new host almost always has an unknown key (BatchMode), so this throws. The user only gets a toast and the trust panel never opens. Audit item #9 is not met on this path.
   - Fix: when `isHostKeyError(e)` is true, call `openHosts("hosts", saved.id, { trust: true })`, or keep the page open and show the trust panel.

4. **Saved layouts are global but store another project's host folder.** `saveLayout` (`store.ts:697-702`) writes `target.path`, the absolute folder of the pane in this project. Layouts live in `settings.layouts` and can be applied in any project (`welcome.tsx:78`, `layout-menu.tsx:181`, `layout-settings.tsx:26`).
   - Failure: applying "Remote pair" in project B starts its agent in project A's folder on the host. This is exactly the shared-folder conflict `agentsAt` warns about, but here there is no warning and no host-key check (`applyLayout` skips `hostTarget`).
   - Fix: store the host (dest/hostId) and mark whether the path was the source project's linked folder. At apply time, resolve the folder through `hostTarget(host, targetProject)`.

## Low

5. **Tab in `EmptyPane` doesn't check the host.** `nextMachine` (`pane-view.tsx:133-137`) does not call `checkHost` the way `pick()` does (`host-target.tsx:84`). As a result:
   - The kinds stay `CORE_AGENTS`, so digits can start a CLI the host doesn't have.
   - A new host key is only found when you press Start.
   - Fix: share `pick`'s logic.
6. **`EmptyPane.start` reads `into()` after `await resolveRunOn`** (`pane-view.tsx:128-129`). The first check of a host can take seconds. If the user presses Esc and closes the pane meanwhile, the session still starts (in a fallback tab), or the props may no longer resolve. Capture `into()` before the await and bail out if the pane is gone.
7. **The folder input blocks all keys from bubbling.** `host-target.tsx:124` calls `stopPropagation` on every keydown. In the New Session dialog (`new-session-menu.tsx:85-89`), Enter in the folder field doesn't start and Esc doesn't close. Global shortcuts are also dead while it has focus. Stop only digits and Tab.
8. **New Session dialog keeps the default kind `"claude"`** even when the chosen host doesn't list it (`kinds()` is filtered by `runOnAgents`). Start then runs a missing CLI on the host. Reset `kind` when it is not in `kinds()`.
9. **The drawer's Connect ignores "Open in: current project".** It always opens the host's own remote project (`hosts-page.tsx connect()`).
10. **`token()` can wipe a plugin theme choice.** `ssh_hosts.rs` `token()` keeps only `[A-Za-z0-9._-]` and cuts at 48 characters. Plugin theme ids are `${plugin.id}.${item.id}`, and `item.id` is not validated. A long or unusual id is saved as a different string, and the host silently falls back to the app theme.
11. **Save in the drawer can overwrite a fresh OS value.** The drawer holds a copy of the host, and `saveHost` replaces the whole host. If a check records `os` while the drawer is open, Save writes back the old value. `lastConnected` already has the same issue.
12. **`parseDestination` limits:**
    - It accepts ports up to 99999, which fails u16 deserialisation on save (the error shows in the drawer).
    - `ssh myhost` (a single-label name with no user) never parses.

## Verified OK

- The askpass env comes from the session's own destination (`store.ts:606`).
- Resume after hibernation or daemon restart uses the daemon's stored spec (`daemon.rs:572-585`), so the remote and env are kept.
- The `findConversation` guard is in place.
- Plugin layouts drop `target` (`plugins.ts:96`), so a plugin cannot inject an ssh destination.
- `os` and `terminal_theme` are sanitised and never written into the ssh config.
- The os-release probe runs in a subshell, so a missing file is harmless.
- Remote projects' panes don't gain headers (`elsewhere()` compares dest).
- `connectHost`'s default behaviour is unchanged.
- Drawer Escape calls `preventDefault`, so the page's Escape handler (which checks `defaultPrevented`, `hosts-page.tsx:63`) keeps the page open.
- Split, grid and hand-off pass the target through.

## Unresolved questions

- Should saved layouts be portable across projects (resolve the host folder per project) or tied to the project they were saved in?
- Is Tab in the empty pane allowed to override normal focus navigation (accessibility)?
- Was `scripts/e2e/ssh_panes.py` run against this build? Finding 1 says it can't pass as written.
