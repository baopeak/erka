//! Places the sideloaded ConPTY (`third_party/conpty`) next to the built binaries on Windows
//! so portable-pty loads the modern `conpty.dll` + `OpenConsole.exe` instead of the slow
//! inbox ConPTY of Windows 10.
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=../../third_party/conpty");
    if std::env::var("CARGO_CFG_WINDOWS").is_err() {
        return;
    }
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        _ => "x64",
    };
    let src = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../third_party/conpty")
        .join(arch);
    // OUT_DIR is <cargo output>/<profile>/<scripts dir>/kelpied-<hash>/out
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let Some(profile_dir) = out.ancestors().nth(3) else { return };
    for dir in [profile_dir.to_path_buf(), profile_dir.join("examples"), profile_dir.join("deps")] {
        let _ = std::fs::create_dir_all(&dir);
        for file in ["conpty.dll", "OpenConsole.exe"] {
            let from = src.join(file);
            let to = dir.join(file);
            let size = |p: &PathBuf| std::fs::metadata(p).map(|m| m.len()).ok();
            if size(&from) != size(&to) {
                // A running daemon may hold the old copy open; it keeps working, so ignore.
                let _ = std::fs::copy(&from, &to);
            }
        }
    }
}
