//! Measures raw PTY read throughput for a command, without the daemon.
//! `cargo run --release --example pty_speed -- cmd.exe /c type big.txt`
use std::io::Read;
use std::time::Instant;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut cmd = CommandBuilder::new(&args[0]);
    cmd.args(&args[1..]);
    let t = Instant::now();
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let master = pair.master;
    let reply = std::env::var("REPLY_DSR").is_ok();
    let h = std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let (mut total, mut reads) = (0usize, 0usize);
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            if reply && buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                use std::io::Write;
                let _ = writer.write_all(b"\x1b[1;1R");
            }
            total += n;
            reads += 1;
        }
        (total, reads)
    });
    let code = child.wait().unwrap();
    let exited = t.elapsed();
    drop(master);
    let (total, reads) = h.join().unwrap();
    println!("exit {code:?} after {exited:?}; read {total} bytes in {reads} reads, total {:?}", t.elapsed());
}
