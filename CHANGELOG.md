# Changelog

## [Unreleased]

### 2026-04-05 — 프로젝트 착수 (기획 단계)
- **Added** 프로젝트 디렉토리 구조 생성 (`/Users/jeonghwankim/projects/procman/`)
- **Added** 5-Agent 시스템 운영 (Manager / Planner / Worker / Evaluator / User-tester)
- **Added** 기획 문서 6종 작성:
  - `docs/01-charter.md` — Manager의 프로젝트 차터 (비전, KPI, 범위, 리스크)
  - `docs/02-tech-research.md` — Worker의 기술 스택 비교 (Swift/Tauri/Electron/Flutter/Wails)
  - `docs/03-ux-vision.md` — User-tester의 UX 비전 (페르소나, 유저저니, 와이어프레임)
  - `docs/04-evaluation.md` — Evaluator의 스택 독립 검증 (rubric + 가중 채점)
  - `docs/05-roadmap-wbs.md` — Planner의 WBS (28작업, 3스프린트 × 2주)
  - `docs/06-decision.md` — Manager의 최종 의사결정 (스파이크 기반 조건부 승인)
- **Decided** MVP 범위: 스크립트 등록, 실행 제어, 로그 뷰어, 포트 관리, 그룹 프로파일, YAML 설정
- **Decided** Mac 전용, 단일 사용자(MVP), JSON/YAML 저장, 환경변수 주입 방식 포트 편집
- **Pending** 기술 스택 확정 (Tauri vs Electron) — Week 0 스파이크 4건 결과 대기
- **Pending** 사용자 확답: Rust 숙련도, 타임라인, 플랫폼 범위, 시드 데이터

### 2026-04-05 — Week 0 Blocker 해소
- **Decided** Q3 크로스플랫폼: **Mac 전용 영구 확정** (사용자 확답)
- **Decided** Q2 타임라인: **7주 안전** (스파이크 1주 + MVP 6주) — Manager+Planner 협의
- **Decided** Q1 Rust 숙련도: **DEFERRED** — Week 0 S4 (Rust self-assessment 1일)로 실증 판정
  - 전환 트리거 3건 명시: S1 No-Go / S4 미완수 / 스파이크 5일 초과 → Plan B(Electron) 즉시 전환
- **Scheduled** Week 0 스파이크 D-Day: **2026-04-06(월)** 착수

### 2026-04-05 — Week 0 Day 1 실행 (D-Day 조기 착수)
- **Added** Git repo 초기화 (main branch, `.gitignore`, `.tool-versions`)
- **Added** 개발 환경 구축: pnpm 10.33.0 (brew), Rust stable 1.94.1 (rustup), hyperfine
- **Added** [spikes/](spikes/) 디렉토리 구조 (S1~S4 + tauri-harness + plan-b-electron)
- **Added** S0.4 Tauri v2.10.3 스캐폴드 (Vite + React-TS, identifier: `dev.procman.spike`)
- **Added** S0.5 Electron Plan B 스켈레톤 (IPC ping-pong + node-pty placeholder, dormant)
- **Added** S0.6 Tauri Issue #7684 상태 검증: PR#9698 은 v1.x에만 merge, v2 empirical 검증 필요
- **Added** S1.1 [line-emitter.sh](spikes/s1-stdout/line-emitter.sh) — deterministic SEQ/EID/T 생성기
- **Added** S1.2 Tauri Rust stress harness ([stress.rs](spikes/tauri-harness/src-tauri/src/stress.rs)) — `start_stress`/`stop_stress`/`get_stats`/`get_rss_kb` 커맨드 + mach_task RSS 샘플러, `cargo check` 통과
- **Added** S1.3 + S1.4 FE UI ([App.tsx](spikes/tauri-harness/src/App.tsx)) — per-eid seq gap 검출, 1s RSS 폴링, CSV 다운로드, Go/No-Go 자동 판정
- **Next** Day 2 (04-06 월): 첫 `pnpm tauri dev` 빌드 (5~10분) → S1.5 측정 3회 → S1.6 판정서

### 2026-04-05 — Day 2 S1 측정 완료 ✅ GO
- **Fixed** line-emitter bash → Rust 재작성 ([line-emitter.rs](spikes/s1-stdout/line-emitter.rs)). bash/perl 버전은 목표 속도의 0.8%만 달성 (stress test로 무효). Rust 컴파일 버전은 standalone 10k/sec 정확히 달성 확인
- **Fixed** Tauri devUrl 포트 5173 → 1420 (사용자 moyeo 프로젝트 Vite와 충돌. **아이러니: procman이 해결하려는 바로 그 종류의 버그**)
- **Fixed** `UnlistenFn` type-only import 이슈
- **Added** S1.5 측정 3회 (10proc × 10k/s target × 60s)
- **Added** [spikes/s1-stdout/REPORT.md](spikes/s1-stdout/REPORT.md) — S1.6 판정서
- **Finding** Tauri v2 이벤트 시스템 지속 처리량 **~53k events/sec**, 3.4M events/run, **drops=0**, peak RSS 128MB
- **Finding** 병목은 `tokio::process` stdout reader (파이프 역압), app.emit()/listen()이 아님. procman 실사용(1k lines/sec 로그) 대비 50-100× 안전마진
- **Finding** Issue #7684 (v1 라인 유실) v2에서 **재현 안됨** — 이벤트 루프 재작성 이점
- **Decision** 1차 Go/No-Go 게이트 **PASS** → S2 PTY 인터랙션으로 진행

### 발견된 Critical 이슈
- **Tauri Issue #7684**: 대용량 stdout(20k+ 라인) 처리 시 라인 유실 + 좀비 프로세스. Week 0 스파이크로 검증 필수.
