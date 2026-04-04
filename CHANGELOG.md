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

### 발견된 Critical 이슈
- **Tauri Issue #7684**: 대용량 stdout(20k+ 라인) 처리 시 라인 유실 + 좀비 프로세스. Week 0 스파이크로 검증 필수.
