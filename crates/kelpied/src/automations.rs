//! Scheduled automations: start an agent session with a prompt on a schedule. They live in the
//! daemon (`automations.json`), so they run while the Kelpie window is closed.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone, Timelike, Weekday};
use serde::{Deserialize, Serialize};

use crate::persist::write_atomic;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Every {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Agent session kind (claude, codex, gemini, …).
    pub kind: String,
    pub prompt: String,
    pub cwd: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment of its sessions (the agent profile's variables and account home).
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    pub every: Every,
    /// `HH:MM` local time (hourly: only the minute counts).
    #[serde(default = "nine")]
    pub time: String,
    /// Weekly: 0 = Sunday … 6 = Saturday.
    #[serde(default)]
    pub weekday: u8,
    /// Wall-clock ms; 0 = never.
    #[serde(default)]
    pub last_run: u64,
    #[serde(default)]
    pub last_session: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub next_run: u64,
    /// Where the result goes when the run finishes: `review` puts the folder's card in the Review
    /// column (`meta.set status=review`). Empty: nowhere.
    #[serde(default)]
    pub deliver: Option<String>,
}

fn yes() -> bool {
    true
}
fn nine() -> String {
    "09:00".into()
}

pub const DELIVER_REVIEW: &str = "review";

/// A run missed by more than this (daemon stopped, machine asleep) is skipped, not caught up.
const MISSED_GRACE_MS: u64 = 30 * 60 * 1000;

impl Automation {
    fn time_of_day(&self) -> NaiveTime {
        NaiveTime::parse_from_str(self.time.trim(), "%H:%M").unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).unwrap())
    }

    /// First scheduled time strictly after `after`.
    pub fn next_after(&self, after: DateTime<Local>) -> DateTime<Local> {
        let t = self.time_of_day();
        if self.every == Every::Hourly {
            let base = after.with_second(0).and_then(|d| d.with_nanosecond(0)).unwrap_or(after);
            let mut cand = base.with_minute(t.minute()).unwrap_or(base);
            while cand <= after {
                cand += Duration::hours(1);
            }
            return cand;
        }
        let mut day = after.date_naive();
        for _ in 0..15 {
            let fits = match self.every {
                Every::Daily => true,
                Every::Weekdays => !matches!(day.weekday(), Weekday::Sat | Weekday::Sun),
                Every::Weekly => day.weekday().num_days_from_sunday() == u32::from(self.weekday % 7),
                Every::Hourly => unreachable!(),
            };
            if fits {
                // A DST gap has no such local time: take the earliest valid reading.
                if let Some(cand) = Local.from_local_datetime(&day.and_time(t)).earliest() {
                    if cand > after {
                        return cand;
                    }
                }
            }
            day = day.succ_opt().unwrap_or(day);
        }
        after + Duration::days(1)
    }
}

pub struct Automations {
    path: PathBuf,
    pub list: Vec<Automation>,
}

impl Automations {
    pub fn load(dir: &Path) -> Automations {
        let path = dir.join("automations.json");
        let list = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut me = Automations { path, list };
        let now = Local::now();
        for a in &mut me.list {
            if a.next_run == 0 {
                a.next_run = a.next_after(now).timestamp_millis() as u64;
            }
        }
        me
    }

    pub fn save(&self) -> Result<()> {
        write_atomic(&self.path, &serde_json::to_vec_pretty(&self.list)?)
    }

    /// Inserts or replaces (by id); the schedule restarts from now.
    pub fn upsert(&mut self, mut a: Automation) -> Result<Automation> {
        if a.name.trim().is_empty() || a.prompt.trim().is_empty() || a.cwd.trim().is_empty() || a.kind.trim().is_empty() {
            bail!("an automation needs a name, an agent, a folder and a prompt");
        }
        a.deliver = a.deliver.take().filter(|d| !d.is_empty());
        if a.deliver.as_deref().is_some_and(|d| d != DELIVER_REVIEW) {
            bail!("deliver must be \"{DELIVER_REVIEW}\" or empty");
        }
        if a.id.is_empty() {
            a.id = uuid::Uuid::new_v4().to_string();
        }
        a.next_run = a.next_after(Local::now()).timestamp_millis() as u64;
        match self.list.iter_mut().find(|x| x.id == a.id) {
            Some(slot) => {
                // Run history is the daemon's, not the editor's.
                a.last_run = slot.last_run;
                a.last_session = slot.last_session.clone();
                a.last_error = slot.last_error.clone();
                *slot = a.clone();
            }
            None => self.list.push(a.clone()),
        }
        self.save()?;
        Ok(a)
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.list.retain(|a| a.id != id);
        self.save()
    }

    /// Ids of enabled automations whose time has come; skipped (stale) ones are rescheduled.
    pub fn due(&mut self, now_ms: u64) -> Vec<String> {
        let now = Local::now();
        let mut due = Vec::new();
        let mut changed = false;
        for a in &mut self.list {
            if a.next_run == 0 || a.next_run > now_ms {
                continue;
            }
            if a.enabled && now_ms - a.next_run <= MISSED_GRACE_MS {
                due.push(a.id.clone());
            }
            a.next_run = a.next_after(now).timestamp_millis() as u64;
            changed = true;
        }
        if changed {
            let _ = self.save();
        }
        due
    }

    pub fn record(&mut self, id: &str, at: u64, session: Option<String>, error: Option<String>) {
        if let Some(a) = self.list.iter_mut().find(|a| a.id == id) {
            a.last_run = at;
            a.last_session = session;
            a.last_error = error;
            let _ = self.save();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auto(every: Every, time: &str, weekday: u8) -> Automation {
        Automation {
            id: "a".into(),
            name: "n".into(),
            enabled: true,
            kind: "claude".into(),
            prompt: "p".into(),
            cwd: ".".into(),
            project_id: None,
            args: vec![],
            env: Default::default(),
            every,
            time: time.into(),
            weekday,
            last_run: 0,
            last_session: None,
            last_error: None,
            next_run: 0,
            deliver: None,
        }
    }

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap()
    }

    #[test]
    fn schedules() {
        // 2026-10-21 is a Wednesday.
        let wed_10 = at(2026, 10, 21, 10, 0);
        assert_eq!(auto(Every::Daily, "09:00", 0).next_after(wed_10), at(2026, 10, 22, 9, 0));
        assert_eq!(auto(Every::Daily, "11:30", 0).next_after(wed_10), at(2026, 10, 21, 11, 30));
        assert_eq!(auto(Every::Hourly, "00:15", 0).next_after(wed_10), at(2026, 10, 21, 10, 15));
        assert_eq!(auto(Every::Hourly, "00:00", 0).next_after(wed_10), at(2026, 10, 21, 11, 0));
        let fri_10 = at(2026, 10, 23, 10, 0);
        assert_eq!(auto(Every::Weekdays, "09:00", 0).next_after(fri_10), at(2026, 10, 26, 9, 0));
        assert_eq!(auto(Every::Weekly, "08:00", 1).next_after(wed_10), at(2026, 10, 26, 8, 0));
    }

    #[test]
    fn deliver_is_review_or_nothing() {
        let dir = std::env::temp_dir().join(format!("kelpie-auto-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = Automations { path: dir.join("automations.json"), list: vec![] };
        let mut a = auto(Every::Daily, "09:00", 0);
        a.deliver = Some("review".into());
        assert_eq!(s.upsert(a.clone()).unwrap().deliver.as_deref(), Some("review"));
        a.deliver = Some("".into());
        assert_eq!(s.upsert(a.clone()).unwrap().deliver, None, "empty means nowhere");
        a.deliver = Some("slack".into());
        assert!(s.upsert(a).is_err());
        // Saved files from before the field existed still load.
        let old: Automation = serde_json::from_str(r#"{"id":"x","name":"n","kind":"claude","prompt":"p","cwd":".","every":"daily"}"#).unwrap();
        assert_eq!(old.deliver, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_runs_are_skipped() {
        let dir = std::env::temp_dir().join(format!("kelpie-auto-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = Automations { path: dir.join("automations.json"), list: vec![auto(Every::Daily, "09:00", 0)] };
        let now = Local::now().timestamp_millis() as u64;
        s.list[0].next_run = now - 60_000;
        assert_eq!(s.due(now), vec!["a".to_string()]);
        assert!(s.list[0].next_run > now);
        s.list[0].next_run = now - MISSED_GRACE_MS - 1;
        assert!(s.due(now).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
