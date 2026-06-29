# 🐸 procman

> **Your local dev environment's Mission Control — one screen for every running process.**

[![Release](https://img.shields.io/github/v/release/jkeloper/procman?color=2b6b3a)](https://github.com/jkeloper/procman/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-black)](https://www.apple.com/macos/)

Mac-only process manager GUI for solo developers juggling many local servers, tunnels, and docker stacks. Desktop Tauri app + mobile PWA/iOS companion.

## Status

**v0.2.0 release candidate.** Post-MVP S1–S5 shipped; the project is in final packaging, signing, and docs hardening.

Scripts, grouped launches, a virtualized log viewer, port dashboard, Cloudflare tunnels, session restore, a command palette, and a paired mobile client — all backed by a Rust core with **215 tests passing** on the backend and **52 tests passing** on the frontend.

## Features

- **Mission Control** — One global "All running" view aggregates every running/crashed process across all your projects on a single screen (crashed first, per-project labels, total CPU/RSS), with inline stop/restart/dismiss and multi-project log tracking — so you never have to dig into projects one by one to see what's alive.
- **Scripts** — Auto-detect `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `docker-compose.yml` / `.vscode/launch.json`; start/stop/restart with one click; login-shell (`zsh -l -c`) wrapping so `nvm`/`pyenv` PATHs survive.
- **Logs & terminal** — 5,000-line ring buffer per process, virtualized (`react-window`), ANSI color rendering, substring search, multi-tab switching, tear-off log windows, and an xterm.js PTY shell for interactive scripts. Backed by a SQLite FTS index for persistent history.
- **Ports** — Declarative `PortSpec` (multi-port per script) + visibility-aware `lsof` polling + 400ms TCP liveness probes; one-click kill on conflicts.
- **Groups** — "Morning Stack" style batches that launch multiple scripts sequentially with a 400ms stagger; individual failures don't block the rest.
- **Mobile** — iOS/PWA companion via Capacitor; QR-code pairing, full S1–S5 feature parity, local notifications for crashes/port conflicts/unreachable procman, reachable over Cloudflare Tunnel.
- **Scheduling** — Five-field local-time cron schedules can repeat scripts without adding external cron jobs.
- **Auto-updater** — Tauri signed update feed from the GitHub Releases channel.
- **Docker Compose** — First-class project type; compose services are treated as scripts.
- **Session restore** — Running scripts are snapshotted on exit and offered back on the next launch.
- **⌘K palette** — Fuzzy search across projects, scripts, and actions. Shortcuts for log drawer (`⌘L`) and dashboard (`⌘,`).

## Quick Start

Download the latest signed, notarized DMG (Apple Silicon) — no quarantine workaround needed:

```bash
open "https://github.com/jkeloper/procman/releases/latest/download/procman_0.2.0_aarch64.dmg"
```

Prefer building it yourself? `scripts/install.sh` builds and installs from a cloned checkout — see [Build from Source](#build-from-source).

## Build from Source

### Prerequisites
- macOS 14+ (Apple Silicon recommended)
- Rust 1.85+ via `rustup`
- Node 20+ with pnpm 10

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
# Rust (backend) — 215 unit tests
cd app/src-tauri
cargo test --lib

# Frontend — 52 tests
cd app
pnpm test
```

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
- **Desktop** — Tauri v2.10, Rust 1.85+, tokio, DashMap, notify, React 19/TS, Vite, shadcn/ui, Tailwind v4
- **Logs** — `react-window` virtualization + `ansi-to-html` + SQLite FTS5
- **Mobile** — Capacitor + React/TS (shares shadcn/Tailwind with desktop)
- **Remote API** — REST + WebSocket over loopback/LAN/Tunnel, bearer token auth, rate limiting, optional self-signed TLS for LAN

## Remote Access

1. Desktop → **Dashboard → Network → Start (LAN)** for local pairing, or keep loopback-only for desktop use.
2. Click **Expose via Cloudflare** for a public HTTPS URL when you need access outside the LAN.
3. Open the QR code on your phone → scan → connected. LAN QR payloads include the TLS certificate SHA-256 fingerprint in the URL fragment for client pinning.

Tokens are 256-bit CSPRNG bearer tokens. CORS is restricted, rate limiting is enforced per-IP, LAN mode can be served with a self-signed certificate, WebSocket auth uses bearer/subprotocol credentials rather than query-string tokens, and the API surface only exposes actions on registered scripts.

## Documentation

- [CLAUDE.md](CLAUDE.md) — AI agent project context
- [TODO.md](TODO.md) — active work + Post-S5 options
- [CHANGELOG.md](CHANGELOG.md) — release history
- [app/README.md](app/README.md) — desktop app dev guide
- [mobile/README.md](mobile/README.md) — mobile PWA / iOS guide
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 spike verdict

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

**v0.2.0 릴리스 후보.** Post-MVP S1~S5는 반영됐고, 현재 패키징·서명·문서 하드닝 단계.

스크립트, 그룹 실행, 가상 스크롤 로그 뷰어, 포트 대시보드, Cloudflare 터널, 세션 복원, 커맨드 팔레트, QR 페어링 모바일 클라이언트까지 — 백엔드 Rust 코어 **215개 테스트 통과**, 프론트엔드 **52개 테스트 통과**.

## 기능

- **Mission Control** — 전역 "All running" 뷰가 전 프로젝트의 running/crashed 프로세스를 한 화면에 집계(crashed 우선, 프로젝트 라벨, 전체 CPU/RSS)하고, 인라인 stop/restart/dismiss + 다중 프로젝트 로그 추적을 제공 — 프로젝트를 하나씩 들어가 보지 않아도 무엇이 살아있는지 즉시 파악.
- **스크립트** — `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `docker-compose.yml` / `.vscode/launch.json` 자동 감지, 원클릭 start/stop/restart, `zsh -l -c` 로그인 쉘 래핑으로 `nvm`/`pyenv` PATH 보존.
- **로그 & 터미널** — 프로세스당 5,000라인 ring buffer, `react-window` 가상 스크롤, ANSI 컬러 렌더링, substring 검색, 멀티탭, 분리 로그 창, interactive script용 xterm.js PTY 셸. SQLite FTS 인덱스로 영구 히스토리 지원.
- **포트** — 선언형 `PortSpec`(스크립트별 멀티 포트) + 2초 `lsof` 폴링 + 400ms TCP liveness probe, 충돌 시 원클릭 kill.
- **그룹** — "Morning Stack" 스타일로 여러 스크립트를 400ms 간격으로 순차 실행. 개별 실패가 나머지를 막지 않음.
- **모바일** — Capacitor 기반 iOS/PWA 동반 앱. QR 코드 페어링, S1~S5 기능 전부 미러링, 크래시/포트 충돌/procman 접속 불가 로컬 알림, Cloudflare Tunnel 경유 접근.
- **스케줄링** — 외부 cron 없이 5필드 로컬 시간 cron 표현식으로 스크립트 반복 실행.
- **자동 업데이터** — GitHub Releases 채널에서 Tauri 서명 업데이트 피드 수신.
- **Docker Compose** — 1급 프로젝트 타입. compose 서비스를 스크립트로 취급.
- **세션 복원** — 앱 종료 시 running 스크립트를 스냅샷, 재시작 시 복원 프롬프트.
- **⌘K 팔레트** — 프로젝트/스크립트/액션 퍼지 검색. 로그 드로어(`⌘L`)와 대시보드(`⌘,`) 단축키 제공.

## 빠른 시작

서명·노터라이즈된 최신 DMG(Apple Silicon)를 받으세요 — quarantine 우회 불필요:

```bash
open "https://github.com/jkeloper/procman/releases/latest/download/procman_0.2.0_aarch64.dmg"
```

직접 빌드하려면 `scripts/install.sh`가 클론된 체크아웃에서 빌드·설치합니다 — [소스 빌드](#build-from-source) 참고.

## 소스 빌드

### Prerequisites
- macOS 14+ (Apple Silicon 권장)
- Rust 1.85+ (`rustup`)
- Node 20+, pnpm 10

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
# Rust 백엔드 — 215개 unit test
cd app/src-tauri
cargo test --lib

# 프론트엔드 — 52개 test
cd app
pnpm test
```

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
- **데스크톱** — Tauri v2.10, Rust 1.85+, tokio, DashMap, notify, React 19/TS, Vite, shadcn/ui, Tailwind v4
- **로그** — `react-window` 가상화 + `ansi-to-html` + SQLite FTS5
- **모바일** — Capacitor + React/TS (데스크톱과 shadcn/Tailwind 공유)
- **원격 API** — loopback/LAN/Tunnel 위의 REST + WebSocket, bearer token 인증, rate limiting, LAN self-signed TLS 옵션

## 원격 접근

1. 데스크톱 → **Dashboard → Network → Start (LAN)** 으로 로컬 페어링, 또는 데스크톱 전용이면 loopback-only 유지
2. 외부 접근이 필요하면 **Expose via Cloudflare** 클릭 → 공개 HTTPS URL 획득
3. 폰에서 QR 코드 스캔 → 연결 완료. LAN QR payload에는 client pinning을 위한 TLS certificate SHA-256 fingerprint가 포함됩니다.

토큰은 256-bit CSPRNG bearer token. CORS 제한, per-IP rate limiting 적용, LAN 모드는 self-signed certificate로 서빙 가능하고, WebSocket 인증은 query-string token 대신 bearer/subprotocol credentials를 사용하며, API 표면은 등록된 스크립트에 대한 액션만 노출.

## 문서

- [CLAUDE.md](CLAUDE.md) — AI 에이전트용 프로젝트 컨텍스트
- [TODO.md](TODO.md) — 진행 중 작업 + Post-S5 선택지
- [CHANGELOG.md](CHANGELOG.md) — 릴리즈 히스토리
- [app/README.md](app/README.md) — 데스크톱 앱 개발 가이드
- [mobile/README.md](mobile/README.md) — 모바일 PWA/iOS 가이드
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 스파이크 최종 판정

## 기여

Pull request 환영. [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) 참고.

## 라이선스

[MIT](LICENSE)

</details>
