# Research: integrations, accounts, resume flags, i18n

Date 2026-10-21. Sources: official docs/schemas (Linear schema.graphql, Jira v3 OpenAPI, GitLab
docs), live checks (GitLab unauthenticated; local claude 2.1.304, codex 0.158.0).

## Linear
- `POST https://api.linear.app/graphql`; personal key: `Authorization: <KEY>` (no Bearer). Errors may be HTTP 200/400 → always check `errors[]`; rate limit = 400 with `extensions.code=RATELIMITED`.
- Limits: 2500 req/h, 3M complexity/h, 10k/query; `searchIssues` 30/min.
- Paging: `first/after`, `pageInfo{hasNextPage endCursor}`, `orderBy: updatedAt`.
- Issue fields: `id identifier title url description branchName priority priorityLabel state{id name type} team{id key}`. `branchName` is a suggestion, not an existing branch.
- Open = `state.type nin ["completed","canceled"]` (also skip `duplicate`).
- Assigned: `viewer{assignedIssues(first:50, orderBy:updatedAt, filter:{state:{type:{nin:[...]}}}){nodes{...}}}`.
- Search: `searchIssues(term:$q, first:20){nodes{...}}` (`issueSearch` deprecated).
- One issue: `issue(id:"ENG-123")`. States: `workflowStates(filter:{team:{key:{eq:"ENG"}}}){nodes{id name type position}}`; update: `issueUpdate(id, input:{stateId}){success}`.

## Jira Cloud
- Auth Basic `base64(email:api_token)` on `https://<site>.atlassian.net`; Server/DC: `Bearer <PAT>`, v2 API, `/rest/api/2/search` with startAt.
- Search: `GET/POST /rest/api/3/search/jql` (old `/search` removed): `jql` must be bounded (`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`), `nextPageToken`, `maxResults`, `fields=summary,status,description,priority,issuetype,assignee,project,updated`. No total; stop when no `nextPageToken`.
- `GET /rest/api/3/myself` = credential check. Browse URL `<base>/browse/<KEY>`.
- Description = ADF: walk tree (text, hardBreak, paragraph/heading/list/codeBlock, mention/emoji attrs.text, inlineCard attrs.url).
- Transitions: `GET /rest/api/3/issue/{key}/transitions` → `{transitions:[{id,name,to:{name,statusCategory}}]}`; `POST` `{"transition":{"id":"31"}}` → 204.

## GitLab v4
- `PRIVATE-TOKEN: <pat>` (scopes `api` / `read_api`); base `https://<host>/api/v4`; project id = URL-encoded path `group%2Fsub%2Fproj` (unencoded → 404).
- MRs for branch: `GET /projects/:id/merge_requests?source_branch=<b>&state=opened|all` (list has `head_pipeline=null`); single MR `GET .../merge_requests/:iid` has `head_pipeline{status,web_url}`, `detailed_merge_status`.
- Pipeline status values: created, waiting_for_resource, preparing, pending, running, success, failed, canceled, skipped, manual, scheduled.
- Create MR: `POST /projects/:id/merge_requests` {source_branch,target_branch,title,description,remove_source_branch}; draft = title prefix `Draft: `; 409 = exists.
- Unauthenticated on gitlab.com works for public project/MR/pipeline reads (tested on `gitlab-org/cli`); writes and `/user` → 401.

## Accounts
- Claude: `CLAUDE_CONFIG_DIR=<abs dir>` holds settings, `projects/`, `.credentials.json` (Win/Linux) and `.claude.json` (verified). macOS keychain service `Claude Code-credentials-<first 8 hex of sha256(dir)>` (third-party; test on Mac). `claude auth login|status|logout`; `auth status` JSON, exit 0 logged in / 1 not. Keep `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` out of the env (they override).
- Codex: `CODEX_HOME` (verified); `auth.json` {auth_mode, tokens{access_token, account_id,…}}; set `cli_auth_credentials_store = "file"` in the profile's `config.toml`; `codex login`, `codex login status` (exit 0), `codex logout`.
- Usage: Claude `GET https://api.anthropic.com/api/oauth/usage` (Bearer access token, `anthropic-beta: oauth-2025-04-20`); Codex `GET https://chatgpt.com/backend-api/wham/usage` (Bearer + `ChatGPT-Account-Id`). Per profile: read that profile's credential file.
- Transcripts per profile: `<config>/projects/…`, `$CODEX_HOME/sessions/…`. Do not share across profiles.
- Orca: per-account home dirs + pointer swap of the active account; running sessions keep theirs.

## Resume flags (latest / by id)
claude `-c` / `-r <id>` (`--session-id` pre-assigns) · codex `resume --last` (cwd-scoped) / `resume <id>` · gemini `--resume` · opencode `-c` / `-s <id>` · cursor `--continue` / `--resume <id>` · copilot `--continue` / `--resume <id>` · qwen `--continue` · goose `session -r` · crush `-C` / `-s <id>` · kimi `-C` / `-S <id>` · pi `--continue` (verified locally) · aider `--restore-chat-history` · cline `--id <id>` only.

## SolidJS i18n
`@solid-primitives/i18n` 2.2.1 (ESM): `flatten`, `translator(dict, resolveTemplate)`; typed dict `type Dict = typeof en`; lazy locales via `import.meta.glob`; Intl formatters per locale.

## Unresolved
- Linear `issueUpdate(id:"ENG-123")` vs UUID; Jira scoped-token URL; macOS keychain hash for Claude; Codex keyring key derivation.
