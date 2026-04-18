# Week 0 Spikes (Archival)

> ⚠️ **This directory is a historical record of the 2026-04-05 Week 0 spike process.**
> For current development status, see the [root README](../README.md) and [TODO.md](../TODO.md).

## Outcome summary
Tauri v2 locked in. Every gate passed, MVP → Post-MVP S1–S5 → mobile all shipped afterwards.

Consolidated final verdict: [FINAL-VERDICT.md](FINAL-VERDICT.md)

## Spike list
| # | Directory | Result | Verdict |
|---|---------|------|---------|
| S1 | [s1-stdout/](s1-stdout/) | ✅ GO — 53k events/sec, zero drops | [REPORT.md](s1-stdout/REPORT.md) |
| S2 | [s2-pty/](s2-pty/) | ✅ GO — docker/python/ANSI all clean | [REPORT.md](s2-pty/REPORT.md) |
| S3 | [s3-xterm/](s3-xterm/) | ✅ effectively GO — avg 59.9fps | [REPORT.md](s3-xterm/REPORT.md) |
| S4 | (skipped) | User chose Option C — risk accepted | — |

## Directory layout
- `tauri-harness/` — original Tauri v2 spike harness (later promoted to `app/` via `git mv` to preserve history)
- `s1-stdout/`, `s2-pty/`, `s3-xterm/` — measurement/verdict artifacts per spike

The Electron Plan B skeleton was removed once Tauri was confirmed (no longer needed).

---

# Week 0 스파이크 (Archival, 한국어)

> ⚠️ **이 디렉토리는 2026-04-05 Week 0 스파이크 과정의 역사 기록입니다.**
> 현재 개발 상태는 [루트 README](../README.md)와 [TODO.md](../TODO.md) 참고.

## 결과 요약
Tauri v2 확정. 모든 게이트 통과 후 MVP → Post-MVP S1-S5 → 모바일까지 완료된 상태.

최종 통합 판정서: [FINAL-VERDICT.md](FINAL-VERDICT.md)

## 스파이크 목록
| # | 디렉토리 | 결과 | 판정서 |
|---|---------|------|---------|
| S1 | [s1-stdout/](s1-stdout/) | ✅ GO — 53k events/sec, zero drops | [REPORT.md](s1-stdout/REPORT.md) |
| S2 | [s2-pty/](s2-pty/) | ✅ GO — docker/python/ANSI 정상 | [REPORT.md](s2-pty/REPORT.md) |
| S3 | [s3-xterm/](s3-xterm/) | ✅ effectively GO — avg 59.9fps | [REPORT.md](s3-xterm/REPORT.md) |
| S4 | (skipped) | 사용자 Option C — 리스크 감수 | — |

## 디렉토리 구조
- `tauri-harness/` — Tauri v2 스파이크 원본 (이후 `app/`으로 승격됨, git mv로 history 보존)
- `s1-stdout/`, `s2-pty/`, `s3-xterm/` — 각 스파이크 측정/판정 산출물

Electron Plan B 스켈레톤은 확정 후 제거됨 (Tauri 확정으로 불필요).
