//! Minimal async client used by `kelpied hook`, `kelpied ping`, the benchmark and tests.

use std::collections::VecDeque;

use anyhow::{anyhow, Result};
use kelpie_proto::{read_frame, transport, write_frame, Frame};
use interprocess::local_socket::tokio::{RecvHalf, SendHalf};
use interprocess::local_socket::traits::tokio::Stream as _;
use serde_json::{json, Value};

pub struct Client {
    rx: tokio::io::BufReader<RecvHalf>,
    tx: SendHalf,
    next_id: u64,
    /// Frames that arrived while waiting for a reply.
    pub backlog: VecDeque<Frame>,
}

impl Client {
    pub async fn connect() -> Result<Client> {
        let stream = transport::connect(&kelpie_proto::endpoint()).await?;
        let (rx, tx) = stream.split();
        Ok(Client { rx: tokio::io::BufReader::with_capacity(256 * 1024, rx), tx, next_id: 1, backlog: VecDeque::new() })
    }

    pub async fn send(&mut self, frame: &Frame) -> Result<()> {
        write_frame(&mut self.tx, frame).await?;
        Ok(())
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&Frame::json(&json!({"id": id, "method": method, "params": params}))).await?;
        loop {
            let frame = read_frame(&mut self.rx).await?.ok_or_else(|| anyhow!("daemon closed connection"))?;
            if let Frame::Json(body) = &frame {
                let v: Value = serde_json::from_slice(body)?;
                if v.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(err) = v.get("error") {
                        return Err(anyhow!("{method}: {}", err["message"].as_str().unwrap_or("error")));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
            }
            self.backlog.push_back(frame);
        }
    }

    pub async fn next_frame(&mut self) -> Result<Frame> {
        if let Some(f) = self.backlog.pop_front() {
            return Ok(f);
        }
        read_frame(&mut self.rx).await?.ok_or_else(|| anyhow!("daemon closed connection"))
    }
}
