# Week 0 Spikes

Manager 의사결정(2026-04-05) 에 따른 Tauri/Electron 판정용 스파이크 4건.

## 스파이크 목록
| # | 디렉토리 | 기간 | Go 기준 |
|---|---------|------|---------|
| S1 | [s1-stdout/](s1-stdout/) | 1.5일 | 10proc×10k line/s, 유실 0, RSS<150MB |
| S2 | [s2-pty/](s2-pty/) | 1.0일 | docker/python/ssh 인터랙션 정상 |
| S3 | [s3-xterm/](s3-xterm/) | 0.5일 | 10만 라인 평균 60fps |
| S4 | [s4-rust/](s4-rust/) | 1.0일 | 사용자 Rust self-assessment |

## 전환 트리거 (Plan B/Electron 전환 조건)
1. S1 No-Go (유실 발생 or RSS ≥ 150MB)
2. S4 No-Go (사용자 1일 내 완수 실패)
3. 누적 스파이크 5일 초과

## 디렉토리 구조
- `tauri-harness/` — Tauri v2 스파이크용 프로젝트
- `plan-b-electron/` — Electron + node-pty Plan B 스켈레톤 (전환 대비)
- `s1-stdout/`, `s2-pty/`, `s3-xterm/`, `s4-rust/` — 각 스파이크 측정/판정 산출물

최종 통합 판정서: `FINAL-VERDICT.md` (Day 5 EOD 작성 예정)
