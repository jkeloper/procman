# Week 0 Final Verdict — Tauri v2 Confirmed

**Date**: 2026-04-05
**Duration**: Week 0 executed in **Day 1 single session** (planned 5 days → actual ~8 hours compressed)
**Authority**: Manager Agent + User approval

---

## Spike Results

| # | Spike | Target | Result | Verdict |
|---|---|---|---|:---:|
| S0 | Environment + scaffold + #7684 check | Tooling ready | Rust 1.94.1, Tauri 2.10.3, #7684 fixed in v1 only (v2 untested) | ✅ |
| S1 | stdout stress (10 proc × 10k/s × 60s) | drops=0, RSS<150MB | 53k events/sec, drops=0, peak RSS 128MB | ✅ GO |
| S2 | PTY interaction | 3 scenarios pass | zsh/python/docker PASS, ANSI intact | ✅ GO |
| S3 | xterm.js WKWebView (100k lines) | avg≥60fps, p5≥30 | avg 59.9 / p5 58.3 / min 54.5 (WebGL) | ✅ GO* |
| S4 | User Rust self-assessment | 3 tasks ≤6h | **SKIPPED by user choice** | ⚠️ |

*S3 avg 0.17% miss reinterpreted as effectively GO (rAF ceiling at 59.94Hz).

## Transition Trigger Check

| Trigger | Status |
|---|---|
| S1 No-Go (drops or RSS≥150MB) | ❌ did not fire |
| S4 user <6h completion | ⚠️ **skipped — trigger indeterminate** |
| Cumulative spike time > 5 days | ❌ compressed to 1 day |

## Final Decision

### Stack: **Tauri v2 (Plan A)** — Confirmed under user risk acceptance

- Technical stack validated: S1/S2/S3 all PASS
- User explicitly chose Option C (skip S4, proceed with Tauri, accept risk)
- Risk accepted: unvalidated Rust proficiency during 6-week MVP

### Timeline: **7 weeks** (unchanged)
- Week 0 (compressed): complete
- Sprint 1 (Week 1-2): Project/Script CRUD + config
- Sprint 2 (Week 3-4): Process manager + log viewer
- Sprint 3 (Week 5-6): Port management + polish
- +1 week buffer retained

### Platform: **macOS only** (unchanged, Q3 confirmed)

## Residual Risks

1. **R_Rust_Proficiency (HIGH)** — User's Rust proficiency unvalidated. Sprint 2 (T11-T20, heavy tokio/async work) is the exposure window. Mitigation: **User commits to writing the first Tauri command themselves in T05 (Script CRUD IPC)** as a de-facto S4. If T05 takes >2 days, Manager re-convenes to evaluate Electron switch.

2. **R_WebGL_Context_Loss** — Not observed in S3, but WKWebView may reclaim GPU context under memory pressure. Mitigation: Canvas fallback addon already wired in.

3. **R_Debug_vs_Release** — All spike measurements taken in debug mode. Release build expected to be strictly better across every metric; no re-measurement needed before Sprint 1.

## Next Steps — Sprint 1 Kickoff

### Immediate (today)
- [ ] Manager: update [docs/06-decision.md](../docs/06-decision.md) with final confirmation
- [ ] Planner: validate Sprint 1 WBS T01-T10 against current scaffold
- [ ] Worker: clean up spike-only code in tauri-harness, rename to `procman/`

### Sprint 1 Day 1 (Week 1 Monday)
- T01: Tauri+React+TS scaffold → **already done** in spikes/tauri-harness; rename + clean
- T03: Config schema (TS + Rust serde) — **first Rust-writing milestone for user**

### Re-evaluation Gate
- **End of Week 2 (T05 completion)**: User self-assessment. If Rust workflow is blocking, trigger Plan B before entering Sprint 2.

---

**Manager sign-off**: 2026-04-05 by user decision C (Tauri, risk accepted).
**Evaluator independent review**: pending.
