---
phase: 3
title: "Attention queue & quick answer"
status: pending
priority: P1
effort: "3d"
dependencies: [1]
---

# Phase 3: Attention queue & quick answer

## Overview
The dashboard already groups Needs you / Working / Done·unread / Idle (`dashboard.tsx:10-13`) [RT-6]. This phase adds what is missing:
a reliable "needs you" signal for agents without hooks, a Failed group, wait-time ordering, a next-waiting jump and a quick-answer popover.

## Requirements
- **Waiting for hook-less agents** [RT-9]: daemon runs `detect_choices(screen_tail)` (Rust) when a session goes quiet after output; a match sets `Waiting`
  for agents without hooks (Codex approvals, Gemini, OpenCode, Cursor, Copilot, Aider…). Per-vendor fixtures; Claude keeps hook-based status.
- `Activity.waiting_since` tracked in the daemon; dashboard orders Needs you oldest first; adds **Failed** group.
- `Ctrl+Shift+.` / palette: jump to next needs-you session (cycles; toast when none).
- **Quick answer** popover (dashboard row, inbox item, sidebar hover): last 12 lines (ANSI stripped) + detected buttons + free text.
  Sends through `sendToSession` (Codex Enter-delay handled) [RT-9]; daemon `session.answer {handle, generation, expect:"waiting", data}` refuses if the session
  is no longer waiting or the generation changed (prevents phone/desktop double answers).
- Bell [user decision]: keep the unread-inbox count; add a separate accent dot/ring when ≥ 1 session needs you; tooltip shows both counts.

## Architecture
`detect_choices` lives in the daemon (shared with the phone page later); status flows through the existing 250 ms ticker; popover reads `session.read {lines:12}` on open only.

## Related Code Files
- Create: `crates/kelpied/src/choices.rs`, `app/src/components/quick-answer.tsx`.
- Modify: `crates/kelpied/src/status.rs` (waiting_since, screen-based Waiting), `crates/kelpied/src/session.rs`, `crates/kelpied/src/daemon.rs` (`session.answer`, capability `app`, API_LEVEL),
  `app/src/components/dashboard.tsx`, `app/src/components/inbox.tsx`, `app/src/components/sidebar.tsx`, `app/src/components/status-bar.tsx` (needs-you dot),
  `app/src/lib/commands.ts`, `app/src/lib/send-to-agent.ts`, `app/src/lib/types.ts`, locales, docs.

## Implementation Steps
1. `choices.rs` + fixtures (Claude, Codex approval, Gemini, Aider y/n, OpenCode, generic numbered menu, normal output negatives).
2. Screen-based Waiting + `waiting_since`. 3. `session.answer`. 4. Dashboard order + Failed + virtualization above 50 rows. 5. Popover, shortcut, bell dot.

## Tests
- `cargo test`: ≥ 20 screen fixtures, 0 false positives on normal-output fixtures; `session.answer` refuses stale generation.
- e2e `attention.py`: PowerShell sessions running `Read-Host "Continue (y/n)"` plus a scripted fake agent printing an approval menu → grouped and ordered correctly;
  next-waiting cycles; quick answer reaches the right session; double answer refused; bell shows unread count + dot.

## Perf gate
- Detection runs only on quiet-after-output transitions (≤ 0.2 ms per check); no new timers; popover lazy; dashboard 50 sessions ≤ 16 ms per tick.

## Success Criteria
- [ ] Codex/Gemini approval prompts appear under Needs you without hooks.
- [ ] Answer from anywhere in ≤ 2 keystrokes; stale answers never land.

## Risk Assessment
- False Waiting on output that looks like a menu → fixtures per vendor, quiet-time threshold; signal: user "dismiss" count; response: tighten patterns.
