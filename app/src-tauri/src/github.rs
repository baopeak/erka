//! GitHub pull requests through the user's own `gh` CLI (its sign-in, its host config): the
//! PR of the current branch with its checks, and creating one.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::fs_ops::{guard, CmdResult};

async fn gh(cwd: &Path, args: &[&str]) -> CmdResult<(bool, String, String)> {
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| "gh timed out".to_string())?
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "GitHub CLI (gh) is not installed".to_string() } else { format!("gh: {e}") })?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).trim().to_string()))
}

#[derive(Serialize)]
pub struct PullRequest {
    number: u64,
    title: String,
    url: String,
    /// OPEN | CLOSED | MERGED
    state: String,
    draft: bool,
    base: String,
    /// passing | failing | pending | none
    checks: &'static str,
}

/// Summarises `statusCheckRollup` (check runs and commit statuses).
fn checks_state(rollup: Option<&Value>) -> &'static str {
    let Some(list) = rollup.and_then(Value::as_array).filter(|l| !l.is_empty()) else { return "none" };
    let mut pending = false;
    for c in list {
        let conclusion = c.get("conclusion").and_then(Value::as_str).unwrap_or("");
        let state = c.get("state").and_then(Value::as_str).unwrap_or("");
        let status = c.get("status").and_then(Value::as_str).unwrap_or("");
        if matches!(conclusion, "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE") || matches!(state, "FAILURE" | "ERROR") {
            return "failing";
        }
        if (!status.is_empty() && status != "COMPLETED") || state == "PENDING" || state == "EXPECTED" {
            pending = true;
        }
    }
    if pending { "pending" } else { "passing" }
}

/// The pull request for the checked-out branch; `None` when there is none (or no GitHub remote).
#[tauri::command]
pub async fn gh_pr_status(root: String) -> CmdResult<Option<PullRequest>> {
    let dir = guard(&root, "")?;
    let (ok, out, err) = gh(&dir, &["pr", "view", "--json", "number,title,url,state,isDraft,baseRefName,statusCheckRollup"]).await?;
    if !ok {
        // "no pull requests found" / not a GitHub repo: not an error for a status chip.
        if err.contains("no pull requests found") || err.contains("not a git repository") || err.contains("none of the git remotes") || err.contains("no git remotes") {
            return Ok(None);
        }
        return Err(err);
    }
    let v: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    Ok(Some(PullRequest {
        number: v["number"].as_u64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").into(),
        url: v["url"].as_str().unwrap_or("").into(),
        state: v["state"].as_str().unwrap_or("").into(),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        base: v["baseRefName"].as_str().unwrap_or("").into(),
        checks: checks_state(v.get("statusCheckRollup")),
    }))
}

/// The repository's default branch on GitHub (the usual PR base).
#[tauri::command]
pub async fn gh_default_branch(root: String) -> CmdResult<Option<String>> {
    let dir = guard(&root, "")?;
    let (ok, out, _) = gh(&dir, &["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]).await?;
    Ok(ok.then(|| out.trim().to_string()).filter(|b| !b.is_empty()))
}

/// Creates a PR for the current (already pushed) branch and returns its URL.
#[tauri::command]
pub async fn gh_pr_create(root: String, title: String, body: String, base: String, draft: bool) -> CmdResult<String> {
    let dir = guard(&root, "")?;
    if title.trim().is_empty() {
        return Err("a pull request needs a title".into());
    }
    if base.starts_with('-') {
        return Err("invalid base branch".into());
    }
    let mut args = vec!["pr", "create", "--title", title.trim(), "--body", body.as_str()];
    if !base.trim().is_empty() {
        args.extend(["--base", base.trim()]);
    }
    if draft {
        args.push("--draft");
    }
    let (ok, out, err) = gh(&dir, &args).await?;
    if !ok {
        return Err(err);
    }
    Ok(out.lines().rev().find(|l| l.starts_with("http")).unwrap_or(out.trim()).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summarises_checks() {
        assert_eq!(checks_state(None), "none");
        assert_eq!(checks_state(Some(&json!([{"status": "COMPLETED", "conclusion": "SUCCESS"}]))), "passing");
        assert_eq!(checks_state(Some(&json!([{"status": "IN_PROGRESS", "conclusion": ""}, {"conclusion": "SUCCESS", "status": "COMPLETED"}]))), "pending");
        assert_eq!(checks_state(Some(&json!([{"status": "IN_PROGRESS"}, {"conclusion": "FAILURE", "status": "COMPLETED"}]))), "failing");
        assert_eq!(checks_state(Some(&json!([{"state": "PENDING"}]))), "pending");
    }
}
