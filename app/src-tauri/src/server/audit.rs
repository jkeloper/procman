// Audit log for remote mutations. In-memory ring + optional disk append.

use serde::Serialize;
use std::collections::VecDeque;
use tokio::sync::Mutex;

const RING_CAPACITY: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub ts_ms: i64,
    pub action: String,
    pub target: String,
    pub ok: bool,
    pub detail: Option<String>,
}

pub struct AuditLog {
    ring: Mutex<VecDeque<AuditEntry>>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self {
            ring: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
        }
    }

    pub async fn record(
        &self,
        action: &str,
        target: &str,
        ok: bool,
        detail: Option<String>,
    ) {
        let entry = AuditEntry {
            ts_ms: now_ms(),
            action: action.to_string(),
            target: target.to_string(),
            ok,
            detail,
        };
        log::info!(
            "[audit] {} {} ok={} {}",
            entry.action,
            entry.target,
            entry.ok,
            entry.detail.as_deref().unwrap_or("")
        );
        let mut guard = self.ring.lock().await;
        if guard.len() == RING_CAPACITY {
            guard.pop_front();
        }
        guard.push_back(entry);
    }

    pub async fn snapshot(&self) -> Vec<AuditEntry> {
        self.ring.lock().await.iter().cloned().collect()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
