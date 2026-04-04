// High-throughput line emitter (Rust) — replaces bash/perl version which
// could only achieve ~5% of target rate due to interpreter overhead.
//
// Usage: ./line-emitter <rate_per_sec> <duration_sec> <eid>
// Output: SEQ=000001 EID=<id> T=<epoch_ms> DATA=xxxxx... (50 chars)
// Stderr on exit: "EMITTED: <total> lines actual_rate=<rate>/s elapsed=<sec>s"

use std::env;
use std::io::{self, BufWriter, Write};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: {} <rate_per_sec> <duration_sec> <eid>", args[0]);
        std::process::exit(1);
    }
    let rate: u64 = args[1].parse().expect("rate parse");
    let duration_sec: u64 = args[2].parse().expect("duration parse");
    let eid: u32 = args[3].parse().expect("eid parse");

    let padding: String = "x".repeat(50);
    let total = rate * duration_sec;
    let interval_nanos = 1_000_000_000u64 / rate;

    let stdout = io::stdout();
    let mut out = BufWriter::with_capacity(64 * 1024, stdout.lock());

    let start = Instant::now();
    for seq in 1..=total {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        writeln!(
            out,
            "SEQ={:06} EID={} T={} DATA={}",
            seq, eid, now_ms, padding
        )
        .unwrap();

        // Flush every 100 lines so consumer sees them promptly
        if seq % 100 == 0 {
            out.flush().ok();
        }

        // Pace: sleep if we are ahead of expected time for this seq
        let expected = Duration::from_nanos(interval_nanos * seq);
        let elapsed = start.elapsed();
        if expected > elapsed {
            sleep(expected - elapsed);
        }
    }
    out.flush().ok();
    drop(out);

    let elapsed = start.elapsed().as_secs_f64();
    let actual_rate = total as f64 / elapsed;
    eprintln!(
        "EMITTED: {} lines actual_rate={:.0}/s elapsed={:.2}s eid={}",
        total, actual_rate, elapsed, eid
    );
}
