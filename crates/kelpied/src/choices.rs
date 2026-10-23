//! Prompts an agent shows on screen and waits on: numbered menus, yes/no questions. Agents
//! without hooks (Codex approvals, Gemini, Aider, OpenCode…) only say they need the user this way.
//!
//! Only the lines at the cursor count — the last non-empty lines of the screen — so a shell that
//! printed a file mentioning "(y/n)" and went back to its prompt is not waiting.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Prompt {
    /// Keys that answer it, in screen order: digits for a menu, letters for yes/no.
    pub keys: Vec<String>,
    /// The question line above the choices, when there is one.
    pub question: Option<String>,
}

/// How far up a menu may start, in non-empty lines from the bottom.
const MENU_LINES: usize = 12;
/// A yes/no prompt must sit on one of the last lines.
const YES_NO_LINES: usize = 3;

/// `❯ 1. Yes`, `● 2) No`, `  3. No, and tell Claude what to do differently (esc)`.
static MENU_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:[│|]\s*)?(?:[❯>›»▶●○◉◯*]\s*)?(\d)[.)]\s+\S").unwrap());
/// `(y/n)`, `[Y/n]`, `(yes/no)`.
static YES_NO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[(\[]\s*(?:y|yes)\s*/\s*(?:n|no)\s*[)\]]").unwrap());
/// Aider: `(Y)es/(N)o/(D)on't ask again`.
static PAREN_INITIALS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(([A-Za-z])\)[a-z']+").unwrap());
/// Codex: `Yes (y)`, `No, provide feedback (n)`, `Always (a)`.
static TRAILING_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:yes|no|always|allow|deny|approve|reject|cancel)\b[^()\n]{0,40}\(([a-z])\)").unwrap());

/// The prompt at the bottom of `screen` (plain text, as `text_tail` returns it), if any.
pub fn detect(screen: &str) -> Option<Prompt> {
    let lines: Vec<&str> = screen.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    menu(&lines).or_else(|| yes_no(&lines))
}

fn menu(lines: &[&str]) -> Option<Prompt> {
    let start = lines.len().saturating_sub(MENU_LINES);
    let window = &lines[start..];
    // The menu's items, bottom-most run of consecutive numbers from 1.
    let numbered: Vec<(usize, u32)> = window.iter().enumerate().filter_map(|(i, l)| MENU_ITEM.captures(l).map(|c| (i, c[1].parse().unwrap_or(0)))).collect();
    let first = numbered.iter().rposition(|&(_, n)| n == 1)?;
    let items: Vec<(usize, u32)> = numbered[first..].iter().copied().enumerate().take_while(|&(k, (_, n))| n == k as u32 + 1).map(|(_, x)| x).collect();
    if items.len() < 2 {
        return None;
    }
    // Waiting on it: the menu ends near the bottom (a hint line such as "Esc to cancel" may follow)
    // and something marks it as a choice — a selection marker or a question just above it.
    let last_item = items.last()?.0;
    if window.len() - 1 - last_item > 3 {
        return None;
    }
    let marked = items.iter().any(|&(i, _)| window[i].trim_start().trim_start_matches(['│', '|']).trim_start().starts_with(['❯', '>', '›', '»', '▶', '●', '◉']));
    let question = window[..items[0].0].iter().rev().take(3).find(|l| l.trim_end().ends_with('?')).map(|l| clean(l));
    if !marked && question.is_none() {
        return None;
    }
    Some(Prompt { keys: items.iter().map(|(_, n)| n.to_string()).collect(), question })
}

fn yes_no(lines: &[&str]) -> Option<Prompt> {
    let tail = &lines[lines.len().saturating_sub(YES_NO_LINES)..];
    let last = *tail.last()?;
    if YES_NO.is_match(last) {
        return Some(Prompt { keys: vec!["y".into(), "n".into()], question: Some(clean(last)) });
    }
    let initials: Vec<String> = PAREN_INITIALS.captures_iter(last).map(|c| c[1].to_lowercase()).collect();
    if initials.len() >= 2 && initials.contains(&"y".to_string()) && initials.contains(&"n".to_string()) {
        return Some(Prompt { keys: dedup(initials), question: Some(clean(last)) });
    }
    let keys: Vec<String> = tail.iter().flat_map(|l| TRAILING_KEY.captures_iter(l).map(|c| c[1].to_lowercase()).collect::<Vec<_>>()).collect();
    if keys.len() >= 2 && keys.contains(&"y".to_string()) {
        let question = lines.iter().rev().take(6).find(|l| l.trim_end().ends_with('?')).map(|l| clean(l));
        return Some(Prompt { keys: dedup(keys), question });
    }
    None
}

fn clean(line: &str) -> String {
    line.trim().trim_start_matches(['│', '|', '▌', '>', ' ']).trim().chars().take(160).collect()
}

fn dedup(keys: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in keys {
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(screen: &str) -> Option<Vec<String>> {
        detect(screen).map(|p| p.keys)
    }

    #[test]
    fn claude_permission_menu() {
        let s = "● Bash(npm test)\n\n Bash command\n   npm test\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for npm test commands in D:\\proj\n   3. No, and tell Claude what to do differently (esc)\n";
        let p = detect(s).unwrap();
        assert_eq!(p.keys, ["1", "2", "3"]);
        assert_eq!(p.question.as_deref(), Some("Do you want to proceed?"));
    }

    #[test]
    fn claude_menu_in_a_box_with_a_hint_below() {
        let s = "╭──────────────╮\n│ Do you trust the files in this folder?\n│ ❯ 1. Yes, proceed\n│   2. No, exit\n╰──────────────╯\n   Enter to confirm · Esc to exit\n";
        assert_eq!(keys(s).unwrap(), ["1", "2"]);
    }

    #[test]
    fn gemini_menu() {
        let s = "Allow execution of: 'git status'?\n● 1. Yes, allow once\n  2. Yes, allow always\n  3. No, suggest changes (esc)\n";
        assert_eq!(keys(s).unwrap(), ["1", "2", "3"]);
    }

    #[test]
    fn codex_approval() {
        let s = "▌Allow command?\n▌ $ cargo build\n▌ Yes (y)   Always (a)   No, provide feedback (n)\n";
        assert_eq!(keys(s).unwrap(), ["y", "a", "n"]);
    }

    #[test]
    fn aider_question() {
        let s = "Add src/app.ts to the chat? (Y)es/(N)o/(D)on't ask again [Yes]:";
        assert_eq!(keys(s).unwrap(), ["y", "n", "d"]);
    }

    #[test]
    fn plain_yes_no() {
        assert_eq!(keys("PS D:\\proj> .\\deploy.ps1\nContinue (y/n): ").unwrap(), ["y", "n"]);
        assert_eq!(keys("Overwrite existing file? [Y/n] ").unwrap(), ["y", "n"]);
        assert_eq!(keys("Proceed? (yes/no)").unwrap(), ["y", "n"]);
    }

    #[test]
    fn opencode_numbered_with_question() {
        let s = "Permission required: edit src/main.rs?\n1. Allow\n2. Allow always\n3. Reject\n";
        assert_eq!(keys(s).unwrap(), ["1", "2", "3"]);
    }

    #[test]
    fn shell_prompt_after_text_mentioning_yes_no() {
        let s = "PS D:\\proj> type notes.md\nAsk the user (y/n) before deleting.\n1. Back up\n2. Delete\nPS D:\\proj> ";
        assert_eq!(detect(s), None);
    }

    #[test]
    fn numbered_prose_and_lists_are_not_menus() {
        let s = "Steps:\n1. Install the CLI\n2. Run it\n3. Profit\n\nAll done. Anything else?\n> ";
        assert_eq!(detect(s), None);
        assert_eq!(detect("The plan:\n1. Parse\n2. Check\nI'll start with step 1 now."), None);
    }

    #[test]
    fn diff_and_logs_are_not_prompts() {
        let s = "diff --git a/x b/x\n-  if ok (y/n)\n+  if ok (y/n)?\n@@ -1,2 +1,2 @@\n context\n";
        assert_eq!(detect(s), None);
        assert_eq!(detect("   Compiling kelpied v0.1.2\n    Finished `dev` profile in 4.2s\n"), None);
    }

    #[test]
    fn menu_must_start_at_one_and_be_consecutive() {
        assert_eq!(detect("Which?\n❯ 2. b\n  3. c\n"), None);
        assert_eq!(detect("Which?\n❯ 1. a\n  3. c\n"), None);
        assert_eq!(keys("Which?\n❯ 1. a\n  2. b\n").unwrap(), ["1", "2"]);
    }

    #[test]
    fn a_menu_far_above_the_cursor_is_old() {
        let s = "Do you want to proceed?\n❯ 1. Yes\n  2. No\nok\nrunning tests\npassed 10\npassed 11\nsummary\n";
        assert_eq!(detect(s), None);
    }

    #[test]
    fn empty_screen() {
        assert_eq!(detect(""), None);
        assert_eq!(detect("\n\n  \n"), None);
    }

    #[test]
    fn detection_is_cheap() {
        let screen = "x".repeat(120).repeat(1) + "\n";
        let screen = screen.repeat(40) + "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
        detect(&screen);
        let t = std::time::Instant::now();
        for _ in 0..200 {
            assert!(detect(&screen).is_some());
        }
        // Generous for debug builds and loaded CI machines; release is far below 0.2 ms.
        assert!(t.elapsed().as_secs_f64() / 200.0 < 0.005, "{:?} per check", t.elapsed() / 200);
    }
}
