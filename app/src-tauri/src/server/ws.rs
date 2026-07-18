// WebSocket handler: streams process status + log events to clients.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::Listener;

use super::{ConnectionCloseReason, ServerState};

const WS_QUEUE_CAPACITY: usize = 1024;

fn event_channel() -> (
    tokio::sync::mpsc::Sender<String>,
    tokio::sync::mpsc::Receiver<String>,
) {
    tokio::sync::mpsc::channel(WS_QUEUE_CAPACITY)
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<ServerState>,
) -> impl IntoResponse {
    // Clients offer both `procman` and a token-bearing subprotocol. Only ever
    // echo the stable, non-secret `procman` protocol — NEVER echo a
    // `procman-token.<token>` value, or the bearer token leaks into the
    // handshake *response* headers (reverse-proxy access logs, devtools
    // Network tab). A client that omits `procman` simply gets no subprotocol
    // echoed; that is valid per RFC 6455 and the token was already validated
    // from the request header by `require_token`.
    // watch retains the latest close reason: stop/rotation remains visible even
    // if it lands after auth but before this upgrade callback starts.
    let close_rx = state.close_conns.subscribe();
    let upgrade = ws.on_upgrade(move |socket| handle_socket(socket, state, close_rx));
    websocket_upgrade_response(upgrade.into_response(), &headers)
}

fn websocket_upgrade_response(mut response: Response, headers: &HeaderMap) -> Response {
    let selected = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            let protocols: Vec<&str> = s.split(',').map(str::trim).collect();
            if protocols.contains(&"procman") {
                Some("procman".to_string())
            } else {
                None
            }
        });

    if let Some(proto) = selected {
        if let Ok(val) = axum::http::HeaderValue::from_str(&proto) {
            response.headers_mut().insert("sec-websocket-protocol", val);
        }
    }
    response
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum OutEvent {
    #[serde(rename = "hello")]
    Hello {
        name: &'static str,
        version: &'static str,
    },
    #[serde(rename = "status")]
    Status(serde_json::Value),
    #[serde(rename = "log")]
    Log {
        script_id: String,
        line: serde_json::Value,
    },
}

async fn handle_socket(
    mut socket: WebSocket,
    state: ServerState,
    mut close_rx: tokio::sync::watch::Receiver<Option<ConnectionCloseReason>>,
) {
    // Force-close signal: fired by `rotate_token`/`stop_server` so a rotated
    // or leaked token can no longer keep streaming through this already-open
    // socket (the handshake auth check is never re-run on a live connection).
    // A close may already be queued from the auth→upgrade interval. Do not even
    // emit hello in that case; the credential that authenticated this request
    // has already been revoked or the server has stopped.
    let initial_close = *close_rx.borrow();
    if let Some(reason) = initial_close {
        send_forced_close(&mut socket, reason).await;
        return;
    }

    if !send_hello(&mut socket).await {
        return;
    }

    // A disconnected or slow remote must not turn a hot log stream into an
    // unbounded memory sink. Status/log producers are synchronous Tauri event
    // callbacks, so use try_send and drop newest events under backpressure;
    // clients can recover current state and log tails through REST snapshots.
    let (tx, mut rx) = event_channel();
    let dropped = Arc::new(AtomicUsize::new(0));
    let app = state.app_handle.clone();

    // Subscribe to process://status
    let tx_status = tx.clone();
    let dropped_status = Arc::clone(&dropped);
    let status_handle = app.listen("process://status", move |ev| {
        let payload_str = ev.payload();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload_str) {
            let out = OutEvent::Status(v);
            if let Ok(s) = serde_json::to_string(&out) {
                try_enqueue(&tx_status, s, &dropped_status);
            }
        }
    });

    // Cancel channel lets us *gracefully* unwind the log_task so it can
    // unlisten its own per-script subscriptions. Previously we used abort(),
    // which leaked every log listener on disconnect — one per running process
    // every reconnect.
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let tx_log = tx.clone();
    let dropped_log = Arc::clone(&dropped);
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
                let dropped = Arc::clone(&dropped_log);
                let handle = app_for_log.listen(format!("log://{}", id), move |ev| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(ev.payload()) {
                        let out = OutEvent::Log {
                            script_id: id_for_handler.clone(),
                            line: v,
                        };
                        if let Ok(s) = serde_json::to_string(&out) {
                            try_enqueue(&tx, s, &dropped);
                        }
                    }
                });
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

    forward_messages(&mut socket, &mut rx, &mut close_rx).await;

    app.unlisten(status_handle);
    // Signal graceful shutdown so log_task can unlisten before exiting.
    let _ = cancel_tx.send(());
    let _ = log_task.await;
}

async fn send_hello(socket: &mut WebSocket) -> bool {
    let hello = serde_json::to_string(&OutEvent::Hello {
        name: "procman",
        version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    socket.send(Message::Text(hello)).await.is_ok()
}

/// Drive one upgraded connection until the peer disconnects, a producer
/// closes, or the server signals a force-close (stop/token rotation).
/// Match complete receive results rather than using `Some(Ok(..))` patterns
/// inside `select!`: an error/EOF must terminate immediately instead of
/// disabling just that branch and leaving the task stuck on idle producers.
async fn forward_messages(
    socket: &mut WebSocket,
    rx: &mut tokio::sync::mpsc::Receiver<String>,
    close_rx: &mut tokio::sync::watch::Receiver<Option<ConnectionCloseReason>>,
) {
    loop {
        tokio::select! {
            changed = close_rx.changed() => {
                let reason = if changed.is_ok() {
                    // Copy the watch value before awaiting the socket send. A
                    // watch Ref is a std RwLock guard and is intentionally not
                    // Send across await points.
                    (*close_rx.borrow()).unwrap_or(ConnectionCloseReason::ServerStopped)
                } else {
                    ConnectionCloseReason::ServerStopped
                };
                send_forced_close(socket, reason).await;
                break;
            },
            event = rx.recv() => {
                match event {
                    Some(msg) => {
                        if socket.send(Message::Text(msg)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

async fn send_forced_close(socket: &mut WebSocket, reason: ConnectionCloseReason) {
    use axum::extract::ws::CloseFrame;
    use std::borrow::Cow;

    let (code, message) = match reason {
        ConnectionCloseReason::ServerStopped => (1001, "server stopped"),
        ConnectionCloseReason::TokenRotated => (4001, "authentication revoked"),
    };
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: Cow::Borrowed(message),
        })))
        .await;
}

fn try_enqueue(tx: &tokio::sync::mpsc::Sender<String>, message: String, dropped: &AtomicUsize) {
    if tx.try_send(message).is_err() {
        let count = dropped.fetch_add(1, Ordering::Relaxed) + 1;
        // Log on powers of two to make sustained pressure observable without
        // creating another log flood.
        if count.is_power_of_two() {
            log::warn!("WebSocket client backpressure: dropped {} events", count);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::auth;
    use axum::{extract::ws::WebSocketUpgrade, middleware, routing::get, Router};
    use std::sync::Arc;
    use tokio::sync::{Mutex, RwLock};
    use tokio_stream::StreamExt;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, http::HeaderValue, Message as ClientMessage},
    };

    #[test]
    fn websocket_queue_drops_at_capacity() {
        let (tx, mut rx) = event_channel();
        let dropped = AtomicUsize::new(0);
        for index in 0..WS_QUEUE_CAPACITY {
            try_enqueue(&tx, format!("event-{index}"), &dropped);
        }
        assert_eq!(rx.len(), WS_QUEUE_CAPACITY);
        assert_eq!(dropped.load(Ordering::Relaxed), 0);

        try_enqueue(&tx, "event-over-capacity".into(), &dropped);
        assert_eq!(rx.len(), WS_QUEUE_CAPACITY);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        assert_eq!(rx.try_recv().unwrap(), "event-0");

        // Once the consumer catches up, the fixed-size queue accepts new
        // events again without growing or losing the established drop count.
        try_enqueue(&tx, "after-drain".into(), &dropped);
        assert_eq!(rx.len(), WS_QUEUE_CAPACITY);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        for expected in 1..WS_QUEUE_CAPACITY {
            assert_eq!(rx.try_recv().unwrap(), format!("event-{expected}"));
        }
        assert_eq!(rx.try_recv().unwrap(), "after-drain");
    }

    #[tokio::test]
    async fn websocket_auth_forwards_events_and_rotation_closes_old_stream() {
        let token = Arc::new(RwLock::new("ws-token".to_string()));
        let auth_state = auth::AuthState::isolated(Arc::clone(&token));
        let (close_conns, _) = tokio::sync::watch::channel(None);
        let (event_tx, event_rx) = tokio::sync::mpsc::channel::<String>(4);
        let event_rx = Arc::new(Mutex::new(Some(event_rx)));
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        let done_tx = Arc::new(Mutex::new(Some(done_tx)));

        let close_for_handler = close_conns.clone();
        let event_rx_for_handler = Arc::clone(&event_rx);
        let done_for_handler = Arc::clone(&done_tx);
        let app = Router::new()
            .route(
                "/stream",
                get(move |ws: WebSocketUpgrade, headers: HeaderMap| {
                    let mut close_rx = close_for_handler.subscribe();
                    let event_rx = Arc::clone(&event_rx_for_handler);
                    let done = Arc::clone(&done_for_handler);
                    async move {
                        let upgrade = ws.on_upgrade(move |mut socket| async move {
                            let mut rx = event_rx
                                .lock()
                                .await
                                .take()
                                .expect("test accepts one authenticated socket");
                            if send_hello(&mut socket).await {
                                forward_messages(&mut socket, &mut rx, &mut close_rx).await;
                            }
                            if let Some(done) = done.lock().await.take() {
                                let _ = done.send(());
                            }
                        });
                        websocket_upgrade_response(upgrade.into_response(), &headers)
                    }
                }),
            )
            .route_layer(middleware::from_fn_with_state(
                auth_state.clone(),
                auth::require_token,
            ))
            .layer(middleware::from_fn_with_state(auth_state, auth::rate_limit));

        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let url = format!("ws://{addr}/stream");

        let unauthenticated = connect_async(&url).await.unwrap_err();
        match unauthenticated {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status().as_u16(), 401);
            }
            other => panic!("expected HTTP 401 handshake rejection, got {other}"),
        }

        let mut request = url.as_str().into_client_request().unwrap();
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("procman, procman-token.ws-token"),
        );
        let (mut socket, response) = connect_async(request).await.unwrap();
        let selected_protocol = response
            .headers()
            .get("sec-websocket-protocol")
            .expect("server must select the stable protocol")
            .to_str()
            .unwrap();
        assert_eq!(selected_protocol, "procman");
        assert!(!selected_protocol.contains("ws-token"));

        let hello = tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
            .await
            .expect("hello timed out")
            .expect("socket ended before hello")
            .expect("hello frame failed");
        let hello = hello.into_text().expect("hello must be text");
        let hello: serde_json::Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(hello["type"], "hello");

        event_tx
            .send(r#"{"type":"status","ready":true}"#.into())
            .await
            .unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
            .await
            .expect("event forwarding timed out")
            .expect("socket ended before event")
            .expect("event frame failed");
        assert_eq!(
            event,
            ClientMessage::Text(r#"{"type":"status","ready":true}"#.into())
        );

        // This is the same ordering used by token rotation: replace the live
        // token, then broadcast close so the old authenticated stream cannot
        // remain attached after its credential becomes invalid.
        *token.write().await = "rotated-token".to_string();
        close_conns.send_replace(Some(ConnectionCloseReason::TokenRotated));
        let end = tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
            .await
            .expect("force-close did not terminate the client stream");
        let close = end
            .expect("server must send an auth-revoked close frame")
            .expect("auth-revoked close frame failed");
        assert!(matches!(
            close,
            ClientMessage::Close(Some(frame)) if u16::from(frame.code) == 4001
        ));
        tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
            .await
            .expect("server websocket task did not finish")
            .expect("completion sender dropped");

        let mut stale_request = url.as_str().into_client_request().unwrap();
        stale_request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("procman, procman-token.ws-token"),
        );
        let stale = connect_async(stale_request).await.unwrap_err();
        match stale {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status().as_u16(), 401);
            }
            other => panic!("expected rotated token to reject stale handshake, got {other}"),
        }

        server.abort();
    }

    #[tokio::test]
    async fn close_reason_before_upgrade_is_sticky() {
        let (close_conns, _) = tokio::sync::watch::channel(None);
        close_conns.send_replace(Some(ConnectionCloseReason::TokenRotated));

        // A callback receiver created after auth-time revocation still sees it,
        // closing the validate→upgrade gap that broadcast receivers left.
        let mut callback_view = close_conns.subscribe();
        assert_eq!(
            *callback_view.borrow(),
            Some(ConnectionCloseReason::TokenRotated)
        );
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            callback_view.wait_for(|reason| reason.is_some()),
        )
        .await
        .unwrap()
        .unwrap();
    }
}
