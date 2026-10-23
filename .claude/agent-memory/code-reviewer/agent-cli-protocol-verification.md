---
name: agent-cli-protocol-verification
description: How to fact-check chat-view adapter assumptions against the installed claude/codex CLIs (schema dump, binary grep, live initialize probe)
metadata:
  type: reference
---

Chat adapters (app/src/chat/*-adapter.ts) encode wire shapes of external CLIs; verify them against the installed binaries rather than trusting comments.

- Codex: `codex app-server generate-json-schema --out <scratchpad dir>` then read `codex_app_server_protocol.v2.schemas.json` (definitions: TurnStartParams, ThreadShellCommandParams, ReviewTarget, SandboxPolicy, UserInput incl. `skill`). Fast, offline.
- Claude Code (native claude.exe, ~300 MB Bun bundle at ~/.local/bin): grep is too slow; use Python `mmap` + `find(b'q.request.subtype==="set_model"')` to read control handlers. set_model replies `{model}`, set_permission_mode replies `{mode}`.
- Live probe (no API call): pipe one `{"type":"control_request","request_id":"x","request":{"subtype":"initialize"}}` into `claude -p --input-format stream-json --output-format stream-json --verbose` with `env -u CLAUDE_CODE_ENTRYPOINT -u CLAUDECODE`. On 2.1.308 (2026-10-23) initialize answered commands/models/current_permission_mode WITHOUT the sdk-ts entrypoint.
- Sending `initialize` twice to one claude process (new ChatController re-attach) answers success both times (2.1.308).
- Codex 0.163 facts: `thread/shellCommand` runs UNSANDBOXED with full access; Thread{Start,Resume}Response.sandbox is a full SandboxPolicy (networkAccess, writableRoots) and approvalPolicy may be `untrusted`/granular — coarse presets lose those.
- Schema dumps go to the scratchpad; C: was 100% full on 2026-10-23, delete dumps after use.
- `CLAUDE_CODE_ENTRYPOINT=sdk-ts` changes client attribution (claude_code_sdk / sdk-typescript UA) and drops a tool from the toolset — flag any use of it.

Related: [[shell-hook-blocked-words]]
