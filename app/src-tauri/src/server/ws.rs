// WebSocket handler: streams process status + log events to clients.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use serde::Serialize;
use tauri::Listener;

use super::ServerState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
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

    // Subscribe to all log://* by tracking running processes.
    // Simpler approach: poll process list every 1s and subscribe per-script.
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
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
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
    log_task.abort();
}
