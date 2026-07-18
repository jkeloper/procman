# 🐸 procman

<!-- latest-release: 0.3.0 -->

> **Your local dev environment's Mission Control — one screen for every running process.**

[![Release](https://img.shields.io/github/v/release/jkeloper/procman?color=2b6b3a)](https://github.com/jkeloper/procman/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-black)](https://www.apple.com/macos/)

Mac-only process manager GUI for solo developers juggling many local servers, tunnels, and docker stacks. Desktop Tauri app + mobile PWA/iOS companion.

## Status

**v0.3.0 is the latest stable release.** It includes the targeted refactor (WS1–WS9 — global "All running" view, single piped+PTY runtime, batched port status, config v4). `main` also carries post-release security, CI, and documentation hardening for the next release.

Scripts, grouped launches, a virtualized log viewer, port dashboard, Cloudflare tunnels, session restore, a command palette, and a paired mobile client are covered by passing Rust and frontend test suites. CI also checks formatting, lint, production builds, the landing site, and the VS Code extension.

## Features

- **Mission Control** — One global "All running" view aggregates every running/crashed process across all your projects on a single screen (crashed first, per-project labels, total CPU/RSS), with inline stop/restart/dismiss and multi-project log tracking — so you never have to dig into projects one by one to see what's alive.
- **Scripts** — Auto-detect `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `docker-compose.yml` / `.vscode/launch.json`; start/stop/restart with one click; login-shell (`zsh -l -c`) wrapping so `nvm`/`pyenv` PATHs survive.
- **Logs & terminal** — 5,000-line ring buffer per process, virtualized (`react-window`), ANSI color rendering, substring search, multi-tab switching, tear-off log windows, and an xterm.js PTY shell for interactive scripts. Backed by a SQLite FTS index for persistent history.
- **Ports** — Declarative `ports[]` (multi-port per script; legacy `expected_port` migrated to `ports[0]` in config v4) + visibility-aware batched `lsof` polling + TCP liveness probes; one-click kill on conflicts.
- **Groups** — "Morning Stack" style batches that launch scripts in `depends_on` topological order behind readiness gates (independent members start immediately; a crashed dependency fails fast); individual failures don't block the rest.
- **Mobile** — iOS/PWA companion via Capacitor; QR-code pairing, full S1–S5 feature parity, local notifications for crashes/port conflicts/unreachable procman, pinned direct-LAN access on iOS, and HTTPS Cloudflare Tunnel access in the browser PWA.
- **Scheduling** — Five-field local-time cron schedules can repeat scripts without adding external cron jobs.
- **Auto-updater** — Tauri signed update feed from the GitHub Releases channel.
- **Docker Compose** — First-class project type; compose services are treated as scripts.
- **Session restore** — Running scripts are snapshotted on exit and offered back on the next launch.
- **⌘K palette** — Fuzzy search across projects, scripts, and actions. Shortcuts for log drawer (`⌘L`) and dashboard (`⌘,`).

## Quick Start

Download the latest signed, notarized DMG (Apple Silicon) — no quarantine workaround needed:

```bash
open "https://github.com/jkeloper/procman/releases/latest/download/procman_0.3.0_aarch64.dmg"
```

Prefer building it yourself? `scripts/install.sh` builds and installs from a cloned checkout — see [Build from Source](#build-from-source).

## Build from Source

### Prerequisites
- macOS 14+ (Apple Silicon recommended)
- Rust 1.88+ via `rustup`
- Node and pnpm versions pinned in `.tool-versions`

### Dev loop
```bash
cd app
source "$HOME/.cargo/env"
pnpm install
pnpm tauri dev          # Vite + Tauri window on port 1420, <1s HMR
```

### Production build & install
```bash
./scripts/install.sh            # release build → /Applications/procman.app → launch
./scripts/install.sh --debug    # debug build (~5x faster)
./scripts/install.sh --no-run   # install without launching
```

### Auto-rebuild on source changes
```bash
brew install fswatch
./scripts/watch-install.sh              # debug build, re-installs on every save
./scripts/watch-install.sh --release    # release build
```

For day-to-day work prefer `pnpm tauri dev`; `watch-install.sh` is for "keep the installed copy in sync" scenarios.

## Testing

```bash
# Rust backend (from the repository root)
(cd app/src-tauri && cargo test --lib)

# Desktop frontend (from the repository root)
(cd app && pnpm test)

# Mobile pairing, stream, and notification boundaries
(cd mobile && pnpm test)

# VS Code Webview security and actions
(cd vscode-extension && pnpm test)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete lint, build, and repository-policy gate.

## Architecture

```
procman/
├── app/                  # Tauri desktop app
│   ├── src/              # React + TypeScript frontend (shadcn/ui, Tailwind v4)
│   └── src-tauri/        # Rust backend (tokio, axum, dashmap, notify)
├── mobile/               # PWA + Capacitor iOS shell
├── vscode-extension/     # Sidebar extension (process control)
├── scripts/              # install.sh, watch-install.sh, release.sh, lib-build.sh
├── web/                  # Landing site (procman.kr)
└── spikes/               # Week 0 spike verdicts (archival)
```

### Tech stack
- **Desktop** — Tauri v2.10, Rust 1.88+, tokio, DashMap, notify, React 19/TS, Vite, shadcn/ui, Tailwind v4
- **Logs** — `react-window` virtualization + `ansi-to-html` + SQLite FTS5
- **Mobile** — Capacitor + React/TS (shares shadcn/Tailwind with desktop)
- **Remote API** — REST + WebSocket over loopback/LAN/Tunnel, bearer token auth, rate limiting, fail-closed self-signed TLS for LAN

## Remote Access

1. For the Capacitor iOS app, choose **Dashboard → Network → Start (LAN)**, open procman's in-app scanner, and scan the LAN pairing QR. Do not open this QR with Safari or the system camera. Native REST and WebSocket connections pin the exact SHA-256 fingerprint of the self-signed leaf certificate from that QR and fail closed if it is missing or does not match.
2. For the browser-installed PWA, start Remote Access as **Local only**, choose **Expose via Cloudflare**, and scan the Tunnel QR or open its publicly trusted HTTPS URL. Direct LAN endpoints are deliberately disabled in the browser PWA.
3. If procman's LAN certificate is replaced or its fingerprint changes, the iOS app rejects the connection. Scan a new QR to explicitly re-pair before reconnecting.

Tokens are 256-bit CSPRNG bearer tokens. CORS is restricted, rate limiting is enforced per-IP, LAN mode requires a self-signed certificate and fails closed if TLS setup fails, WebSocket auth uses bearer/subprotocol credentials rather than query-string tokens, and the API surface only exposes actions on registered scripts.

The LAN certificate intentionally has no dynamic LAN-IP SAN. Only the Capacitor iOS native transport handles that self-signed certificate, and only after both REST and WebSocket verify its exact leaf SHA-256 pin; it never falls back to the browser networking stack. The browser PWA neither bypasses platform TLS validation nor accepts direct LAN pairing—it uses the HTTPS Cloudflare Tunnel path instead.

## Documentation

- [CLAUDE.md](CLAUDE.md) — AI agent project context
- [TODO.md](TODO.md) — active work + Post-S5 options
- [CHANGELOG.md](CHANGELOG.md) — release history
- [VERSIONING.md](VERSIONING.md) — version ownership and release synchronization policy
- [app/README.md](app/README.md) — desktop app dev guide
- [mobile/README.md](mobile/README.md) — mobile PWA / iOS guide
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 spike verdict
- [.design-sync/NOTES.md](.design-sync/NOTES.md) — claude.ai/design sync (12 shadcn/ui primitives, re-sync guide)

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

<details>
<summary><b>한국어 (Korean)</b> — 펼쳐서 보기</summary>

# 🐸 procman

> **로컬 개발환경의 모든 러닝 프로세스를 한 화면에서 장악하는 Mission Control.**

[![Release](https://img.shields.io/github/v/release/jkeloper/procman?color=2b6b3a)](https://github.com/jkeloper/procman/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-black)](https://www.apple.com/macos/)

여러 로컬 서버·터널·도커 스택을 동시에 굴리는 1인 개발자를 위한 Mac 전용 프로세스 매니저 GUI. 데스크톱 Tauri 앱 + 모바일 PWA/iOS 동반 앱.

## 상태

**v0.3.0이 최신 안정 릴리스**입니다. targeted refactor(WS1~WS9 — 전역 "All running" 뷰, 단일 piped+PTY 런타임, 배치 포트 상태, config v4)를 포함합니다. `main`에는 다음 릴리스를 위한 보안·CI·문서 하드닝도 반영되어 있습니다.

스크립트, 그룹 실행, 가상 스크롤 로그 뷰어, 포트 대시보드, Cloudflare 터널, 세션 복원, 커맨드 팔레트, QR 페어링 모바일 클라이언트는 Rust·프론트엔드 테스트로 검증됩니다. CI는 포맷·린트·프로덕션 빌드·랜딩 사이트·VS Code 확장도 검사합니다.

## 기능

- **Mission Control** — 전역 "All running" 뷰가 전 프로젝트의 running/crashed 프로세스를 한 화면에 집계(crashed 우선, 프로젝트 라벨, 전체 CPU/RSS)하고, 인라인 stop/restart/dismiss + 다중 프로젝트 로그 추적을 제공 — 프로젝트를 하나씩 들어가 보지 않아도 무엇이 살아있는지 즉시 파악.
- **스크립트** — `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `docker-compose.yml` / `.vscode/launch.json` 자동 감지, 원클릭 start/stop/restart, `zsh -l -c` 로그인 쉘 래핑으로 `nvm`/`pyenv` PATH 보존.
- **로그 & 터미널** — 프로세스당 5,000라인 ring buffer, `react-window` 가상 스크롤, ANSI 컬러 렌더링, substring 검색, 멀티탭, 분리 로그 창, interactive script용 xterm.js PTY 셸. SQLite FTS 인덱스로 영구 히스토리 지원.
- **포트** — 선언형 `ports[]`(스크립트별 멀티 포트; 레거시 `expected_port`는 config v4에서 `ports[0]`로 마이그레이션) + visibility-aware 배치 `lsof` 폴링 + TCP liveness probe, 충돌 시 원클릭 kill.
- **그룹** — "Morning Stack" 스타일로 `depends_on` 위상정렬 + readiness 게이트 순차 실행(독립 멤버는 즉시 시작, 크래시한 의존성은 fast-fail). 개별 실패가 나머지를 막지 않음.
- **모바일** — Capacitor 기반 iOS/PWA 동반 앱. QR 코드 페어링, S1~S5 기능 전부 미러링, 크래시/포트 충돌/procman 접속 불가 로컬 알림, iOS의 인증서 고정 direct-LAN 접근, 브라우저 PWA의 HTTPS Cloudflare Tunnel 접근.
- **스케줄링** — 외부 cron 없이 5필드 로컬 시간 cron 표현식으로 스크립트 반복 실행.
- **자동 업데이터** — GitHub Releases 채널에서 Tauri 서명 업데이트 피드 수신.
- **Docker Compose** — 1급 프로젝트 타입. compose 서비스를 스크립트로 취급.
- **세션 복원** — 앱 종료 시 running 스크립트를 스냅샷, 재시작 시 복원 프롬프트.
- **⌘K 팔레트** — 프로젝트/스크립트/액션 퍼지 검색. 로그 드로어(`⌘L`)와 대시보드(`⌘,`) 단축키 제공.

## 빠른 시작

서명·노터라이즈된 최신 DMG(Apple Silicon)를 받으세요 — quarantine 우회 불필요:

```bash
open "https://github.com/jkeloper/procman/releases/latest/download/procman_0.3.0_aarch64.dmg"
```

직접 빌드하려면 `scripts/install.sh`가 클론된 체크아웃에서 빌드·설치합니다 — [소스 빌드](#build-from-source) 참고.

## 소스 빌드

### Prerequisites
- macOS 14+ (Apple Silicon 권장)
- Rust 1.88+ (`rustup`)
- `.tool-versions`에 고정된 Node와 pnpm

### 개발 모드
```bash
cd app
source "$HOME/.cargo/env"
pnpm install
pnpm tauri dev          # Vite + Tauri 창 (port 1420, <1초 HMR)
```

### 프로덕션 빌드 & 설치
```bash
./scripts/install.sh            # release 빌드 → /Applications/procman.app → 실행
./scripts/install.sh --debug    # debug 빌드 (~5배 빠름)
./scripts/install.sh --no-run   # 설치만, 실행 X
```

### 소스 변경 자동 재빌드
```bash
brew install fswatch
./scripts/watch-install.sh              # debug 빌드, 저장 시마다 재설치
./scripts/watch-install.sh --release    # release 빌드
```

일상 개발에는 `pnpm tauri dev`를 권장. `watch-install.sh`는 "설치된 버전도 항상 최신 유지" 용도.

## 테스트

```bash
# Rust 백엔드 (저장소 루트에서 실행)
(cd app/src-tauri && cargo test --lib)

# 데스크톱 프론트엔드 (저장소 루트에서 실행)
(cd app && pnpm test)

# 모바일 페어링·스트림·알림 경계
(cd mobile && pnpm test)

# VS Code Webview 보안·액션
(cd vscode-extension && pnpm test)
```

전체 lint·build·저장소 정책 gate는 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

## 아키텍처

```
procman/
├── app/                  # Tauri 데스크톱 앱
│   ├── src/              # React + TypeScript 프론트엔드 (shadcn/ui, Tailwind v4)
│   └── src-tauri/        # Rust 백엔드 (tokio, axum, dashmap, notify)
├── mobile/               # PWA + Capacitor iOS 셸
├── vscode-extension/     # 사이드바 확장 (프로세스 제어)
├── scripts/              # install.sh, watch-install.sh, release.sh, lib-build.sh
├── web/                  # 랜딩 사이트 (procman.kr)
└── spikes/               # Week 0 스파이크 판정 (archival)
```

### 기술 스택
- **데스크톱** — Tauri v2.10, Rust 1.88+, tokio, DashMap, notify, React 19/TS, Vite, shadcn/ui, Tailwind v4
- **로그** — `react-window` 가상화 + `ansi-to-html` + SQLite FTS5
- **모바일** — Capacitor + React/TS (데스크톱과 shadcn/Tailwind 공유)
- **원격 API** — loopback/LAN/Tunnel 위의 REST + WebSocket, bearer token 인증, rate limiting, LAN self-signed TLS fail-closed 적용

## 원격 접근

1. Capacitor iOS 앱에서는 **Dashboard → Network → Start (LAN)** 을 선택하고 procman 앱 내부 스캐너로 LAN 페어링 QR을 스캔합니다. Safari나 시스템 카메라로 이 QR을 열지 마세요. 네이티브 REST와 WebSocket 연결은 QR에 담긴 self-signed leaf 인증서의 SHA-256 fingerprint를 정확히 고정하며, 값이 없거나 일치하지 않으면 fail-closed로 연결을 거부합니다.
2. 브라우저 설치형 PWA에서는 Remote Access를 **Local only**로 시작한 뒤 **Expose via Cloudflare**를 선택하고 Tunnel QR 또는 공개적으로 신뢰되는 HTTPS URL로 페어링합니다. 브라우저 PWA의 direct LAN endpoint는 의도적으로 비활성화되어 있습니다.
3. procman LAN 인증서가 교체되거나 fingerprint가 바뀌면 iOS 앱은 연결을 거부합니다. 새 QR을 스캔해 명시적으로 다시 페어링해야 합니다.

토큰은 256-bit CSPRNG bearer token. CORS 제한과 per-IP rate limiting을 적용하며, LAN 모드는 self-signed certificate가 필수이고 TLS 준비 실패 시 서버를 열지 않습니다. WebSocket 인증은 query-string token 대신 bearer/subprotocol credentials를 사용하며, API 표면은 등록된 스크립트에 대한 액션만 노출합니다.

LAN 인증서에는 의도적으로 동적 LAN-IP SAN을 넣지 않습니다. 이 self-signed 인증서는 Capacitor iOS 네이티브 전송 계층에서만 사용하며, REST와 WebSocket 모두 정확한 leaf SHA-256 pin을 확인한 뒤 연결합니다. 브라우저 네트워크 계층으로 폴백하지 않습니다. 브라우저 PWA는 플랫폼 TLS 검증을 우회하거나 direct LAN 페어링을 허용하지 않고 HTTPS Cloudflare Tunnel 경로만 사용합니다.

## 문서

- [CLAUDE.md](CLAUDE.md) — AI 에이전트용 프로젝트 컨텍스트
- [TODO.md](TODO.md) — 진행 중 작업 + Post-S5 선택지
- [CHANGELOG.md](CHANGELOG.md) — 릴리즈 히스토리
- [VERSIONING.md](VERSIONING.md) — 버전 소유권과 릴리스 동기화 정책
- [app/README.md](app/README.md) — 데스크톱 앱 개발 가이드
- [mobile/README.md](mobile/README.md) — 모바일 PWA/iOS 가이드
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 스파이크 최종 판정
- [.design-sync/NOTES.md](.design-sync/NOTES.md) — claude.ai/design 동기화 (shadcn/ui 프리미티브 12종, 재동기화 가이드)

## 기여

Pull request 환영. [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) 참고.

## 라이선스

[MIT](LICENSE)

</details>
