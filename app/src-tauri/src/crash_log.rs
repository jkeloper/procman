// File-based crash logger for panics and explicit error reports.
//
// Writes to `<config dir>/crash.log` (same directory as config.yaml /
// runtime.json). On install the panic hook appends the payload plus a
// backtrace so a user who hits a hard failure can ship one file back.
// No external service (sentry etc.) — self-contained.
//
// Rotation is intentionally trivial: once the file tops 1 MB it's
// renamed to `crash.log.old` and a fresh file starts. One backup is
// enough for post-mortem; crash bursts rotate in place.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_BYTES: u64 = 1024 * 1024;

static CRASH_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Install the panic hook and memoize the crash-log path. Safe to call
/// multiple times (second call is a no-op via OnceLock).
pub fn init(path: PathBuf) {
    if CRASH_PATH.set(path).is_err() {
        // Already initialized — keep the first path. Idempotent on
        // repeated setup calls.
        return;
    }
    redirect_stderr_best_effort();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let payload = format_panic(info, &backtrace.to_string());
        write_entry(&payload);
        // Preserve default behavior (stderr + abort-on-panic=unwind rules).
        default_hook(info);
    }));
}

/// Mirror stderr into the crash log on unix, so a panic's default hook
/// output also lands in the file when the app is bundled (no terminal).
/// Best-effort: if dup2 fails we silently skip — the panic hook above is
/// still sufficient for structured capture. Disabled under `cfg(test)`
/// so `cargo test` output stays on the real stderr.
#[cfg(all(unix, not(test)))]
fn redirect_stderr_best_effort() {
    use std::os::unix::io::AsRawFd;
    let Some(path) = CRASH_PATH.get() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    // Safety: dup2 on a valid fd is sound; we leak the File so the fd
    // outlives this function (we actually want it alive for the process
    // lifetime). `mem::forget` is the right call here — closing would
    // invalidate the dup target.
    let fd = file.as_raw_fd();
    unsafe {
        let _ = libc::dup2(fd, libc::STDERR_FILENO);
    }
    std::mem::forget(file);
}

#[cfg(any(not(unix), test))]
fn redirect_stderr_best_effort() {}

/// Append a free-form message to the crash log. Useful for non-panic
/// but still-noteworthy failures (bootstrap misconfig, unexpected
/// recoveries, etc.). No-op if `init()` hasn't set a path yet — we
/// don't want a missed init to itself panic.
pub fn record(msg: &str) {
    let entry = format!("{} [note]\n{}\n", now_iso(), msg);
    write_entry(&entry);
}

fn write_entry(body: &str) {
    let Some(path) = CRASH_PATH.get() else {
        return;
    };
    if let Err(e) = write_to(path, body) {
        // Don't recurse: emit to stderr and move on.
        eprintln!("crash_log: write failed: {}", e);
    }
}

fn write_to(path: &Path, body: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= MAX_BYTES {
            let rotated = rotated_path(path);
            // Best-effort: ignore failure to remove an old rotation.
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(path, &rotated);
        }
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(body.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

fn rotated_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".old");
    PathBuf::from(s)
}

fn format_panic(info: &std::panic::PanicHookInfo<'_>, backtrace: &str) -> String {
    let payload = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string());
    let loc = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "<unknown>".into());
    format!(
        "{} [panic] at {}\npayload: {}\nbacktrace:\n{}\n",
        now_iso(),
        loc,
        payload,
        backtrace
    )
}

fn now_iso() -> String {
    // Minimal RFC3339-ish timestamp without pulling in chrono.
    // Format: YYYY-MM-DDTHH:MM:SSZ (UTC).
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

/// Proleptic Gregorian; accurate enough for log timestamps. Days counted
/// from 1970-01-01. Derived by standard civil_from_days algorithm (Howard
/// Hinnant), just inlined to avoid a chrono dependency.
fn epoch_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let h = (tod / 3600) as u32;
    let mi = ((tod % 3600) / 60) as u32;
    let s = (tod % 60) as u32;

    // civil_from_days: converts days since 1970-01-01 to (y, m, d)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // OnceLock is process-global, so the install tests have to share
    // one test binary. We serialize them to avoid interleaved panics
    // trashing each other's log file.
    static TEST_GUARD: Mutex<()> = Mutex::new(());

    #[test]
    fn epoch_to_ymdhms_known_dates() {
        // 1970-01-01T00:00:00
        assert_eq!(epoch_to_ymdhms(0), (1970, 1, 1, 0, 0, 0));
        // 2000-01-01T00:00:00 = 946684800
        assert_eq!(epoch_to_ymdhms(946_684_800), (2000, 1, 1, 0, 0, 0));
        // 2024-02-29T00:00:00 = 1709164800 (leap day smoke test)
        assert_eq!(epoch_to_ymdhms(1_709_164_800), (2024, 2, 29, 0, 0, 0));
        // 2026-04-18T12:34:56Z = 1776515696
        assert_eq!(
            epoch_to_ymdhms(1_776_515_696),
            (2026, 4, 18, 12, 34, 56)
        );
    }

    #[test]
    fn record_writes_when_initialized() {
        let _g = TEST_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crash.log");
        // OnceLock persists across tests — set is idempotent. If another
        // test set a different path first, direct-call write_to to bypass.
        write_to(&path, "hello\n").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("hello"));
    }

    #[test]
    fn rotation_happens_past_limit() {
        let _g = TEST_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crash.log");
        // Pre-fill to just under 1 MB, then one more write triggers rotate.
        fs::write(&path, vec![b'x'; MAX_BYTES as usize]).unwrap();
        write_to(&path, "trigger-rotate").unwrap();
        assert!(rotated_path(&path).exists());
        // New file should be the post-rotate small one.
        let size = fs::metadata(&path).unwrap().len();
        assert!(size < MAX_BYTES);
    }

    #[test]
    fn format_panic_includes_payload_and_location() {
        let _g = TEST_GUARD.lock().unwrap();
        // Hook-swap needs to be serialized with the other panic-aware
        // tests — TEST_GUARD above provides that.
        let before = std::panic::take_hook();
        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let captured_c = captured.clone();
        std::panic::set_hook(Box::new(move |info| {
            let s = format_panic(info, "<bt>");
            *captured_c.lock().unwrap() = s;
        }));
        let _ = std::panic::catch_unwind(|| panic!("deliberate-test-boom"));
        std::panic::set_hook(before);
        let text = captured.lock().unwrap().clone();
        assert!(text.contains("deliberate-test-boom"));
        assert!(text.contains("[panic]"));
        assert!(text.contains("<bt>"));
    }

    #[test]
    fn record_is_safe_when_not_initialized() {
        let _g = TEST_GUARD.lock().unwrap();
        // After other tests may have set the OnceLock, record() still
        // must not panic. Repeated calls are fine.
        record("safety-check-1");
        record("safety-check-2");
    }
}
