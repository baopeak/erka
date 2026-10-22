# Long-scrollback terminal UX: switching + scrolling 10k-100k lines (xterm.js, Claude Code)

Date 2026-10-21. Env: Tauri 2 / SolidJS, @xterm/xterm 6.0.0 (installed, verified in node_modules), WebGL addon, erkad + alacritty_terminal.
Confidence tags: [V]=verified in installed xterm source / Erka code, [D]=official docs, [C]=community/issue claim, [I]=my inference.

## 0. TL;DR (brutal)

1. Biggest lever is NOT xterm tuning. It is making Claude Code stop writing to the main-buffer scrollback. Claude's fullscreen renderer (alt screen, in-app scroll, flat memory) is the vendor-recommended fix for flicker/jump-to-top, and is already default for new users since 2026-05-06 [D]. Erka should launch Claude with `CLAUDE_CODE_NO_FLICKER=1` (or rely on `tui` setting) and wire wheel/PgUp correctly.
2. Classic renderer jump-to-top root cause is partly provable: xterm `CSI 3J` handler trims scrollback and sets `ydisp=0` [V: InputHandler.ts:1248-1257]. Swallowing `CSI 3J` via `parser.registerCsiHandler` is a 5-line embedder fix [C reports it works].
3. Erka already does the hard parts right (keep xterm alive when parked, WebGL cap, delta re-attach). Gaps: no scroll-to-bottom UI, no prompt/mark navigation, `SNAPSHOT_HISTORY=2000` caps cold re-attach history, no overview ruler/scrollbar markers, no MRU switch (not verified; check keymap).
4. 100k scrollback is ~144 MB/terminal at 120 cols (12 B/cell, see 1.1). With 16 parked views that is 2.3 GB. Cap defaults ~10k and cap total budget, not per-terminal.

## 1. xterm.js facts

### 1.1 Scrollback memory
- Cell = 3 x Uint32 = 12 B [V: BufferLine.ts `CELL_SIZE = 3`; design origin https://github.com/xtermjs/xterm.js/issues/791].
- Line cost = cols x 12 B (+ small object overhead; combined/extended attrs add more).
- Table (my arithmetic, 120 cols / 200 cols):

| scrollback | 120 cols | 200 cols |
|---|---|---|
| 5k (Erka default) | 7 MB | 12 MB |
| 10k | 14 MB | 24 MB |
| 50k | 72 MB | 120 MB |
| 100k (Erka max in UI) | 144 MB | 240 MB |

- Allocation is circular list; full buffer recycles rows, low GC (https://github.com/sourcelair/xterm.js/releases/tag/2.3.0).
- Ghostty counts scrollback in BYTES not lines, per surface, lazily allocated, oldest dropped (https://ghostty.org/docs/config/reference). Alacritty default 10k lines (changelog 0.2.0, https://github.com/alacritty/alacritty/blob/master/CHANGELOG.md). WezTerm example 3500 (https://wezterm.org/config/lua/config/scrollback_lines.html). So 10k is the industry norm; 100k is outlier.

### 1.2 Renderer
- 6.0.0 REMOVED canvas renderer; only DOM or WebGL [D: https://github.com/xtermjs/xterm.js/releases]. DOM fallback is slow with big viewports; keep WebGL on visible only.
- RenderService pauses rendering via IntersectionObserver when screen element not intersecting (display:none counts) [V: RenderService.ts:123-137]. So parked/hidden terminals do not paint; cost is only parse + buffer writes.
- WebGL context cap ~16 live; browsers evict oldest silently (WebKit commit note: https://webkit.googlesource.com/WebKit/+/70e10861eb2fbd9d0862fd8702874c25ae5d8bfd). Addon README: handle `onContextLoss` (dispose addon) [D: addon-webgl README]. Erka does this [V terminal-host.ts:202, MAX_HIDDEN_WEBGL=6].
- Erka comment claims WebGL canvas DOM-detach costs 100-200 ms and context rebuild 100-400 ms [Erka authors' measurement, not independently verified]; the parking-lot (`display:none` in-document) design is consistent with that.

### 1.3 Scroll options (6.0.0 typings)
| option | note | Erka now | suggest |
|---|---|---|---|
| `scrollback` | default 1000 | 5000 | keep 5k-10k default; show memory estimate in settings |
| `smoothScrollDuration` | ms; 0 off. 6.0 limits smooth to once/frame (#5037) | 0 | leave 0 for wheel; maybe 60-100 only for programmatic jumps (scrollToLine) [I] |
| `scrollSensitivity` | wheel multiplier | default 1 | expose setting (Windows precision touchpads feel slow/fast) |
| `fastScrollSensitivity` | multiplier while Alt held | 5 | ok |
| `fastScrollModifier` | REMOVED in 6.0 (#5462) along with `windowsMode`; Alt is fixed | n/a | do not use |
| `scrollOnUserInput` | snap to bottom on keystroke | true | keep |
| `scrollOnEraseInDisplay` | ED2 pushes viewport into scrollback (PuTTY style) | unset (false) | try true ONLY for classic-renderer Claude; see 3.2 |
| `reflowCursorLine` | default false | unset | leave |
| `scrollbar.overviewRuler` (6.0: `overviewRulerWidth` moved under it, #5107) | decorations drawn beside scrollbar | unused | use for marks (2.3) |
| `vtExtensions` | kittyKeyboard, win32InputMode, colorSchemeQuery | unset | optional, not scroll related |

Source for typings: https://raw.githubusercontent.com/xtermjs/xterm.js/master/typings/xterm.d.ts
- 6.0 swapped viewport/scrollbar to VS Code's scrollable ("work very differently now", #5096) and fixed scrollbar jump after leaving alt buffer (#5390, #5411). Treat 6.0.x scroll bugs as live risk; pin and test.

### 1.4 Synchronized output (DECSET 2026)
- Added in xterm.js 6.0.0 (PR #5453) [D release notes]. Verified in code: set/reset 2026 in InputHandler, render rows buffered while mode on, DECRQM replies for 2026 [V InputHandler.ts:1972, 2203, 2301; RenderService.ts:154-178,320-349]. Public API `terminal.modes.synchronizedOutputMode`.
- Effect: BSU/ESU blocks paint atomically = kills tearing/flicker from Claude's classic redraw. Does NOT fix scroll jump (that is ED3/ydisp, separate).
- Claude Code probes terminal support at startup and uses it if reported; `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` forces it [D: https://code.claude.com/docs/en/terminal-config]. Since xterm 6 answers DECRQM, auto-detect should work; unresolved: whether Claude's probe path (DA/DECRQM) survives Erka's `suppressReplies`/`isTerminalReply` filter and ConPTY (see Q1).
- Daemon side: alacritty_terminal supports `CSI 2026` since Alacritty 0.13 (changelog above). Not grep-verified in Erka vt.rs; sync blocks are harmless when ignored but daemon snapshots could capture mid-frame state [I].
- tmux <= 3.6 lacks sync output (irrelevant to Erka unless users run tmux inside).

### 1.5 Serialize addon
- `@xterm/addon-serialize`: `serialize({scrollback, excludeModes, excludeAltBuffer})` returns ANSI string; README says "experimental/under construction"; typings advise calling before `open()` (https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/README.md). Cost is O(buffer); do on dispose/idle, never per keystroke.
- VS Code uses it for persistent sessions; scrollback restored limited by `terminal.integrated.persistentSessionScrollback` (https://code.visualstudio.com/docs/terminal/advanced).
- Erka does NOT need it: the daemon already serializes (`vt.snapshot(SNAPSHOT_HISTORY)`). Superset's daemon does the same (headless emulator serialize on attach, not raw replay) (https://superset.sh/blog/terminal-daemon-deep-dive). Only use serialize addon if you want to persist an evicted frontend buffer without a daemon round trip (low value).

### 1.6 Hidden terminals / resize / reflow
- display:none + FitAddon: measures 0 / wrong size; fit must run only when visible, then push cols/rows to PTY [C: ManyMany.dev#3 issue, xterm #880 re: background tabs sized full-screen]. Erka `fitNow()` returns early when not visible [V]. Good.
- Hidden-terminal resize storm: each hidden tab keeps full-screen cols/rows; do not resize hidden views; resize on show only (Erka does).
- Reflow: xterm reflows entire buffer on column change. 6.0 reworked reflow ("ConPTY-like", #5321) and added `reflowCursorLine` (#5234), clears selection on vertical resize (#5423). No published xterm benchmark found; a Dart xterm port measured ~10 ms per 10k-line rewrap (x2 for round trip) [C, weak]. [I] Expect tens of ms to low hundreds at 100k lines in JS; profile. Mitigation already in Erka: 40 ms debounce in ResizeObserver. Add: skip fit while a drag-resize/split-drag is active, fit on pointer-up (not verified in repo).
- Daemon side `vt.resize` also reflows alacritty grid under the session mutex (session.rs:446-455) and bumps `replay_floor`, forcing a full snapshot on next attach. Resize-heavy workflows therefore make every re-attach a snapshot [V].
- Screen reader mode causes forced layout per row (DOM renderer) [C: Claude issue 84712]; do not enable `screenReaderMode` by default.

## 2. Navigation features (what the best apps do)

| App | Mechanism | Source |
|---|---|---|
| VS Code | OSC 633 A/B/C/D/E/P + OSC 133; Ctrl/Cmd+Up/Down jump between commands, +Shift selects output; sticky scroll pins current command header; decorations + overview ruler marks (success/fail); command guide; Ctrl+Alt+R recent commands; SetMark (OSC 1337) also navigable | https://code.visualstudio.com/docs/terminal/shell-integration |
| Windows Terminal | OSC 133 A-D; `scrollToMark` previous/next (bind ctrl+up/down), `showMarksOnScrollbar`, `autoMarkPrompts`, `selectOutput`/`selectCommand`; stable since 1.21 | https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration |
| iTerm2 | OSC 133 + SetMark (Cmd+Shift+M), jump to mark Cmd+Shift+J; marks on scrollbar [marks UI detail not confirmed on page] | https://iterm2.com/documentation-escape-codes.html |
| Warp | Blocks: Cmd/Ctrl+Up selects blocks, arrows between; Cmd+Shift+Up/Down top/bottom of block; sticky command header (click = scroll to block start); PgUp/PgDn/Home/End | https://docs.warp.dev/terminal/blocks/block-basics |
| Ghostty | Scrollback in bytes, lazy; OSC 133 prompt marking; `jump_to_prompt` action (name from memory, not confirmed on fetched page - `ghostty +list-actions`) | https://ghostty.org/docs/config/reference |
| WezTerm | `ScrollToPrompt` action + SemanticZone API (OSC 133); scrollback_lines 3500 | https://wezterm.org/config/lua/config/scrollback_lines.html |
| Zed | Shift+Home/End, Cmd+Home/End scroll top/bottom, `scroll_multiplier`, vi mode (Ctrl+Shift+Space), search; no marks | https://zed.dev/docs/terminal |
| Claude Code (own TUI, fullscreen) | PgUp/PgDn, Ctrl+Home/End, "Jump to bottom" floating button with new-message count, sticky "most recent prompt" header (click to jump), Ctrl+O transcript mode with `/` search, `n/N`, `{ }` prev/next prompt, `[` dump into native scrollback, `v` open in $EDITOR | https://code.claude.com/docs/en/fullscreen |

Pattern across all: (a) semantic marks, (b) keyboard jump prev/next, (c) marks painted in scrollbar, (d) sticky header, (e) explicit "scroll to bottom" affordance. Nobody makes raw 100k-line wheel scrolling "smooth" by magic; they rely on GPU renderer + marks + search.

### 2.1 xterm.js APIs to build the same
- Marks: `term.registerMarker(offset)` returns `IMarker` (line auto-updates as scrollback trims; -1 when disposed). `term.registerDecoration({marker, x, width, height, backgroundColor, layer, overviewRulerOptions:{color, position:'left'|'center'|'right'}})` draws gutter/ruler items. Needs `allowProposedApi: true` (Erka has). Alt buffer: `registerDecoration` returns undefined [D typings].
- OSC capture: `term.parser.registerOscHandler(133, data => {...; return false/true})` (also 633). Handler may return false to pass through. Payload cap 10 MB.
- Jump: `term.scrollToLine(marker.line)`; `term.scrollLines(n)`, `scrollPages`, `scrollToTop()`, `scrollToBottom()`; `term.buffer.active.viewportY/baseY` to know if at bottom; `term.onScroll`, `term.onWriteParsed`.
- Search: `@xterm/addon-search` (loaded). 6.0 added SearchLineCache for faster search (#5403). Add `decorations` option for match highlights in overview ruler.
- Sticky header: DIY overlay: on `onScroll`, find latest marker with `line <= viewportY`, render its text in an absolutely positioned div; click => `scrollToLine`.
- "Scroll to bottom" button: show when `buffer.active.viewportY < buffer.active.baseY`; update on `onScroll` + `onWriteParsed`; click `scrollToBottom()`.

### 2.2 Marks for AGENT TUIs (key caveat)
- Shell OSC 133 only helps shells (PowerShell/bash prompt). Inside Claude Code/Codex TUI, no 133 marks come from the app. [I] For agent sessions, "commands" = user prompts. Options: (1) Erka marks the line when user presses Enter in terminal (`onData` with `\r` while cursor line known -> `registerMarker(0)`), (2) rely on app's own transcript mode (Ctrl+O). Option 1 is cheap and works for any CLI, but unreliable with multi-line input/redraws in classic mode (lines get rewritten). Less reliable in alt-screen (markers unavailable).
- Windows: PowerShell/cmd prompt injection for OSC 133/633 requires profile edits (WT doc shows scripts) or VS Code-style injected init script; Erka-spawned shells could inject `-NoExit -Command` bootstrap. Cost/benefit: moderate; only value for plain shell panes.

## 3. Claude Code flicker / jump / scroll-to-top

### 3.1 Why
- Classic renderer repaints a region of main buffer; when response exceeds viewport it emits cursor-up taller than viewport plus `CSI 2J`/`CSI 3J`, `CSI H` full redraw [C: https://claudeissues.com/issue/36582..., https://claudeissues.com/issue/35580-root-cause-fix-for-scroll-jumping-on-long-responses-csi-2j-inside-dec-2026-sync]. Affects VS Code, Windows Terminal, iTerm2, Tabby, Ghostty and "Tauri/xterm.js" embedders. Anthropic gave no per-bug fix; closed as duplicates [C].
- Verified in xterm 6.0.0: ED3 `lines.trimStart(scrollBackSize)`, `ydisp = max(ydisp - size, 0)`, fires scroll => viewport lands at top / history destroyed [V InputHandler.ts:1248-1257]. ED2 without `scrollOnEraseInDisplay` just blanks viewport rows (no history lost) [V:1239-1246].
- Same wipe happens in daemon (alacritty clears history on ED3) [I, not verified], so daemon snapshots lose history too.
- Windows ConPTY adds its own repaint/coalescing artefacts; Claude docs mention stale text on ConPTY and `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` (auto-on for background sessions on Windows) [D fullscreen page].

### 3.2 What vendors recommend (ranked)
1. `/tui fullscreen` or `CLAUDE_CODE_NO_FLICKER=1`: alt screen, only visible messages in render tree, flat memory, in-app mouse scroll, in-app selection, jump-to-bottom button [D fullscreen page]. Default for new installs since 2026-05-06 (non-Bedrock/Vertex/Foundry) [D].
2. `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` if flicker only and terminal supports 2026 but not detected [D terminal-config].
3. `CLAUDE_CODE_DISABLE_MOUSE=1` keeps fullscreen but native selection; scroll PgUp/PgDn/Ctrl+Home/Ctrl+End [D].
4. `CLAUDE_CODE_SCROLL_SPEED` (1-20 or fractional), `/scroll-speed`, `wheelScrollAccelerationEnabled=false` [D]. VS Code terminal sends 1 event per notch so feels slow; xterm.js in Erka behaves likewise.
5. `/tui default` or `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` to return to native scrollback [D].
6. `/clear` shrinks the redraw region so jumping stops until session regrows [C]; `/compact` equivalent. `Ctrl+L` redraws without losing conversation [D].
7. Ctrl+O transcript mode: less-style nav/search inside the app; `[` dumps the whole conversation into native scrollback (so Erka's search/scroll tools work), `v` opens $EDITOR [D].
8. VS Code: `/terminal-setup` sets `terminal.integrated.gpuAcceleration: off` + `mouseWheelScrollSensitivity` [D terminal-config]. Not applicable to Erka but shows xterm.js WebGL + Claude garbled-text history; watch for it.

### 3.3 Fullscreen consequences in Erka
- Alt buffer = xterm has no scrollback for that view; Erka's search/scroll-to-line/markers do nothing there [D typings: decorations undefined in alt].
- Wheel must reach the app: xterm forwards wheel as mouse events when app enabled mouse tracking; otherwise converts to arrows in alt buffer. 6.0 fixed page-scroll bleed in alt buffer without mouse events (#5437) [D]. Test: wheel, PgUp/PgDn (Erka must not intercept), Shift+wheel for native selection override (xterm: Shift bypasses mouse tracking on Windows/Linux; Option on mac with `macOptionClickForcesSelection`).
- Known pain: VS Code reports wheel stalls/drops frames in fullscreen mode [C: https://claudeissues.com/issue/60789...]; wheel-event flood to PTY. Mitigation [I]: coalesce wheel events per animation frame before `sendInput`; keep daemon->UI backpressure (Erka has credit system).
- Daemon snapshot of alt screen is just the current screen => cheap re-attach. Fullscreen sessions make "10k-100k lines" irrelevant for memory/switch cost (renders only visible). This is the strongest argument for default-on.
- `Conversation compacted` row bounds scroll-up after resume; older messages remain in transcript file [D].

## 4. Fast pane/tab switching

### 4.1 Patterns observed
| pattern | who | note |
|---|---|---|
| Keep emulator alive, hide DOM | VS Code (terminals stay mounted per group), Erka, Tabby | fastest switch; cost = RAM + parse of background output |
| Headless emulator in daemon + serialize on attach | Superset, Orca (daemon owns PTY, warm re-attach, "WebGL panes repaint cleanly on reattach" 1.3.32), Erka | Superset: active terminal hydrates first, background tabs hydrate gradually via priority semaphore; separate RPC vs output sockets to avoid head-of-line blocking; backpressure PTY->UI |
| Dispose + restore from snapshot | Orca session restore (https://www.onorca.dev/docs/model/session-restore), VS Code revive | slow-ish, bounded memory |
| One shared WebGL context | not provided by xterm; each Terminal has own context (atlas not shared) [I] | hence 16 cap |
Superset: https://superset.sh/blog/terminal-daemon-deep-dive (vendor blog; no scrollback/WebGL numbers published).

### 4.2 Erka current policy (verified) and gaps
- MAX_PARKED=16 views; 6 hidden keep WebGL; parked views detach from daemon stream (no parse cost) and delta-replay on return (`REPLAY_LIMIT` 256 KB ring) [V].
- Gap A: evicted/stale view (delta too old, or after any `resize` -> `replay_floor`) falls to `snapshot(2000)` [V session.rs:406-413]. A 50k-line view comes back with only 2000 lines of history. Decide: acceptable, or raise (cost = serialize + base64 + xterm parse; est. 2000 lines ~ few ms) [I]. Make `SNAPSHOT_HISTORY` follow user scrollback setting but cap at e.g. 10k, and stream large snapshot in chunks (`term.write` callback) so UI thread stays responsive.
- Gap B: detached view with huge buffer: `reset` path calls `term.reset()` + rewrite; for 10k+ lines parse of several MB blocks main thread (xterm parses in 12 ms slices to keep UI alive, still janky) [I]. Show active pane first (already), then fill history lazily: write screen first, then prepend history is not possible in xterm (append-only) => alternative is just keep stale-but-intact buffer (current) and only `reset` when truly necessary.
- Gap C: Switching UX features: MRU Ctrl+Tab (VS Code/Windows Terminal style: hold Ctrl, cycle in recency order, release to commit), quick switcher (Ctrl+P/palette with fuzzy match over session title + last output line + agent state), directional pane focus (Alt+Arrow like WT `moveFocus` / tmux). Erka has a palette and inbox [V file names]; whether MRU and directional exist was not verified.
- Gap D: preview on hover/switch: since parked views keep their buffer, show last screen instantly then catch up via delta (already the design).

## 5. Prioritized recommendations for Erka

P0 (do first, highest impact/cost ratio)
1. Launch agent sessions with Claude fullscreen: set env `CLAUDE_CODE_NO_FLICKER=1` in erkad spawn for kind=claude (opt-out setting). Also set `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` as belt (harmless; xterm 6 supports 2026). Verify daemon passes through/handles 2026 and that env isn't stripped by the CLAUDE_CODE_* scrub list in main.rs:88-97 (inspect it - that list sanitizes inherited vars; make sure new vars are set after scrub).
2. Classic-mode jump fix in `TermView` ctor: `term.parser.registerCsiHandler({final:'J'}, p => p.params[0]===3)` returns true to swallow ED3 only when it follows/precedes ED2 in the same write (or always for agent sessions). Preserve user scroll: before write, record `buffer.active.viewportY === baseY` (following) else keep `ydisp`; xterm already keeps it when not at bottom except the ED3 case. Evaluate `scrollOnEraseInDisplay:true` in classic mode so ED2 redraws push old frame to scrollback (duplicates history, so test).
3. "Scroll to bottom" floating button + "N new lines" counter: `onScroll`/`onWriteParsed` + `buffer.active.viewportY < baseY`; `scrollToBottom()`. Matches Claude fullscreen and every competitor.
4. Wheel tuning: expose `scrollSensitivity` setting (default 1, range 0.25-10); coalesce wheel-to-PTY in alt-screen; do not intercept PgUp/PgDn/Home/End/Ctrl+Home/End when focused terminal is in alt buffer (`buffer.active.type === 'alternate'`); Shift+wheel = native passthrough.

P1
5. Scrollback budget: default 10k, UI shows "~14 MB at 120 cols"; global budget (sum of cols x scrollback x 12 B across live views) evicts parked views first. 100k only on explicit opt-in.
6. Prompt/command navigation: register OSC 133/633 handlers (`parser.registerOscHandler`), create `registerMarker` + `registerDecoration` (overviewRulerOptions) for A/D marks with exit-code color; bind Ctrl+Up/Down (when not alt-buffer; same as WT/VS Code) to `scrollToLine(prev/next marker.line)`. For agent TUIs add user-submit markers (Enter in `onData`) as in 2.2.
7. Raise cold-attach history: make `SNAPSHOT_HISTORY` = min(user scrollback, 10k); chunked write.
8. Search upgrade: addon-search with `decorations` (overview ruler ticks) + result count; remind users that in fullscreen Claude, search = Ctrl+O then `/`. Provide Erka menu action "Dump Claude transcript to scrollback" = send Ctrl+O then `[`.

P2
9. MRU tab switch (Ctrl+Tab hold-to-cycle) + palette fuzzy over sessions; directional pane focus (Alt+Arrow).
10. Sticky header overlay for last prompt/command (DIY from markers).
11. Fit only on pointer-up during splitter drag; skip hidden; already debounced 40 ms.
12. Optional: idle serialize of evicted view is NOT needed (daemon owns truth).

Do NOT do
- `smoothScrollDuration > 0` for wheel (adds lag; 6.0 only fixed multi-run per frame).
- Using removed `fastScrollModifier`/`windowsMode`/canvas addon (6.0 breaking).
- Virtualized/own scrollback renderer: out of scope, xterm already virtualizes viewport; cost is memory not paint.
- Per-keystroke serialize.

## 6. Adoption-risk table
| item | maturity | risk |
|---|---|---|
| xterm.js 6.0 sync output, new scrollbar | released Dec (2025 [I]), 1 major; scroll code rewritten | medium: pin version, run wheel/alt-buffer tests; watch 6.0.x fixes (check changelog; I only saw 6.0.0 notes) |
| Claude fullscreen | "research preview" but default for new users | medium: mouse capture friction, ConPTY stale text -> `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` |
| OSC 133/633 | stable in VS Code/WT/iTerm2 | low tech risk, high effort for shell injection on Windows |
| Swallow ED3 | local patch | low; may leave stale history if app truly wants clear (`/clear`) - scope to agent kinds |
| Serialize addon | experimental | skip |

## 7. Limitations
- No profiling done; reflow/switch cost numbers for 100k lines are inference. Recommend a benchmark (erkad `bench.rs` already measures attach latency) at 10k/50k/100k x 120/200 cols.
- Claude Code root-cause claims on ED2/ED3 come from user issues, not Anthropic; fix versions unknown (several issues closed as duplicates).
- Wave Terminal, Tabby, Conductor internals: no authoritative public docs found; Superset/Orca claims are vendor-reported. Ghostty/WezTerm prompt-jump docs not confirmed on fetched pages.
- 6.0.x patch release notes after 6.0.0 not read.

## 8. Unresolved questions
1. Does Claude's 2026 probe succeed through Erka (xterm DECRQM reply vs `isTerminalReply` suppression, ConPTY)? Test by checking whether Claude emits BSU/ESU (`ESC[?2026h`) in a captured stream.
2. Does alacritty_terminal in erkad honor CSI 2026 and does ED3 wipe daemon history? (Both affect snapshot correctness.)
3. Does erkad set `CLAUDE_CODE_NO_FLICKER`/`tui` today, and do users' `~/.claude/settings.json` already select fullscreen (then P0.1 is partly moot)?
4. Should ED3 swallowing apply to shell panes (users expect `clear` to wipe scrollback)? Proposed: agent kinds only.
5. Actual reflow time of xterm 6.0 at 50k-100k lines, 120-200 cols on target hardware?
6. MRU/directional-focus status in Erka keymap not verified.

## Sources
- https://code.claude.com/docs/en/fullscreen
- https://code.claude.com/docs/en/terminal-config
- https://claudeissues.com/issue/35580-root-cause-fix-for-scroll-jumping-on-long-responses-csi-2j-inside-dec-2026-sync
- https://claudeissues.com/issue/36582-terminal-keeps-scrolling-to-top-when-conversation-gets-long
- https://claudeissues.com/issue/60789-bug-fullscreen-rendering-mouse-wheel-scrolling-stalls-drops-frames-in-vs-code-in
- https://github.com/xtermjs/xterm.js/releases (6.0.0)
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/typings/xterm.d.ts
- https://github.com/xtermjs/xterm.js/issues/791 ; /issues/880
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-webgl/README.md
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/README.md
- https://webkit.googlesource.com/WebKit/+/70e10861eb2fbd9d0862fd8702874c25ae5d8bfd
- https://code.visualstudio.com/docs/terminal/shell-integration ; /docs/terminal/advanced
- https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration
- https://iterm2.com/documentation-escape-codes.html
- https://docs.warp.dev/terminal/blocks/block-basics
- https://ghostty.org/docs/config/reference ; https://wezterm.org/config/lua/config/scrollback_lines.html ; https://zed.dev/docs/terminal
- https://github.com/alacritty/alacritty/blob/master/CHANGELOG.md
- https://superset.sh/blog/terminal-daemon-deep-dive ; https://www.onorca.dev/docs/model/session-restore
- Local verified: D:/Works/Erka/app/src/lib/terminal-host.ts ; D:/Works/Erka/crates/erkad/src/session.rs ; xterm 6.0.0 sources under D:/Works/Erka/app/node_modules/.pnpm/@xterm+xterm@6.0.0
