//! Wire protocol shared by `erkad` (session daemon) and its clients (the Erka app, hook
//! helper, benchmarks).
//!
//! Every frame is `u32 LE length | u8 kind | payload` where `length` counts `kind + payload`.
//! - `KIND_JSON`: UTF-8 JSON (requests, replies, events).
//! - `KIND_OUTPUT`: daemon → client terminal bytes: `u32 handle | u64 seq | bytes`.
//!   `seq` is the stream offset *after* this chunk, so a client can resume with it.
//! - `KIND_INPUT`: client → daemon keystrokes: `u32 handle | bytes`.
//!
//! Terminal bytes never go through JSON so the hot path stays allocation-light.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;

/// Feature level of the daemon's RPC surface. Unlike `PROTOCOL_VERSION` (which names the
/// endpoint, so changing it orphans running daemons) this only lets a newer app notice an
/// older daemon that is still running and offer to restart it.
pub const API_LEVEL: u32 = 3;
pub const KIND_JSON: u8 = 1;
pub const KIND_OUTPUT: u8 = 2;
pub const KIND_INPUT: u8 = 3;
/// Hard cap so a corrupted length prefix can never trigger a huge allocation.
pub const MAX_FRAME_LEN: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Json(Vec<u8>),
    Output { handle: u32, seq: u64, data: Vec<u8> },
    Input { handle: u32, data: Vec<u8> },
}

impl Frame {
    pub fn json<T: serde::Serialize>(value: &T) -> Frame {
        Frame::Json(serde_json::to_vec(value).expect("serializable value"))
    }

    /// Encodes the frame into a single buffer (length prefix included).
    pub fn encode(&self) -> Vec<u8> {
        let mut out;
        match self {
            Frame::Json(body) => {
                out = Vec::with_capacity(5 + body.len());
                push_header(&mut out, KIND_JSON, body.len());
                out.extend_from_slice(body);
            }
            Frame::Output { handle, seq, data } => {
                out = Vec::with_capacity(17 + data.len());
                push_header(&mut out, KIND_OUTPUT, 12 + data.len());
                out.extend_from_slice(&handle.to_le_bytes());
                out.extend_from_slice(&seq.to_le_bytes());
                out.extend_from_slice(data);
            }
            Frame::Input { handle, data } => {
                out = Vec::with_capacity(9 + data.len());
                push_header(&mut out, KIND_INPUT, 4 + data.len());
                out.extend_from_slice(&handle.to_le_bytes());
                out.extend_from_slice(data);
            }
        }
        out
    }

    fn decode(kind: u8, mut body: Vec<u8>) -> io::Result<Frame> {
        match kind {
            KIND_JSON => Ok(Frame::Json(body)),
            KIND_OUTPUT => {
                if body.len() < 12 {
                    return Err(invalid("short output frame"));
                }
                let handle = u32::from_le_bytes(body[0..4].try_into().unwrap());
                let seq = u64::from_le_bytes(body[4..12].try_into().unwrap());
                body.drain(..12);
                Ok(Frame::Output { handle, seq, data: body })
            }
            KIND_INPUT => {
                if body.len() < 4 {
                    return Err(invalid("short input frame"));
                }
                let handle = u32::from_le_bytes(body[0..4].try_into().unwrap());
                body.drain(..4);
                Ok(Frame::Input { handle, data: body })
            }
            other => Err(invalid(&format!("unknown frame kind {other}"))),
        }
    }
}

fn push_header(out: &mut Vec<u8>, kind: u8, payload_len: usize) {
    out.extend_from_slice(&((payload_len + 1) as u32).to_le_bytes());
    out.push(kind);
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

/// Reads one frame. Returns `Ok(None)` on clean EOF at a frame boundary.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_LEN {
        return Err(invalid(&format!("bad frame length {len}")));
    }
    let mut kind = [0u8; 1];
    reader.read_exact(&mut kind).await?;
    let mut body = vec![0u8; len - 1];
    reader.read_exact(&mut body).await?;
    Frame::decode(kind[0], body).map(Some)
}

pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) -> io::Result<()> {
    writer.write_all(&frame.encode()).await
}

/// Per-user endpoint. Windows: named pipe `\\.\pipe\erka-<user>-v1`.
/// Unix: socket file in the user's private data dir (not world-shared `/tmp`).
pub fn endpoint() -> Endpoint {
    if let Ok(custom) = std::env::var("ERKA_ENDPOINT") {
        return if cfg!(windows) { Endpoint::Namespaced(custom) } else { Endpoint::Path(custom.into()) };
    }
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".into())
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    if cfg!(windows) {
        Endpoint::Namespaced(format!("erka-{user}-v{PROTOCOL_VERSION}"))
    } else {
        Endpoint::Path(data_dir().join(format!("erkad-v{PROTOCOL_VERSION}.sock")))
    }
}

#[derive(Debug, Clone)]
pub enum Endpoint {
    Namespaced(String),
    Path(std::path::PathBuf),
}

impl Endpoint {
    pub fn display(&self) -> String {
        match self {
            Endpoint::Namespaced(n) => format!(r"\\.\pipe\{n}"),
            Endpoint::Path(p) => p.display().to_string(),
        }
    }
}

/// Root for daemon state: `%LOCALAPPDATA%\Erka` / `~/Library/Application Support/Erka`.
pub fn data_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("ERKA_DATA_DIR") {
        return dir.into();
    }
    let base = if cfg!(windows) {
        std::env::var("LOCALAPPDATA").map(Into::into).unwrap_or_else(|_| std::env::temp_dir())
    } else if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support"))
            .unwrap_or_else(|_| std::env::temp_dir())
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(Into::into)
            .or_else(|_| std::env::var("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|_| std::env::temp_dir())
    };
    base.join("Erka")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn roundtrip_all_kinds() {
        let frames = vec![
            Frame::Json(br#"{"id":1}"#.to_vec()),
            Frame::Output { handle: 7, seq: 1 << 40, data: b"\x1b[31mhi".to_vec() },
            Frame::Input { handle: 3, data: vec![] },
        ];
        let mut buf = Vec::new();
        for f in &frames {
            write_frame(&mut buf, f).await.unwrap();
        }
        let mut cursor = std::io::Cursor::new(buf);
        for f in &frames {
            assert_eq!(read_frame(&mut cursor).await.unwrap().as_ref(), Some(f));
        }
        assert!(read_frame(&mut cursor).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_oversized_length() {
        let mut bytes = ((MAX_FRAME_LEN + 2) as u32).to_le_bytes().to_vec();
        bytes.push(KIND_JSON);
        let mut cursor = std::io::Cursor::new(bytes);
        assert!(read_frame(&mut cursor).await.is_err());
    }
}

pub mod transport {
    //! Local-socket helpers shared by the daemon (bind) and clients (connect).
    use std::io;

    use interprocess::local_socket::tokio::{prelude::*, Listener, Stream};
    use interprocess::local_socket::{GenericFilePath, GenericNamespaced, ListenerOptions, Name};

    use super::Endpoint;

    fn name(endpoint: &Endpoint) -> io::Result<Name<'static>> {
        match endpoint {
            Endpoint::Namespaced(n) => n.clone().to_ns_name::<GenericNamespaced>(),
            Endpoint::Path(p) => p.clone().to_fs_name::<GenericFilePath>(),
        }
    }

    pub async fn connect(endpoint: &Endpoint) -> io::Result<Stream> {
        Stream::connect(name(endpoint)?).await
    }

    /// Binds the daemon endpoint. Callers must hold the single-instance lock first, which is
    /// what makes overwriting a stale Unix socket file safe.
    pub fn bind(endpoint: &Endpoint) -> io::Result<Listener> {
        if let Endpoint::Path(p) = endpoint {
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let _ = std::fs::remove_file(p);
        }
        let opts = ListenerOptions::new().name(name(endpoint)?);
        #[cfg(windows)]
        let opts = {
            use interprocess::os::windows::local_socket::ListenerOptionsExt;
            use interprocess::os::windows::security_descriptor::SecurityDescriptor;
            // Protected DACL: only SYSTEM and the pipe owner (the current user). The default
            // named-pipe DACL would let every local account open it for reading.
            let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;SY)(A;;GA;;;OW)")
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
            opts.security_descriptor(SecurityDescriptor::deserialize(&sddl)?)
        };
        let listener = opts.create_tokio()?;
        #[cfg(unix)]
        if let Endpoint::Path(p) = endpoint {
            use std::os::unix::fs::PermissionsExt;
            // Owner-only, like the Windows DACL above.
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(listener)
    }
}
