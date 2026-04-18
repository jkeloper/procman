// Audit log for remote mutations. In-memory ring + optional disk append.

use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;

const RING_CAPACITY: usize = 500;
const ROTATE_MAX_BYTES: u64 = 5 * 1024 * 1024;
const ROTATE_KEEP: usize = 3;

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
    // File writer is optional: callers can opt in by constructing with a
    // path; older tests / lightweight callers still get an in-memory-only
    // instance via `AuditLog::new()`.
    writer: Option<StdMutex<RotatingWriter>>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self {
            ring: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
            writer: None,
        }
    }

    /// Construct with disk persistence. Failure to open the file degrades
    /// to in-memory-only (we log a warning) so audit never blocks startup.
    #[allow(dead_code)]
    pub fn with_file(path: PathBuf) -> Self {
        let writer = RotatingWriter::open(path.clone())
            .map_err(|e| {
                log::warn!("audit log disk writer disabled: {} ({})", path.display(), e);
            })
            .ok()
            .map(StdMutex::new);
        Self {
            ring: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
            writer,
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
        if let Some(w) = &self.writer {
            if let Ok(mut guard) = w.lock() {
                if let Err(e) = guard.append(&entry) {
                    log::warn!("audit log write failed: {}", e);
                }
            }
        }
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

/// Size-based file rotation. Each append checks current size; once the
/// file exceeds `max_bytes`, it's rotated:
///   audit.log.2 ← audit.log.1
///   audit.log.1 ← audit.log
///   audit.log   ← new empty file
/// Keeps `keep` rotated files; older numbered files are deleted.
#[allow(dead_code)]
struct RotatingWriter {
    path: PathBuf,
    file: File,
    max_bytes: u64,
    keep: usize,
}

impl RotatingWriter {
    #[allow(dead_code)]
    fn open(path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        Ok(Self {
            path,
            file,
            max_bytes: ROTATE_MAX_BYTES,
            keep: ROTATE_KEEP,
        })
    }

    #[cfg(test)]
    fn open_with(path: PathBuf, max_bytes: u64, keep: usize) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        Ok(Self {
            path,
            file,
            max_bytes,
            keep,
        })
    }

    fn append(&mut self, entry: &AuditEntry) -> std::io::Result<()> {
        self.maybe_rotate()?;
        let line = serde_json::to_string(entry).map_err(|e| {
            std::io::Error::other(format!("serialize: {}", e))
        })?;
        writeln!(self.file, "{}", line)?;
        Ok(())
    }

    fn maybe_rotate(&mut self) -> std::io::Result<()> {
        let size = match self.file.metadata() {
            Ok(m) => m.len(),
            Err(_) => return Ok(()),
        };
        if size < self.max_bytes {
            return Ok(());
        }
        self.rotate()
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        rotate_files(&self.path, self.keep)?;
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        Ok(())
    }
}

fn rotate_path(base: &Path, n: usize) -> PathBuf {
    let mut s = base.as_os_str().to_os_string();
    s.push(format!(".{}", n));
    PathBuf::from(s)
}

fn rotate_files(base: &Path, keep: usize) -> std::io::Result<()> {
    // Drop the oldest numbered file if present.
    let oldest = rotate_path(base, keep);
    if oldest.exists() {
        let _ = fs::remove_file(&oldest);
    }
    // Shift .N-1 → .N down to .1 → .2.
    for i in (1..keep).rev() {
        let src = rotate_path(base, i);
        let dst = rotate_path(base, i + 1);
        if src.exists() {
            fs::rename(&src, &dst)?;
        }
    }
    // Current file → .1
    if base.exists() {
        fs::rename(base, rotate_path(base, 1))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_when_exceeding_max_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.log");
        // 1 KB threshold, keep 3 rotated files.
        let mut w = RotatingWriter::open_with(path.clone(), 1024, 3).unwrap();
        let big_detail = "x".repeat(512);
        let entry = AuditEntry {
            ts_ms: 0,
            action: "a".into(),
            target: "t".into(),
            ok: true,
            detail: Some(big_detail),
        };
        // 4 rotations worth of writes.
        for _ in 0..20 {
            w.append(&entry).unwrap();
        }
        // Base file exists, rotated .1/.2/.3 exist; .4 must NOT (keep=3).
        assert!(path.exists());
        assert!(rotate_path(&path, 1).exists());
        assert!(rotate_path(&path, 2).exists());
        assert!(rotate_path(&path, 3).exists());
        assert!(!rotate_path(&path, 4).exists());
    }

    #[test]
    fn append_writes_json_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.log");
        let mut w = RotatingWriter::open_with(path.clone(), 1024 * 1024, 3).unwrap();
        let entry = AuditEntry {
            ts_ms: 42,
            action: "start".into(),
            target: "script-1".into(),
            ok: true,
            detail: None,
        };
        w.append(&entry).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"ts_ms\":42"));
        assert!(text.contains("\"action\":\"start\""));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn with_file_degrades_gracefully_on_bad_path() {
        // Parent can't be created under /dev/null/foo — with_file must
        // return an in-memory-only instance rather than panic.
        let bad = PathBuf::from("/dev/null/nope/audit.log");
        let log = AuditLog::with_file(bad);
        assert!(log.writer.is_none());
    }

    #[tokio::test]
    async fn in_memory_ring_still_bounded() {
        let log = AuditLog::new();
        for i in 0..(RING_CAPACITY + 50) {
            log.record("a", &format!("t{}", i), true, None).await;
        }
        let snap = log.snapshot().await;
        assert_eq!(snap.len(), RING_CAPACITY);
    }
}
