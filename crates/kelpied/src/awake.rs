//! Keep the computer awake (no idle sleep) always or while an agent is working, so a long
//! agent run is not cut off by the power plan. The display may still turn off.
//!
//! Windows: `SetThreadExecutionState` from one dedicated thread (the request belongs to the
//! calling thread). macOS: a `caffeinate -i -w <daemon pid>` child. Elsewhere: no-op.

use std::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Agents,
    Always,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        match s {
            "always" => Mode::Always,
            "agents" => Mode::Agents,
            _ => Mode::Off,
        }
    }
}

pub struct Awake {
    tx: mpsc::Sender<bool>,
    held: parking_lot::Mutex<bool>,
}

impl Awake {
    pub fn new() -> Awake {
        let (tx, rx) = mpsc::channel::<bool>();
        let _ = std::thread::Builder::new().name("kelpie-awake".into()).spawn(move || run(rx));
        Awake { tx, held: parking_lot::Mutex::new(false) }
    }

    /// Holds or releases the wake request; cheap when nothing changes.
    pub fn set(&self, hold: bool) {
        let mut held = self.held.lock();
        if *held != hold {
            *held = hold;
            let _ = self.tx.send(hold);
            tracing::info!(hold, "keep awake");
        }
    }

    pub fn held(&self) -> bool {
        *self.held.lock()
    }
}

#[cfg(windows)]
fn run(rx: mpsc::Receiver<bool>) {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    while let Ok(hold) = rx.recv() {
        let flags = if hold { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
        unsafe { SetThreadExecutionState(flags) };
    }
}

#[cfg(target_os = "macos")]
fn run(rx: mpsc::Receiver<bool>) {
    let mut child: Option<std::process::Child> = None;
    while let Ok(hold) = rx.recv() {
        if let Some(mut c) = child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if hold {
            // `-w`: caffeinate exits with the daemon even if we never get to kill it.
            child = std::process::Command::new("/usr/bin/caffeinate")
                .args(["-i", "-w", &std::process::id().to_string()])
                .spawn()
                .map_err(|e| tracing::warn!("caffeinate: {e}"))
                .ok();
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn run(rx: mpsc::Receiver<bool>) {
    while rx.recv().is_ok() {}
}
