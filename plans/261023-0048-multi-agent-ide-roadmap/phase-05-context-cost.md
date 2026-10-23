---
phase: 5
title: "Context, tokens & cost"
status: pending
priority: P1
effort: "3d"
dependencies: [4]
---

# Phase 5: Context, tokens & cost

## Overview
Per session: context fill, tokens, estimated cost; aggregates per day/project/agent; optional per-session cost cap.
Sources: ACP `usage_update` (chat), transcripts for Claude/Codex/OMP terminals. **No number without an exact source.**

## Requirements
- Ring on tab + sidebar (amber ≥ 70 %, red ≥ 85 %); tooltip numbers; one-time hint at 85 %: Compact / Hand off.
- Usage page: cost by day / week / project / agent / model from the history scan cache.
- Cost cap (off by default): over cap → red chip + inbox; optional Esc only when the transcript belongs to that exact session.
- Mapping strictly by identity [RT-8]: Claude via `transcript_path` from hook payload (or `spec.agent_session_id`); Codex via stored `thread-id` (`daemon.rs:648`) → rollout file;
  ACP via adapter. No "newest file in folder" fallback; no id → no ring, no actions.

## Architecture
- Daemon broadcasts `session.turn {session, event, transcript_path?, agent_session_id?}` from `hook()` and on status turn-end [RT-8] (capability: app subscribers; API_LEVEL bump).
- App core `session_usage.rs` tails from the **end** of the file (reverse scan for the last usage record; `.zst` excluded — live transcripts are plain), debounced 1 s,
  only for visible or working sessions.
- Codex rollout resolver keyed by thread id. Prices: bundled `pricing.json`. Aggregates cached per file by (mtime, len).

## Related Code Files
- Create: `app/src-tauri/src/session_usage.rs`, `app/src-tauri/src/pricing.json`, `app/src/components/context-ring.tsx`, `app/src/components/cost-page.tsx`.
- Modify: `crates/kelpied/src/daemon.rs` (`session.turn` broadcast), `crates/kelpie-proto/src/lib.rs`, `app/src-tauri/src/agent_history.rs` (Codex rollout resolver, per-file usage cache),
  `app/src-tauri/src/lib.rs`, `app/src/lib/store.ts`, `app/src/components/sidebar.tsx`, `app/src/components/split-view.tsx`, `app/src/components/usage-meter.tsx`,
  `app/src/chat/acp-adapter.ts`, `app/src/lib/types.ts`, settings catalog, locales, docs.

## Implementation Steps
1. `session.turn` broadcast. 2. Parsers + reverse tail + fixtures. 3. Codex resolver. 4. Ring + hint. 5. Aggregation page. 6. Cost cap.

## Tests
- `cargo test`: parsers (Claude cache tokens, Codex token_count, malformed, truncated last line), reverse tail, two Claude sessions in one folder map to their own transcripts.
- e2e `context_cost.py`: fixture transcripts appended live → ring/$ match; session without id shows no ring; cap → inbox.

## Perf gate
- 20 visible sessions: app core CPU +≤ 0.5 pt; ≤ 64 KB read per update; warm aggregation ≤ 100 ms; cost page lazy.

## Success Criteria
- [ ] Numbers equal fixture truth; never shown or acted on without exact mapping.

## Risk Assessment
- Format drift → parser returns None → ring hidden; parse-failure counter per agent in logs.
