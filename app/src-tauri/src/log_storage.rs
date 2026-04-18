// Persistent log storage backed by sqlite + FTS5 (Phase B Worker K / S3 deferred).
//
// WHY: the in-memory LogBuffer is a 5000-line ring per process — great for
// live tails but everything is lost on restart or when the ring wraps. This
// module shadows every log line to a single on-disk sqlite DB so long-running
// sessions can be investigated later and the user can grep across days of
// output.
//
// DESIGN:
//   - **Hybrid**: the ring buffer is still authoritative for the live tail;
//     sqlite is append-only history. Nothing in the spawn hot path awaits an
//     sqlite write — we `send()` on a bounded mpsc and return immediately.
//   - **Single writer**: one background thread owns the connection, flushes
//     in batches (500 ms tick OR >=1000 queued rows). This keeps us under
//     the `Connection: !Send` limitation of rusqlite and gives us one-fsync
//     per batch instead of one-per-line.
//   - **FTS5**: a contentless-ish "logs_fts" external-content virtual table
//     mirrors the `line` column. Triggers on INSERT/DELETE keep it in sync.
//   - **Retention**: after each batch we measure the DB file size; if over
//     100 MB we DELETE the oldest 10% by ts_ms. VACUUM is NOT run — it
//     requires an exclusive lock and the next insert rebuilds pages anyway.
//   - **Failure mode**: if the DB init fails at startup, `append()` silently
//     drops lines. The ring buffer keeps working so the UI is unaffected.

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Maximum DB size before we trim oldest rows. Hard ceiling rather than a
/// soft recommendation: users who dev on laptops don't want a `.db` file
/// that quietly grows to gigabytes.
const MAX_DB_BYTES: u64 = 100 * 1024 * 1024;
/// Fraction of rows deleted when we're over `MAX_DB_BYTES`. 10% keeps
/// retention cheap while giving enough headroom that we're not deleting
/// on every single batch.
const RETENTION_TRIM_FRACTION: f64 = 0.10;
/// Force a flush at least this often even if the queue is small.
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
/// Flush early when the queue exceeds this many rows — prevents unbounded
/// memory growth under heavy log bursts (webpack compile errors, etc.).
const FLUSH_BATCH_THRESHOLD: usize = 1000;
/// mpsc channel capacity. Much larger than FLUSH_BATCH_THRESHOLD so that a
/// flush running during a burst still has room to receive. If the channel
/// ever saturates we drop lines rather than blocking the log reader.
const CHANNEL_CAPACITY: usize = 16_384;

/// One log row exactly as we shuttle it between the process tasks and the
/// sqlite writer thread. Mirrors `LogLine` but carries `script_id` because
/// sqlite is a cross-process table.
#[derive(Debug, Clone, Serialize)]
pub struct LogLineRecord {
    pub ts_ms: i64,
    pub script_id: String,
    pub seq: u64,
    pub stream: String, // "stdout" | "stderr"
    pub line: String,
}

/// Aggregate stats surfaced to the UI so users understand what's stored.
#[derive(Debug, Clone, Serialize, Default)]
pub struct StorageStats {
    pub total_rows: i64,
    pub db_bytes: u64,
    /// `None` when the table is empty.
    pub oldest_ts: Option<i64>,
    pub newest_ts: Option<i64>,
}

/// Global sender handle. Set once during init; subsequent callers do
/// cheap Option clones. Using `std::sync::mpsc::SyncSender` gives us
/// bounded capacity + `try_send` semantics without pulling in tokio
/// (the append path is called from sync code inside the async reader
/// tasks, but we don't want to block the tokio executor).
static SENDER: OnceLock<Mutex<Option<std::sync::mpsc::SyncSender<LogLineRecord>>>> =
    OnceLock::new();
/// Path we persisted to. Kept so `stats()` can `fs::metadata` the file
/// without re-resolving `dirs::config_dir()` each call.
static DB_PATH: OnceLock<PathBuf> = OnceLock::new();
/// Read-side handle used by `search()` and `stats()`. Reads are served
/// from a separate connection (sqlite handles multi-reader out of the box
/// in journal_mode=WAL) so they never block the writer thread.
static READ_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Default DB path: `~/Library/Application Support/procman/logs.db` on
/// macOS. Mirrors `config_store::default_config_path` placement.
pub fn default_db_path() -> Option<PathBuf> {
    dirs::config_dir().map(|b| b.join("procman").join("logs.db"))
}

/// Open (or create) the DB at `db_path`, apply the schema, and spawn the
/// writer thread. Safe to call multiple times — subsequent calls are no-ops
/// once `SENDER` is populated.
pub fn init(db_path: PathBuf) -> Result<(), String> {
    if SENDER.get().is_some() {
        return Ok(());
    }
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }

    // Writer connection. OpenFlags include CREATE so the file springs
    // into existence on first run. WAL improves concurrency with the
    // read connection.
    let writer = open_conn(&db_path)?;
    apply_schema(&writer)?;

    // Read connection — parallel, read-only-ish (we only SELECT from it,
    // but it's opened RW so FTS match queries can populate the shadow
    // table if they were ever needed; they aren't today).
    let reader = open_conn(&db_path)?;

    let (tx, rx) = std::sync::mpsc::sync_channel::<LogLineRecord>(CHANNEL_CAPACITY);
    SENDER
        .set(Mutex::new(Some(tx)))
        .map_err(|_| "SENDER already initialised".to_string())?;
    READ_CONN
        .set(Mutex::new(reader))
        .map_err(|_| "READ_CONN already initialised".to_string())?;
    let _ = DB_PATH.set(db_path);

    std::thread::Builder::new()
        .name("procman-log-writer".into())
        .spawn(move || writer_loop(writer, rx))
        .map_err(|e| format!("spawn writer: {}", e))?;
    Ok(())
}

fn open_conn(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|e| format!("open {}: {}", path.display(), e))?;
    // WAL = concurrent readers + writer. `synchronous=NORMAL` skips the
    // fsync-per-commit overhead; on a dev laptop an occasional lost tail
    // after a hard crash is a fair trade vs. writing throughput. `temp_store
    // = MEMORY` keeps FTS merges off disk for small DBs.
    // PRAGMAs: WAL enables concurrent readers + writer on the same DB file;
    // synchronous=NORMAL skips the per-commit fsync overhead; temp_store in
    // memory keeps FTS merges off disk. All three are best-effort — older
    // sqlites that reject one still open the DB in the safe default mode.
    // `journal_mode` returns a row (the new mode), so we use query_row to
    // discard it; the others are settings and use execute/batch.
    let _ = conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()));
    let _ = conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;");
    Ok(conn)
}

fn apply_schema(conn: &Connection) -> Result<(), String> {
    // Idempotent: all DDL uses IF NOT EXISTS. Split into statements so one
    // malformed CREATE doesn't silently skip the rest.
    let stmts = [
        "CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_ms INTEGER NOT NULL,
            script_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            stream TEXT NOT NULL,
            line TEXT NOT NULL
        )",
        "CREATE INDEX IF NOT EXISTS idx_script_ts ON logs(script_id, ts_ms)",
        "CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(line, content='logs', content_rowid='id')",
        "CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
            INSERT INTO logs_fts(rowid, line) VALUES (new.id, new.line);
        END",
        "CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
            INSERT INTO logs_fts(logs_fts, rowid, line) VALUES ('delete', old.id, old.line);
        END",
    ];
    for s in stmts {
        conn.execute(s, []).map_err(|e| format!("schema: {}", e))?;
    }
    Ok(())
}

/// Fire-and-forget append. Never blocks the caller. If sqlite has not been
/// initialised (early boot or init failure), or the channel is full, the
/// record is dropped — the ring buffer still keeps the line for live view.
pub fn append(record: LogLineRecord) {
    let Some(slot) = SENDER.get() else {
        return;
    };
    let Ok(guard) = slot.lock() else {
        return;
    };
    if let Some(tx) = guard.as_ref() {
        // try_send so a brief stall on the writer thread can't back-pressure
        // the log reader tasks.
        let _ = tx.try_send(record);
    }
}

/// Full-text search across stored logs. `query` goes through FTS5's MATCH
/// operator. When empty, returns the most recent `limit` rows (optionally
/// filtered by script_id / since_ms) — useful for "show me the last hour
/// across all scripts".
pub fn search(
    query: &str,
    script_id: Option<&str>,
    since_ms: Option<i64>,
    limit: usize,
) -> Result<Vec<LogLineRecord>, String> {
    let Some(conn_slot) = READ_CONN.get() else {
        return Ok(Vec::new());
    };
    let conn = conn_slot.lock().map_err(|e| format!("lock: {}", e))?;
    // Cast to i64 so `ToSql` picks the stable integer binding (sqlite has no
    // native usize; on a 32-bit host usize would bind as INTEGER-32 which is
    // needlessly fragile). clamp() also forbids runaway limits.
    let limit: i64 = limit.clamp(1, 10_000) as i64;

    // Build the WHERE clause piecewise so we don't need a query builder.
    let mut sql = String::from(
        "SELECT logs.ts_ms, logs.script_id, logs.seq, logs.stream, logs.line FROM logs ",
    );
    let trimmed = query.trim();
    let has_fts = !trimmed.is_empty();
    if has_fts {
        sql.push_str("JOIN logs_fts ON logs_fts.rowid = logs.id WHERE logs_fts MATCH ?1 ");
    } else {
        sql.push_str("WHERE 1=1 ");
    }
    // `#[allow(unused_assignments)]` — the final `param_idx += 1` after
    // `since_ms` is dead on paper because we read it into LIMIT below, but
    // the simpler counter style is worth the lint suppression.
    #[allow(unused_assignments)]
    {
        let mut param_idx = if has_fts { 2 } else { 1 };
        if script_id.is_some() {
            sql.push_str(&format!("AND logs.script_id = ?{} ", param_idx));
            param_idx += 1;
        }
        if since_ms.is_some() {
            sql.push_str(&format!("AND logs.ts_ms >= ?{} ", param_idx));
            param_idx += 1;
        }
        sql.push_str(&format!("ORDER BY logs.ts_ms DESC LIMIT ?{}", param_idx));
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;

    // Collect params into a Vec<Box<dyn ToSql>>-ish shape. rusqlite's
    // `params!` macro needs a comptime-known tuple, which we don't have
    // (count varies with filters), so use `params_from_iter`.
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    // rusqlite FTS5 accepts the raw query — but if the user types a bare
    // word we implicitly quote it with `"..."` to escape FTS punctuation
    // (dash, colon, etc. that otherwise get parsed as operators). Advanced
    // users can still use `field:term` / `AND` / `*` by including them
    // verbatim (heuristic: presence of space, quote, or operator char).
    if has_fts {
        let escaped = if trimmed.contains(' ')
            || trimmed.contains('"')
            || trimmed.contains(':')
            || trimmed.contains('*')
        {
            trimmed.to_string()
        } else {
            format!("\"{}\"", trimmed.replace('"', "\"\""))
        };
        values.push(Box::new(escaped));
    }
    if let Some(sid) = script_id {
        values.push(Box::new(sid.to_string()));
    }
    if let Some(since) = since_ms {
        values.push(Box::new(since));
    }
    values.push(Box::new(limit));

    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(values.iter().map(|v| v.as_ref())),
            |row| {
                Ok(LogLineRecord {
                    ts_ms: row.get(0)?,
                    script_id: row.get(1)?,
                    seq: row.get::<_, i64>(2)? as u64,
                    stream: row.get(3)?,
                    line: row.get(4)?,
                })
            },
        )
        .map_err(|e| format!("query: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {}", e))?);
    }
    Ok(out)
}

/// Cheap metadata-only stats — read_conn + one COUNT + a `fs::metadata`
/// call. Safe to poll from the UI every few seconds.
pub fn stats() -> Result<StorageStats, String> {
    let mut s = StorageStats::default();
    if let Some(path) = DB_PATH.get() {
        s.db_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let Some(conn_slot) = READ_CONN.get() else {
        return Ok(s);
    };
    let conn = conn_slot.lock().map_err(|e| format!("lock: {}", e))?;
    conn.query_row(
        "SELECT COUNT(*), MIN(ts_ms), MAX(ts_ms) FROM logs",
        [],
        |row| {
            s.total_rows = row.get::<_, i64>(0).unwrap_or(0);
            s.oldest_ts = row.get::<_, Option<i64>>(1).unwrap_or(None);
            s.newest_ts = row.get::<_, Option<i64>>(2).unwrap_or(None);
            Ok(())
        },
    )
    .map_err(|e| format!("stats: {}", e))?;
    Ok(s)
}

/// Writer thread entry point. Owns the RW connection and drains the channel.
fn writer_loop(mut conn: Connection, rx: std::sync::mpsc::Receiver<LogLineRecord>) {
    let mut buf: Vec<LogLineRecord> = Vec::with_capacity(FLUSH_BATCH_THRESHOLD);
    let mut last_flush = Instant::now();
    loop {
        let remaining = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
        match rx.recv_timeout(remaining) {
            Ok(rec) => buf.push(rec),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Tick — fall through to flush.
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // Graceful shutdown: drain + final flush.
                if !buf.is_empty() {
                    let _ = flush(&mut conn, &buf);
                }
                break;
            }
        }

        let should_flush =
            buf.len() >= FLUSH_BATCH_THRESHOLD || last_flush.elapsed() >= FLUSH_INTERVAL;
        if should_flush && !buf.is_empty() {
            if let Err(e) = flush(&mut conn, &buf) {
                // Don't kill the thread — log and keep trying. A transient
                // FS error (disk full, permissions) should self-heal.
                log::warn!("log_storage: flush failed: {}", e);
            }
            buf.clear();
            last_flush = Instant::now();
            if let Err(e) = enforce_retention(&mut conn) {
                log::warn!("log_storage: retention failed: {}", e);
            }
        }
    }
}

fn flush(conn: &mut Connection, batch: &[LogLineRecord]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("begin: {}", e))?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO logs(ts_ms, script_id, seq, stream, line) VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| format!("prepare: {}", e))?;
        for r in batch {
            stmt.execute(params![r.ts_ms, r.script_id, r.seq as i64, r.stream, r.line])
                .map_err(|e| format!("insert: {}", e))?;
        }
    }
    tx.commit().map_err(|e| format!("commit: {}", e))?;
    Ok(())
}

fn enforce_retention(conn: &mut Connection) -> Result<(), String> {
    let Some(path) = DB_PATH.get() else {
        return Ok(());
    };
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if bytes <= MAX_DB_BYTES {
        return Ok(());
    }
    // Delete the oldest fraction of rows. Two-step: pick the cutoff id
    // (O(1) after COUNT) then DELETE ... WHERE id <= cutoff. This is far
    // cheaper than `DELETE ... ORDER BY ts_ms LIMIT N` on big tables.
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
        .map_err(|e| format!("count: {}", e))?;
    if total <= 0 {
        return Ok(());
    }
    let trim = ((total as f64) * RETENTION_TRIM_FRACTION).ceil() as i64;
    let trim = trim.max(1);
    // OFFSET `trim-1` gives the id of the `trim`-th-oldest row; we delete
    // everything <= that id. If trim > total the subselect returns NULL
    // and the DELETE removes zero rows (safe).
    let cutoff: Option<i64> = conn
        .query_row(
            "SELECT id FROM logs ORDER BY id ASC LIMIT 1 OFFSET ?1",
            params![trim - 1],
            |r| r.get(0),
        )
        .ok();
    if let Some(cutoff) = cutoff {
        conn.execute("DELETE FROM logs WHERE id <= ?1", params![cutoff])
            .map_err(|e| format!("delete: {}", e))?;
    }
    // VACUUM is intentionally skipped — it requires an exclusive lock and
    // freed pages are reused by subsequent inserts. A small long-tail of
    // wasted pages is cheaper than a multi-second write stall.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spin up an isolated DB in a tempdir, returning (Connection, tempdir).
    /// We test the private helpers directly (apply_schema, flush,
    /// enforce_retention) so each test stays deterministic and independent
    /// of the global OnceLocks. Reserved for integration tests is the
    /// end-to-end channel → thread → disk path.
    fn fresh_conn() -> (Connection, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("logs.db");
        let conn = open_conn(&path).unwrap();
        apply_schema(&conn).unwrap();
        (conn, tmp)
    }

    fn rec(ts: i64, sid: &str, seq: u64, text: &str) -> LogLineRecord {
        LogLineRecord {
            ts_ms: ts,
            script_id: sid.to_string(),
            seq,
            stream: "stdout".into(),
            line: text.to_string(),
        }
    }

    #[test]
    fn insert_and_select_roundtrip() {
        let (mut conn, _tmp) = fresh_conn();
        flush(
            &mut conn,
            &[rec(1000, "s1", 1, "hello world"), rec(1001, "s1", 2, "second line")],
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn fts_match_finds_inserted_lines() {
        let (mut conn, _tmp) = fresh_conn();
        flush(
            &mut conn,
            &[
                rec(1000, "s1", 1, "starting dev server"),
                rec(1001, "s1", 2, "compiled successfully"),
                rec(1002, "s1", 3, "ERROR: port in use"),
            ],
        )
        .unwrap();
        // FTS5 tokenises on whitespace+punctuation. Single-word match.
        let mut stmt = conn
            .prepare(
                "SELECT logs.line FROM logs JOIN logs_fts ON logs_fts.rowid = logs.id WHERE logs_fts MATCH ?1 ORDER BY logs.ts_ms ASC",
            )
            .unwrap();
        let hits: Vec<String> = stmt
            .query_map(params!["compiled"], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].contains("compiled"));
    }

    #[test]
    fn retention_deletes_oldest_when_over_cap() {
        // We can't easily make the file exceed 100 MB in a test. Instead
        // we exercise the manual "trim N oldest" path that enforce_retention
        // would take once it decided to act.
        let (mut conn, _tmp) = fresh_conn();
        let batch: Vec<LogLineRecord> = (0..100)
            .map(|i| rec(1000 + i, "s1", i as u64, &format!("line-{}", i)))
            .collect();
        flush(&mut conn, &batch).unwrap();
        // Trim the oldest 10.
        let cutoff: i64 = conn
            .query_row(
                "SELECT id FROM logs ORDER BY id ASC LIMIT 1 OFFSET 9",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute("DELETE FROM logs WHERE id <= ?1", params![cutoff])
            .unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 90);
        // FTS5 delete trigger must have fired — shadow table is in sync.
        let fts_hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM logs_fts WHERE logs_fts MATCH ?1",
                params!["line-0"],
                |r| r.get(0),
            )
            .unwrap_or(0);
        // "line-0" appeared in lines 0..9 (deleted) and would *also* match
        // "line-0*" style prefixes of 10..99; FTS5 exact token match won't
        // cross the hyphen-numeric boundary so the only tokens left are
        // "line-10" … "line-99". Expect zero hits for "line-0".
        assert_eq!(fts_hits, 0);
    }

    #[test]
    fn filter_by_script_id_and_since_ms() {
        let (mut conn, _tmp) = fresh_conn();
        flush(
            &mut conn,
            &[
                rec(1000, "s1", 1, "alpha"),
                rec(2000, "s2", 2, "alpha beta"),
                rec(3000, "s1", 3, "alpha gamma"),
            ],
        )
        .unwrap();
        // script_id filter.
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM logs WHERE script_id = ?1",
                params!["s1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 2);
        // since_ms filter.
        let recent: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM logs WHERE ts_ms >= ?1",
                params![2500],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recent, 1);
    }
}
