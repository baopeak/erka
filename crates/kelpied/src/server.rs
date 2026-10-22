//! Socket accept loop and per-client connection handling.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::Result;
use kelpie_proto::{read_frame, transport, Endpoint, Frame};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

use crate::daemon::Daemon;
use crate::session::{json_out, next_client_id, Outgoing};

/// Coalesce queued frames into socket writes of up to this size.
const WRITE_BATCH: usize = 256 * 1024;

pub async fn serve(daemon: Arc<Daemon>, endpoint: Endpoint) -> Result<()> {
    use interprocess::local_socket::traits::tokio::Listener as _;
    let listener = transport::bind(&endpoint)?;
    tracing::info!("listening on {}", endpoint.display());
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok(stream) => {
                        let daemon = daemon.clone();
                        tokio::spawn(async move {
                            use interprocess::local_socket::traits::tokio::Stream as _;
                            let (rx, tx) = stream.split();
                            client(daemon, tokio::io::BufReader::with_capacity(64 * 1024, rx), tx).await;
                        });
                    }
                    Err(e) => {
                        tracing::warn!("accept: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
            _ = daemon.shutdown.notified() => {
                tracing::info!("shutdown requested");
                return Ok(());
            }
        }
    }
}

async fn client<R, W>(daemon: Arc<Daemon>, mut rx: R, mut tx: W)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let id = next_client_id();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Outgoing>();
    daemon.register_client(id, out_tx.clone());

    let writer = tokio::spawn(async move {
        let mut batch = Vec::with_capacity(WRITE_BATCH);
        let mut credits = Vec::new();
        while let Some(first) = out_rx.recv().await {
            batch.clear();
            let mut push = |o: Outgoing, batch: &mut Vec<u8>| {
                batch.extend_from_slice(&o.data);
                if let Some(c) = o.credit {
                    credits.push((c, o.data.len()));
                }
            };
            push(first, &mut batch);
            while batch.len() < WRITE_BATCH {
                match out_rx.try_recv() {
                    Ok(o) => push(o, &mut batch),
                    Err(_) => break,
                }
            }
            if tx.write_all(&batch).await.is_err() {
                break;
            }
            for (credit, len) in credits.drain(..) {
                credit.fetch_sub(len, Ordering::Relaxed);
            }
        }
    });

    // Requests from one client run strictly in order (detach-then-attach, restart twice…)
    // on a single worker, off the read loop so input frames keep flowing meanwhile.
    let (req_tx, mut req_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let worker = {
        let daemon = daemon.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            while let Some(req) = req_rx.recv().await {
                let daemon = daemon.clone();
                let out_tx = out_tx.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let req_id = req.get("id").cloned().unwrap_or(Value::Null);
                    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                    let params = req.get("params").cloned().unwrap_or(Value::Null);
                    let reply = match daemon.dispatch(id, &out_tx, &req_id, method, params) {
                        Ok(Some(result)) => json!({"id": req_id, "result": result}),
                        Ok(None) => return,
                        Err(e) => json!({"id": req_id, "error": {"message": format!("{e:#}")}}),
                    };
                    if !req_id.is_null() {
                        let _ = out_tx.send(json_out(&reply));
                    }
                })
                .await;
            }
        })
    };

    loop {
        let frame = match read_frame(&mut rx).await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                tracing::debug!("client {id} read error: {e}");
                break;
            }
        };
        match frame {
            Frame::Input { handle, data } => {
                if let Ok(entry) = daemon.entry(handle) {
                    entry.input(data);
                }
            }
            Frame::Json(body) => {
                let req: Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = out_tx.send(json_out(&json!({"id": null, "error": {"message": format!("bad json: {e}")}})));
                        continue;
                    }
                };
                let _ = req_tx.send(req);
            }
            Frame::Output { .. } => {}
        }
    }
    drop(req_tx);
    let _ = worker.await;
    daemon.unregister_client(id);
    drop(out_tx);
    writer.abort();
}
