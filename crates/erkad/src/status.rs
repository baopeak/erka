//! Agent/session activity state derived from hooks, bells and output activity.
//!
//! Hooks are authoritative when an agent reported one recently; otherwise output activity is
//! used, ignoring echo that directly follows user input.

use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Process alive, no recent output.
    Idle,
    /// Producing output / agent turn in progress.
    Working,
    /// Agent needs the user (permission prompt, question, bell).
    Waiting,
    /// Process exited (session may be restarted).
    Exited,
}

/// Output within this window counts as "working".
const ACTIVE_WINDOW: Duration = Duration::from_millis(1500);
/// Output this soon after input is treated as echo, not work.
const ECHO_WINDOW: Duration = Duration::from_millis(300);
/// A hook state older than this, while output keeps flowing, stops overriding activity.
const HOOK_STALE: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
pub struct Activity {
    pub alive: bool,
    pub last_output: Option<Instant>,
    /// Start of the current continuous output burst.
    pub burst_start: Option<Instant>,
    pub last_input: Option<Instant>,
    pub bell: Option<Instant>,
    pub hook: Option<(Status, Instant)>,
}

impl Default for Activity {
    fn default() -> Self {
        Activity { alive: true, last_output: None, burst_start: None, last_input: None, bell: None, hook: None }
    }
}

impl Activity {
    pub fn on_output(&mut self, now: Instant) {
        let continuing = self.last_output.is_some_and(|t| now.duration_since(t) < ACTIVE_WINDOW);
        if !continuing {
            self.burst_start = Some(now);
        }
        self.last_output = Some(now);
    }

    pub fn status(&self, now: Instant) -> Status {
        if !self.alive {
            return Status::Exited;
        }
        if let Some((hook_status, at)) = self.hook {
            let output_after_hook = self.last_output.is_some_and(|o| o > at);
            if !(output_after_hook && now.duration_since(at) > HOOK_STALE) {
                return hook_status;
            }
        }
        if let Some(bell) = self.bell {
            if self.last_input.is_none_or(|i| i < bell) {
                return Status::Waiting;
            }
        }
        let recent = self.last_output.is_some_and(|o| now.duration_since(o) < ACTIVE_WINDOW);
        let echo_only = match (self.burst_start, self.last_input) {
            (Some(start), Some(input)) => {
                start >= input && start.duration_since(input) < ECHO_WINDOW
                    && self.last_output.is_some_and(|o| o.duration_since(start) < ECHO_WINDOW)
            }
            _ => false,
        };
        if recent && !echo_only { Status::Working } else { Status::Idle }
    }
}

/// Maps a hook event name (Claude Code / Codex) to the state it implies.
pub fn hook_event_status(agent: &str, event: &str, payload: &serde_json::Value) -> Option<Status> {
    match (agent, event) {
        (_, "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "SubagentStart") => {
            let asks_user = payload.get("tool_name").and_then(|v| v.as_str()) == Some("AskUserQuestion");
            Some(if asks_user && event == "PreToolUse" { Status::Waiting } else { Status::Working })
        }
        (_, "PermissionRequest") => Some(Status::Waiting),
        (_, "Notification") => {
            let kind = payload.get("notification_type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "idle_prompt" => Some(Status::Idle),
                _ => Some(Status::Waiting),
            }
        }
        (_, "Stop" | "StopFailure" | "SessionStart" | "PostCompact") => Some(Status::Idle),
        // Codex `notify` only fires on turn completion.
        ("codex", "agent-turn-complete") => Some(Status::Idle),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_is_not_work() {
        let t0 = Instant::now();
        let mut a = Activity { last_input: Some(t0), ..Default::default() };
        a.on_output(t0 + Duration::from_millis(20));
        assert_eq!(a.status(t0 + Duration::from_millis(100)), Status::Idle);
    }

    #[test]
    fn sustained_output_is_work_then_idle() {
        let t0 = Instant::now();
        let mut a = Activity::default();
        for i in 0..10 {
            a.on_output(t0 + Duration::from_millis(i * 100));
        }
        assert_eq!(a.status(t0 + Duration::from_millis(1000)), Status::Working);
        assert_eq!(a.status(t0 + Duration::from_millis(4000)), Status::Idle);
    }

    #[test]
    fn hook_overrides_and_bell_waits() {
        let t0 = Instant::now();
        let mut a = Activity { hook: Some((Status::Waiting, t0)), ..Default::default() };
        assert_eq!(a.status(t0), Status::Waiting);
        a.hook = None;
        a.bell = Some(t0);
        assert_eq!(a.status(t0), Status::Waiting);
        a.last_input = Some(t0 + Duration::from_millis(1));
        assert_eq!(a.status(t0 + Duration::from_secs(5)), Status::Idle);
    }

    #[test]
    fn maps_claude_events() {
        let none = serde_json::Value::Null;
        assert_eq!(hook_event_status("claude", "UserPromptSubmit", &none), Some(Status::Working));
        assert_eq!(hook_event_status("claude", "Stop", &none), Some(Status::Idle));
        let ask = serde_json::json!({"tool_name": "AskUserQuestion"});
        assert_eq!(hook_event_status("claude", "PreToolUse", &ask), Some(Status::Waiting));
    }
}
