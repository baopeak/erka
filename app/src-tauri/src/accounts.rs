//! Several Claude Code / Codex sign-ins side by side. Each extra account is its own config
//! home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) under `<data>/accounts/<agent>/<id>`; sessions
//! started on an account get that variable, so credentials, settings and transcripts never
//! mix and switching the active account is only a pointer change in the UI. Credentials are
//! read here only to say whether an account is signed in and as whom — never returned.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;

use crate::fs_ops::{err, CmdResult};

/// Marks a folder Kelpie created, so removal never touches anything else.
const MARKER: &str = ".kelpie-account";

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

fn valid_agent(agent: &str) -> CmdResult<()> {
    if matches!(agent, "claude" | "codex") { Ok(()) } else { Err(format!("accounts are not supported for {agent}")) }
}

fn valid_id(id: &str) -> CmdResult<()> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("invalid account id".into())
    }
}

fn account_dir(agent: &str, id: &str) -> PathBuf {
    let dir = kelpie_proto::data_dir().join("accounts").join(agent).join(id);
    // One separator style: the data dir may come with forward slashes (KELPIE_DATA_DIR).
    if cfg!(windows) { PathBuf::from(dir.to_string_lossy().replace('/', "\\")) } else { dir }
}

/// The agent's own default home, used by the "Default" account.
fn default_home(agent: &str) -> PathBuf {
    match agent {
        "claude" => std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude")),
        _ => std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex")),
    }
}

/// Makes `CODEX_HOME/config.toml` keep the login in `auth.json` (not the OS keyring), so the
/// usage meter and the status check can read it, keeping every other setting.
fn codex_file_store(config: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut set = false;
    let mut in_table = false;
    for line in config.lines() {
        let t = line.trim_start();
        if t.starts_with('[') {
            if !set {
                out.push("cli_auth_credentials_store = \"file\"".into());
                set = true;
            }
            in_table = true;
        }
        if !in_table && t.starts_with("cli_auth_credentials_store") {
            if !set {
                out.push("cli_auth_credentials_store = \"file\"".into());
                set = true;
            }
            continue;
        }
        out.push(line.to_string());
    }
    if !set {
        out.push("cli_auth_credentials_store = \"file\"".into());
    }
    out.join("\n") + "\n"
}

/// Creates (or re-seeds) an account home. Settings come from the default account so the
/// agent behaves the same; logins and history do not.
fn create_blocking(agent: &str, id: &str) -> CmdResult<String> {
    valid_agent(agent)?;
    valid_id(id)?;
    let dir = account_dir(agent, id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    std::fs::write(dir.join(MARKER), format!("{agent}\n")).map_err(err)?;
    let src = default_home(agent);
    match agent {
        "claude" => {
            for name in ["settings.json", "CLAUDE.md"] {
                let (from, to) = (src.join(name), dir.join(name));
                if from.is_file() && !to.exists() {
                    std::fs::copy(&from, &to).map_err(err)?;
                }
            }
        }
        _ => {
            let to = dir.join("config.toml");
            let base = std::fs::read_to_string(if to.exists() { to.clone() } else { src.join("config.toml") }).unwrap_or_default();
            std::fs::write(&to, codex_file_store(&base)).map_err(err)?;
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn account_create(agent: String, id: String) -> CmdResult<String> {
    crate::fs_ops::blocking(move || create_blocking(&agent, &id)).await
}

/// Moves a Kelpie-created account home to the trash (logins and history with it).
#[tauri::command]
pub async fn account_remove(agent: String, id: String) -> CmdResult<()> {
    crate::fs_ops::blocking(move || {
        valid_agent(&agent)?;
        valid_id(&id)?;
        let dir = account_dir(&agent, &id);
        if !dir.exists() {
            return Ok(());
        }
        // `.erka-account`: created before the rename (the data migration renames it, but a
        // folder it could not reach still counts).
        if !dir.join(MARKER).is_file() && !dir.join(".erka-account").is_file() {
            return Err("not a Kelpie account folder".into());
        }
        trash::delete(&dir).or_else(|_| std::fs::remove_dir_all(&dir)).map_err(err)
    })
    .await
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct AccountStatus {
    signed_in: bool,
    email: Option<String>,
    /// Subscription or auth kind ("max", "pro", "plus", "api key"…).
    plan: Option<String>,
    /// The config home in use (for display).
    home: String,
}

/// Claims of a JWT, without verifying it (only to show which account this is).
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn claude_status(dir: &Path) -> AccountStatus {
    let creds = read_json(&dir.join(".credentials.json")).or_else(|| crate::usage::claude_keychain_json(dir));
    let oauth = creds.as_ref().map(|c| &c["claudeAiOauth"]);
    let signed_in = oauth.and_then(|o| o["accessToken"].as_str()).is_some_and(|t| !t.is_empty())
        || oauth.and_then(|o| o["refreshToken"].as_str()).is_some_and(|t| !t.is_empty());
    // `.claude.json` sits in the config dir when CLAUDE_CONFIG_DIR is set, else in the home.
    let profile = read_json(&dir.join(".claude.json")).or_else(|| (dir == default_home("claude")).then(|| read_json(&home().join(".claude.json"))).flatten());
    let email = profile.as_ref().and_then(|p| p["oauthAccount"]["emailAddress"].as_str()).map(str::to_string);
    let plan = oauth.and_then(|o| o["subscriptionType"].as_str()).map(str::to_string);
    AccountStatus { signed_in, email: email.filter(|_| signed_in), plan, home: dir.to_string_lossy().into_owned() }
}

fn codex_status(dir: &Path) -> AccountStatus {
    let auth = read_json(&dir.join("auth.json"));
    let tokens = auth.as_ref().map(|a| &a["tokens"]);
    let oauth = tokens.and_then(|t| t["access_token"].as_str()).is_some_and(|t| !t.is_empty());
    let api_key = auth.as_ref().and_then(|a| a["OPENAI_API_KEY"].as_str()).is_some_and(|k| !k.is_empty());
    let claims = tokens.and_then(|t| t["id_token"].as_str()).and_then(jwt_claims);
    let email = claims.as_ref().and_then(|c| c["email"].as_str()).map(str::to_string);
    let plan = claims
        .as_ref()
        .and_then(|c| c["https://api.openai.com/auth"]["chatgpt_plan_type"].as_str())
        .map(str::to_string)
        .or_else(|| (api_key && !oauth).then(|| "api key".to_string()));
    AccountStatus { signed_in: oauth || api_key, email, plan, home: dir.to_string_lossy().into_owned() }
}

/// Whether the account (`dir` = its home; none = the agent's default) is signed in.
#[tauri::command]
pub async fn account_status(agent: String, dir: Option<String>) -> CmdResult<AccountStatus> {
    crate::fs_ops::blocking(move || {
        valid_agent(&agent)?;
        let dir = dir.filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(|| default_home(&agent));
        Ok(if agent == "claude" { claude_status(&dir) } else { codex_status(&dir) })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_config_keeps_settings_and_stores_login_in_a_file() {
        assert_eq!(codex_file_store(""), "cli_auth_credentials_store = \"file\"\n");
        let cfg = "model = \"gpt-5\"\ncli_auth_credentials_store = \"keyring\"\n[mcp_servers.x]\ncommand = \"y\"\n";
        let out = codex_file_store(cfg);
        assert_eq!(out, "model = \"gpt-5\"\ncli_auth_credentials_store = \"file\"\n[mcp_servers.x]\ncommand = \"y\"\n");
        // A key of the same name inside a table is not the top-level one.
        let out = codex_file_store("[profiles.a]\ncli_auth_credentials_store = \"x\"\n");
        assert!(out.starts_with("cli_auth_credentials_store = \"file\"\n[profiles.a]\ncli_auth_credentials_store = \"x\""));
    }

    #[test]
    fn reads_status_without_exposing_tokens() {
        let dir = std::env::temp_dir().join(format!("kelpie-acct-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!claude_status(&dir).signed_in);
        std::fs::write(dir.join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"t","subscriptionType":"max"}}"#).unwrap();
        std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"a@b.c"}}"#).unwrap();
        let s = claude_status(&dir);
        assert!(s.signed_in);
        assert_eq!(s.email.as_deref(), Some("a@b.c"));
        assert_eq!(s.plan.as_deref(), Some("max"));
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"email":"x@y.z","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#);
        std::fs::write(dir.join("auth.json"), format!(r#"{{"tokens":{{"access_token":"t","id_token":"h.{claims}.s"}}}}"#)).unwrap();
        let s = codex_status(&dir);
        assert!(s.signed_in);
        assert_eq!((s.email.as_deref(), s.plan.as_deref()), (Some("x@y.z"), Some("plus")));
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("\"t\""));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(valid_id("a-1_b").is_ok());
        for bad in ["", "..", "a/b", "a\\b", "a b"] {
            assert!(valid_id(bad).is_err(), "{bad}");
        }
    }
}
