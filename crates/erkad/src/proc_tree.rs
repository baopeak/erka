//! Whole-process-tree ownership and termination.
//!
//! Windows: every session gets its own Job Object (handle owned by the daemon) with
//! `KILL_ON_JOB_CLOSE`, so killing a session — or the daemon dying — never leaves orphaned
//! agent subprocesses. macOS/Unix: portable-pty `setsid()`s the child, so the process group
//! id equals the child pid and `killpg` reaches the whole tree.

#[cfg(windows)]
mod imp {
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub struct ProcTree {
        job: HANDLE,
    }

    // The job handle is only used through thread-safe Win32 calls.
    unsafe impl Send for ProcTree {}
    unsafe impl Sync for ProcTree {}

    impl ProcTree {
        pub fn adopt(pid: u32) -> io::Result<ProcTree> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let tree = ProcTree { job };
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let ok = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(tree)
            }
        }

        pub fn kill(&self) {
            unsafe {
                TerminateJobObject(self.job, 1);
            }
        }
    }

    impl Drop for ProcTree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job);
            }
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::io;

    pub struct ProcTree {
        pgid: i32,
    }

    impl ProcTree {
        pub fn adopt(pid: u32) -> io::Result<ProcTree> {
            Ok(ProcTree { pgid: pid as i32 })
        }

        /// SIGHUP+SIGTERM now, SIGKILL after a grace period for anything still alive.
        pub fn kill(&self) {
            let pgid = self.pgid;
            unsafe {
                libc::killpg(pgid, libc::SIGHUP);
                libc::killpg(pgid, libc::SIGTERM);
            }
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            });
        }
    }

    /// Like the Windows job's kill-on-close: whatever the session left running goes too.
    impl Drop for ProcTree {
        fn drop(&mut self) {
            unsafe {
                libc::killpg(self.pgid, libc::SIGHUP);
            }
        }
    }
}

pub use imp::ProcTree;
