# procman — Mac Process Manager GUI

## 프로젝트 한 줄 소개
> **로컬 개발환경의 모든 러닝 프로세스를 한 화면에서 장악하는 개인용 Mission Control.**

1인 개발자가 VSCode 10개 + 터미널 10개 + Docker + Cloudflare Tunnel을 동시에 관리하는 페인을 해결하기 위한 Mac 전용 GUI 툴.

## 핵심 기능 (MVP)
1. **스크립트 등록/관리** — VSCode에서 작성한 .sh/.js/.py 등을 경로 지정으로 등록 (경로 참조 방식, 내부 복사 X)
2. **프로세스 실행 제어** — 시작/중지/재시작, running/stopped/error 상태 인디케이터
3. **로그 뷰어** — stdout/stderr 실시간 스트리밍, 프로세스별 탭
4. **포트 관리** — 포트 충돌 감지 + **원클릭 해결** (킬러 기능)
5. **그룹 프로파일** — "Morning Stack" 같은 묶음 실행
6. **설정 영속화** — YAML (git 친화적)

## 기술 스택 (확정 대기)
- **Plan A**: Tauri v2 (Rust backend + React/TS frontend + shadcn/ui)
- **Plan B**: Electron + node-pty (Plan A 스파이크 실패 시 fallback)
- **Plan C (장기)**: Swift 헬퍼 + Tauri/Electron 하이브리드

**현재 상태**: Week 0 스파이크 4건 결과 대기. 사용자의 Rust 숙련도 확답 필요.

## 프로젝트 범위

### In-Scope (MVP, 6~7주)
- 스크립트/프로젝트 CRUD
- 프로세스 spawn/kill (login shell, 좀비 제로)
- 로그 스트리밍 (ring buffer 5000줄)
- 포트 충돌 감지 + 원클릭 해결
- 그룹 실행 + ⌘K 커맨드 팔레트
- DMG 배포 + 코드서명

### Out-of-Scope (MVP 이후)
- Docker 컨테이너 직접 제어 (v0.2)
- Cloudflare Tunnel 전용 UI (v0.2)
- VSCode 연동 (v0.3)
- 메트릭 대시보드 (v0.3)
- 팀 공유 기능 (v1.0)
- 장기 로그 검색 (xterm.js 성능 불확실성)
- E2E 자동화 테스트 (WKWebView WebDriver 부재)

## 주요 리스크
- **R1 좀비 프로세스** — tokio process_group + pgid 단위 kill로 대응
- **R2 nvm/pyenv PATH** — `zsh -l -c` login shell 래핑
- **R3 로그 메모리 폭증** — 프로세스당 ring buffer 5000줄 상한
- **R4 스코프 크리프** — Charter 엄수, 매 스프린트 리뷰
- **R5 Tauri stdout 버그 (#7684)** — Week 0 스트레스 스파이크로 검증 필수

## 5-Agent 워크플로우
이 프로젝트는 5명의 에이전트 시스템으로 운영된다 (`~/.claude/agents/`):

| # | 에이전트 | 역할 |
|---|---------|------|
| 1 | **manager** | 총괄/의사결정/최종보고 |
| 2 | **planner** | 업무 분해/분배/조율 |
| 3 | **worker** | 실제 구현/서브에이전트 호출 |
| 4 | **evaluator** | 품질 평가/rubric/피드백 |
| 5 | **user-tester** | UX 직접 체험/사용자 관점 |

**Flow**: `User → Manager → Planner → Worker → Evaluator + User-tester → (피드백 루프)`

## 문서
- [docs/01-charter.md](docs/01-charter.md) — Manager: 프로젝트 차터
- [docs/02-tech-research.md](docs/02-tech-research.md) — Worker: 기술 스택 비교
- [docs/03-ux-vision.md](docs/03-ux-vision.md) — User-tester: UX 비전/페르소나
- [docs/04-evaluation.md](docs/04-evaluation.md) — Evaluator: 스택 독립 검증
- [docs/05-roadmap-wbs.md](docs/05-roadmap-wbs.md) — Planner: WBS/스프린트 로드맵
- [docs/06-decision.md](docs/06-decision.md) — Manager: 최종 의사결정

## 핵심 규칙
- **수정사항마다 `TODO.md` / `CHANGELOG.md` / `README.md` 업데이트 필수** (사용자 피드백 규칙)
- 에이전트 작업 시 반드시 `~/.claude/agents/{name}.md` 정의를 따를 것
- Scope Creep 금지 — Docker/Tunnel/VSCode 연동은 MVP 이후

## 현재 마일스톤
**Week 0 (대기 중)**: 사용자 Q1~Q3 확답 → 스파이크 4건(4.5일) 실행 → Tauri/Electron 확정

사용자 확답 필요 항목:
- Q1: Rust 숙련도 (Critical)
- Q2: 타임라인 (7주 안전 / 6주 타이트)
- Q3: 크로스플랫폼 확장 의향
