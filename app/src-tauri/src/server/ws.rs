// WebSocket handler: streams process status + log events to clients.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use serde::Serialize;
use tauri::Listener;

use super::ServerState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<ServerState>,
) -> impl IntoResponse {
    // If the client negotiated our token-bearing subprotocol, echo it back
    // on the response so the browser accepts the connection. (The
    // require_token middleware already validated the token.)
    let selected = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(',')
                .map(str::trim)
                .find(|p| p.starts_with("procman-token."))
                .map(str::to_string)
        });

    let upgrade = ws.on_upgrade(move |socket| handle_socket(socket, state));
    if let Some(proto) = selected {
        let mut resp = upgrade.into_response();
        if let Ok(val) = axum::http::HeaderValue::from_str(&proto) {
            resp.headers_mut().insert("sec-websocket-protocol", val);
        }
        resp
    } else {
        upgrade.into_response()
    }
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum OutEvent {
    #[serde(rename = "hello")]
    Hello { name: &'static str, version: &'static str },
    #[serde(rename = "status")]
    Status(serde_json::Value),
    #[serde(rename = "log")]
    Log {
        script_id: String,
        line: serde_json::Value,
    },
}

async fn handle_socket(mut socket: WebSocket, state: ServerState) {
    // Greet
    let hello = serde_json::to_string(&OutEvent::Hello {
        name: "procman",
        version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    if socket.send(Message::Text(hello)).await.is_err() {
        return;
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let app = state.app_handle.clone();

    // Subscribe to process://status
    let tx_status = tx.clone();
    let status_handle = app.listen("process://status", move |ev| {
        let payload_str = ev.payload();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload_str) {
            let out = OutEvent::Status(v);
            if let Ok(s) = serde_json::to_string(&out) {
                let _ = tx_status.send(s);
            }
        }
    });

    // Cancel channel lets us *gracefully* unwind the log_task so it can
    // unlisten its own per-script subscriptions. Previously we used abort(),
    // which leaked every log listener on disconnect — one per running process
    // every reconnect.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let tx_log = tx.clone();
    let app_for_log = app.clone();
    let pm = state.pm.clone();
    let log_task = tokio::spawn(async move {
        let mut active: std::collections::HashMap<String, tauri::EventId> =
            std::collections::HashMap::new();
        loop {
            let snapshot = pm.list();
            let current: std::collections::HashSet<String> =
                snapshot.iter().map(|s| s.id.clone()).collect();
            // Subscribe to new ones
            for id in &current {
                if active.contains_key(id) {
                    continue;
                }
                let id_for_handler = id.clone();
                let tx = tx_log.clone();
                let handle = app_for_log.listen(
                    format!("log://{}", id),
                    move |ev| {
                        if let Ok(v) =
                            serde_json::from_str::<serde_json::Value>(ev.payload())
                        {
                            let out = OutEvent::Log {
                                script_id: id_for_handler.clone(),
                                line: v,
                            };
                            if let Ok(s) = serde_json::to_string(&out) {
                                let _ = tx.send(s);
                            }
                        }
                    },
                );
                active.insert(id.clone(), handle);
            }
            // Unsubscribe ones that exited
            let stale: Vec<String> = active
                .keys()
                .filter(|k| !current.contains(*k))
                .cloned()
                .collect();
            for id in stale {
                if let Some(h) = active.remove(&id) {
                    app_for_log.unlisten(h);
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(1000)) => {}
                _ = &mut cancel_rx => break,
            }
        }
        // Graceful teardown: release every per-script listener we still hold.
        for (_, h) in active.drain() {
            app_for_log.unlisten(h);
        }
    });

    // Forwarding loop
    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                if socket.send(Message::Text(msg)).await.is_err() {
                    break;
                }
            }
            Some(Ok(msg)) = socket.recv() => {
                if matches!(msg, Message::Close(_)) {
                    break;
                }
            }
            else => break,
        }
    }

    app.unlisten(status_handle);
    // Signal graceful shutdown so log_task can unlisten before exiting.
    let _ = cancel_tx.send(());
    let _ = log_task.await;
}
