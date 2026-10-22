# Orca implementation study (deferred features)

Source: `D:/Works/orca-ref/orca` @ d406e0c8. Read-only scouting; some areas only partly traced.

| Feature | Orca's approach | Worth copying |
|---|---|---|
| Browser / design mode | Toolbar toggle → picker; click sends one attachment. Payload `{page, target, nearbyText[], ancestorPath[], screenshot}`; target: tag, selector, path, classes, text/html snippets, allowlisted attributes, a11y, rects, 16 computed styles. Budgets: html 4096, text 200, selector 700, nearby 10×200, ancestors 10, screenshot 2 MiB. Secret-looking values redacted. Annotations (comment, intent, priority) rendered to markdown. | allowlist, redaction, budgets; capture in page JS, screenshot natively |
| SSH | `SshTarget` {host, port, user, identityFile, proxy/jump, source manual\|ssh-config}; ssh2 or system OpenSSH; TOFU host keys; remote Node daemon (orcad) leases PTYs on the host; SFTP; port forwarding. | target schema incl. `ssh -G` resolution; PTYs survive on host |
| Mobile | Pairing offer (endpoint ws://host:6768, device token, public key) as QR/deeplink; LAN/Tailscale or cloud relay; per-device revocable token; custom E2EE. Phone: worktrees, terminal/chat, reply, quick commands, git, notifications. | per-device revocable token; LAN-first |
| Linear / Jira / GitLab | Linear API key (encrypted file), list/detail/create/update status, issue → worktree with Linear branch name, issue text into prompt. Jira sites + tokens (Basic/Bearer). GitLab via `glab`. | issue → worktree + prompt |
| Plugins | `orca-plugin.json` manifest, capabilities with consent (`workspace:read`, `terminal:send`, `notifications:show`, `storage`, …), out-of-process Node worker. | capability list + consent |
| Voice | sherpa-onnx native addon in a worker; model catalog (parakeet, zipformer, whisper-tiny, SenseVoice) from HuggingFace with sha256; optional OpenAI transcription. | sherpa-onnx + downloadable models with hashes |
| i18n | i18next; en, zh, ko, ja, es, fr; lazy catalogs; pseudo-locale. | lazy catalogs |
| Accounts | Codex: `{userData}/codex-accounts/<id>/home` + `CODEX_HOME`; Claude: `claude-profiles/<id>/home` + `CLAUDE_CONFIG_DIR`; active account pointer; running sessions keep theirs. | exactly this |
| Orchestration | Run, Task (pending/ready/dispatched/completed/failed/blocked, deps), Dispatch, Message (status, worker_done, escalation, decision_gate, question…), decision gates; CLI `orca orchestration run-create / task-create / worker-start / check --wait / send --type worker_done`. | task state machine, worker report via CLI, gates |
| Layouts | Binary split tree only; no grid presets or saved layouts. | (Erka goes further) |
| Session restore | Daemon survives app quit, not reboot; after reboot a manual Resume from session history. Resume argv table per agent (claude `--resume`, codex `resume`, opencode `--session`, copilot `--resume=`, kimi `--session`, pi `--session <path>`, …). Hibernation auto-resumes on reopen. | resume argv table |
