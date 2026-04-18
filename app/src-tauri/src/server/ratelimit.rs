// In-memory per-IP rate limiter + failed-auth circuit breaker.
//
// Replaces tower_governor (which returned 500 under the Tauri runtime when
// the PeerIpKeyExtractor couldn't find ConnectInfo — see commit 4b4ca27).
//
// Two concerns, both keyed by peer IP:
//   1) Global request rate: 60 req/minute per IP (sliding window, bucket).
//   2) Auth failures: 5 consecutive 401s in 60s -> 60s ban.
//
// Everything is kept in memory; state resets when the server restarts.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const REQ_PER_MINUTE: u32 = 60;
const AUTH_FAIL_LIMIT: u32 = 5;
const AUTH_FAIL_WINDOW: Duration = Duration::from_secs(60);
const AUTH_BAN_DURATION: Duration = Duration::from_secs(60);

#[derive(Default)]
struct IpEntry {
    /// Rolling 60s request count bucket: (window_start, count)
    window_start: Option<Instant>,
    count: u32,
    /// Recent auth failure timestamps inside AUTH_FAIL_WINDOW.
    auth_fails: Vec<Instant>,
    /// If set, requests from this IP are rejected until this instant.
    banned_until: Option<Instant>,
}

pub struct RateLimiter {
    inner: Mutex<HashMap<IpAddr, IpEntry>>,
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    Allow,
    Banned,
    TooMany,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Called before handling a request. Allows, denies with 429 (TooMany),
    /// or 429 (Banned) if this IP is currently in the failed-auth ban window.
    pub fn check(&self, ip: IpAddr) -> Decision {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        let entry = map.entry(ip).or_default();

        // Expire ban
        if let Some(until) = entry.banned_until {
            if now < until {
                return Decision::Banned;
            }
            entry.banned_until = None;
        }

        // Reset rolling window if it's stale
        let expired = entry
            .window_start
            .map(|w| now.duration_since(w) >= Duration::from_secs(60))
            .unwrap_or(true);
        if expired {
            entry.window_start = Some(now);
            entry.count = 0;
        }

        if entry.count >= REQ_PER_MINUTE {
            return Decision::TooMany;
        }
        entry.count += 1;
        Decision::Allow
    }

    /// Register a 401 for this IP. Returns true if the IP was just banned.
    pub fn record_auth_failure(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        let entry = map.entry(ip).or_default();
        entry
            .auth_fails
            .retain(|t| now.duration_since(*t) < AUTH_FAIL_WINDOW);
        entry.auth_fails.push(now);
        if entry.auth_fails.len() as u32 >= AUTH_FAIL_LIMIT {
            entry.banned_until = Some(now + AUTH_BAN_DURATION);
            entry.auth_fails.clear();
            true
        } else {
            false
        }
    }

    /// Successful auth wipes the failure history for this IP.
    pub fn record_auth_success(&self, ip: IpAddr) {
        let mut map = self.inner.lock().unwrap();
        if let Some(entry) = map.get_mut(&ip) {
            entry.auth_fails.clear();
        }
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-wide shared limiter. Kept outside ServerState so the middleware
/// stack doesn't need to plumb it through layers that aren't
/// `commands/`-owned.
static GLOBAL: OnceLock<RateLimiter> = OnceLock::new();

pub fn global() -> &'static RateLimiter {
    GLOBAL.get_or_init(RateLimiter::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, d))
    }

    #[test]
    fn allows_within_budget() {
        let rl = RateLimiter::new();
        let a = ip(1);
        for _ in 0..REQ_PER_MINUTE {
            assert_eq!(rl.check(a), Decision::Allow);
        }
    }

    #[test]
    fn blocks_when_budget_exceeded() {
        let rl = RateLimiter::new();
        let a = ip(2);
        for _ in 0..REQ_PER_MINUTE {
            rl.check(a);
        }
        assert_eq!(rl.check(a), Decision::TooMany);
    }

    #[test]
    fn ip_budgets_are_independent() {
        let rl = RateLimiter::new();
        for _ in 0..REQ_PER_MINUTE {
            rl.check(ip(3));
        }
        // Separate IP still has full budget.
        assert_eq!(rl.check(ip(4)), Decision::Allow);
    }

    #[test]
    fn bans_after_five_auth_failures() {
        let rl = RateLimiter::new();
        let a = ip(5);
        for i in 0..AUTH_FAIL_LIMIT {
            let banned = rl.record_auth_failure(a);
            // The 5th call flips the ban on.
            assert_eq!(banned, i + 1 == AUTH_FAIL_LIMIT);
        }
        assert_eq!(rl.check(a), Decision::Banned);
    }

    #[test]
    fn auth_success_clears_failures() {
        let rl = RateLimiter::new();
        let a = ip(6);
        rl.record_auth_failure(a);
        rl.record_auth_failure(a);
        rl.record_auth_success(a);
        // Three more failures shouldn't trigger ban (cleared to zero).
        assert!(!rl.record_auth_failure(a));
        assert!(!rl.record_auth_failure(a));
        assert!(!rl.record_auth_failure(a));
        assert_eq!(rl.check(a), Decision::Allow);
    }
}
