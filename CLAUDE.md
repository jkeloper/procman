# procman — Mac Process Manager GUI

## 프로젝트 한 줄 소개
> **로컬 개발환경의 모든 러닝 프로세스를 한 화면에서 장악하는 개인용 Mission Control.**

VSCode 10개 + 터미널 10개 + Docker + Cloudflare Tunnel을 동시에 관리하는 1인 개발자 페인을 해결하는 Mac 전용 GUI. 데스크톱 Tauri 앱 + 모바일 PWA/iOS 동반 앱으로 구성.

## 현재 상태 (2026-04-18)
🟢 **Post-MVP S1~S5 완료** + 모바일/원격 통합 완료

- Week 0 스파이크(4/5) → MVP Sprint 1-3(4/5 단일 세션) → v0.2 Feature Pack(4/6) → Post-MVP S1-S5(4/15~16) → 모바일 PWA + iOS Capacitor(4/17) 순으로 진행됨
- 현재 릴리즈 준비 구간. 다음 로드맵은 TODO.md 🔮 병렬 선택지 참고.
- Rust 테스트 86개 전부 통과.

## 구현된 기능

### 데스크톱 (`app/`)
- **프로젝트/스크립트 CRUD** — 폴더 선택 → 직접 하위 스캔(`package.json`/`Cargo.toml`/`go.mod`/`pyproject.toml`/`docker-compose.yml`) + 멀티스택 자동 감지
- **프로세스 실행** — `zsh -l -c` 로그인 쉘 래핑, killpg SIGTERM→SIGKILL, 좀비/고아 제로, 크래시 감지
- **로그 뷰어** — 프로세스당 5000줄 ring buffer + `react-window` 가상 스크롤 + `ansi-to-html` 컬러 + substring 검색
- **포트 관리 v2** — 선언형 `PortSpec` 멀티 포트 + 2s `lsof` 폴링 + TCP liveness probe + 원클릭 kill
- **depends_on** — 의존 스크립트 포트 reachable 될 때까지 30s 대기
- **관측성** — CPU%/RSS 2s 수집, 실시간 표시
- **그룹 ("Morning Stack")** — 400ms 딜레이 순차 실행
- **⌘K 커맨드 팔레트** + 단축키 (⌘L 로그, ⌘, 대시보드)
- **세션 복원** — 앱 재시작 시 running 스크립트 일괄 재실행
- **Cloudflare Tunnels** — 설치 감지 + named tunnel run/kill + startup recovery
- **VSCode launch.json import** — 5 타입 + 변수 치환 + JSONC 파서
- **설정 영속화** — `~/Library/Application Support/procman/config.yaml` + runtime.json 분리 + atomic write + FS watcher 자동 리로드

### 모바일 + 원격 (`mobile/`)
- **Remote API** — REST + WebSocket (Cloudflare Tunnel 경유), CORS/CSP 정리
- **모바일 PWA** — S1-S5 기능 전부 동기화, iOS 드래그, QR 페어링으로 즉시 연결
- **iOS Capacitor 앱** — 네이티브 셸 + PWA (Xcode 프로젝트 커밋됨)

## 기술 스택
- **데스크톱**: Tauri v2.10 + Rust 1.85+ + tokio + DashMap + notify + React 18/TS + Vite + shadcn/ui + Tailwind v4
- **로그**: `react-window` + `ansi-to-html`
- **모바일**: Capacitor + React/TS (동일 shadcn 스택)
- **원격**: REST + WebSocket + Cloudflare Tunnel
- **플랫폼**: Mac 전용 (macOS 14+) — 크로스플랫폼 확장 계획 없음

## 핵심 리스크 (전부 해소)
- ✅ R1 좀비 프로세스 — pgid 단위 kill + 에픽 기반 race 방지 (UNI-2)
- ✅ R2 nvm/pyenv PATH — `zsh -l -c` login shell 래핑
- ✅ R3 로그 메모리 폭증 — ring buffer 5000줄 상한
- ✅ R5 Tauri stdout (#7684) — S1 스파이크로 53k events/sec, zero drops 검증

## 5-Agent 워크플로우
`~/.claude/agents/` 정의 기반 운영:

| # | 에이전트 | 역할 |
|---|---------|------|
| 1 | **manager** | 총괄/의사결정/최종보고 |
| 2 | **planner** | 업무 분해/분배/조율 |
| 3 | **worker** | 실제 구현/서브에이전트 호출 |
| 4 | **evaluator** | 품질 평가/rubric/피드백 |
| 5 | **user-tester** | UX 직접 체험/사용자 관점 |

Flow: `User → Manager → Planner → Worker → Evaluator + User-tester → (피드백 루프)`

## 핵심 규칙
- **수정사항마다 `TODO.md` / `CHANGELOG.md` / `README.md` 업데이트 필수** (사용자 피드백 규칙)
- 에이전트 작업 시 반드시 `~/.claude/agents/{name}.md` 정의를 따를 것
- Scope 변경은 TODO.md 🔮 섹션에서만 추가/이동

## 문서 맵
- **[README.md](README.md)** / **[README.en.md](README.en.md)** — 개요 + 기능 + 빌드
- **[TODO.md](TODO.md)** — 작업 체크리스트 + Post-S5 선택지
- **[CHANGELOG.md](CHANGELOG.md)** — 변경 이력
- **[docs/07-port-management-v2.md](docs/07-port-management-v2.md)** — 현행 포트 관리 설계
- **[app/README.md](app/README.md)** — 데스크톱 앱 개발 가이드
- **[mobile/README.md](mobile/README.md)** — 모바일 PWA/iOS 가이드
- **[docs/archive/](docs/archive/)** — Week 0 기획/의사결정 히스토리 (참고용)
- **[spikes/](spikes/)** — Week 0 스파이크 판정 기록 (archival)
