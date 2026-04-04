# Tauri Issue #7684 — Fix Status Verification (S0.6)

**Verified**: 2026-04-05

## Finding

| Item | Value |
|---|---|
| Issue | tauri-apps/tauri#7684 — stdout 20k+ lines 유실 + 좀비 |
| Fix PR | tauri-apps/tauri#9698 |
| Fix commit | `c5b3751` (retry event emit on channel busy) |
| Merge target | **1.x branch only** (merged 2024-05-28) |
| First v1 release | ≥ v1.6.x (inferred from PR #9871 "Apply Version Updates v1" on 2024-06-25) |
| **v2 status** | **UNVERIFIED — fix was NOT back-ported to v2 branch** |

## Current stack
- `@tauri-apps/cli`: 2.10.1
- `tauri` crate: 2.10.3
- `tauri-build`: 2.5.6

## Implication

The v2 event loop and shell plugin were rewritten. The original v1 bug (#7684)
may or may not manifest in v2. **Empirical verification via S1 stress test
is mandatory.**

## Judgment
- ⚠️ **PARTIAL GO** — Cannot rely on #7684 fix alone.
- Proceed to S1 stdout stress test (10 proc × 10k line/s × 60s).
- **If S1 reproduces line drops in v2** → raise new issue + **trigger Plan B**.
- If S1 passes → treat v2 event loop as healthy for procman MVP.

## References
- https://github.com/tauri-apps/tauri/issues/7684
- https://github.com/tauri-apps/tauri/pull/9698
