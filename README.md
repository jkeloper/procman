# 🐸 procman

> **Your local dev environment's Mission Control — one screen for every running process.**

[![Release](https://img.shields.io/github/v/release/jkeloper/procman?color=2b6b3a)](https://github.com/jkeloper/procman/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-black)](https://www.apple.com/macos/)

Mac-only process manager GUI for solo developers juggling many local servers, tunnels, and docker stacks. Desktop Tauri app + mobile PWA/iOS companion.

## Status

**v0.2.0 released.** Post-MVP S1–S5 shipped and the mobile/remote stack is live.

Scripts, grouped launches, a virtualized log viewer, port dashboard, Cloudflare tunnels, session restore, a command palette, and a paired mobile client — all backed by a Rust core with **167 tests passing** on the backend and **23 tests passing** on the frontend.

## Features

- **Scripts** — Auto-detect `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `docker-compose.yml` / `.vscode/launch.json`; start/stop/restart with one click; login-shell (`zsh -l -c`) wrapping so `nvm`/`pyenv` PATHs survive.
- **Logs** — 5,000-line ring buffer per process, virtualized (`react-window`), ANSI color rendering, substring search, and multi-tab switching. Backed by a SQLite FTS index for persistent history.
- **Ports** — Declarative `PortSpec` (multi-port per script) + 2s `lsof` polling + 400ms TCP liveness probes; one-click kill on conflicts.
- **Groups** — "Morning Stack" style batches that launch multiple scripts sequentially with a 400ms stagger; individual failures don't block the rest.
- **Mobile** — iOS/PWA companion via Capacitor; QR-code pairing, full S1–S5 feature parity, reachable over Cloudflare Tunnel.
- **Auto-updater** — Tauri signed update feed from the GitHub Releases channel.
- **Docker Compose** — First-class project type; compose services are treated as scripts.
- **Session restore** — Running scripts are snapshotted on exit and offered back on the next launch.
- **⌘K palette** — Fuzzy search across projects, scripts, and actions. Shortcuts for log drawer (`⌘L`) and dashboard (`⌘,`).

## Quick Start

Install the latest signed DMG:

```bash
# Option A — one-liner installer
curl -fsSL https://raw.githubusercontent.com/jkeloper/procman/main/scripts/install.sh | bash

# Option B — download the DMG directly
open "https://github.com/jkeloper/procman/releases/latest/download/procman_0.2.0_aarch64.dmg"
```

The DMG is signed and notarized; no quarantine workaround needed.

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
# Rust (backend) — 167 unit tests
cd app/src-tauri
cargo test --lib

# Frontend — 23 tests
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
├── scripts/              # install.sh, watch-install.sh, release.sh
├── docs/                 # Design specs + archived Week 0 planning
└── spikes/               # Week 0 spike verdicts (archival)
```

### Tech stack
- **Desktop** — Tauri v2.10, Rust 1.85+, tokio, DashMap, notify, React 18/TS, Vite, shadcn/ui, Tailwind v4
- **Logs** — `react-window` virtualization + `ansi-to-html` + SQLite FTS5
- **Mobile** — Capacitor + React/TS (shares shadcn/Tailwind with desktop)
- **Remote API** — REST + WebSocket over Cloudflare Tunnel, bearer token auth, rate limiting

## Remote Access

1. Desktop → **Dashboard → Network → Start (LAN)**
2. Click **Expose via Cloudflare** for a public HTTPS URL.
3. Open the QR code on your phone → scan → connected.

Tokens are 256-bit CSPRNG bearer tokens. CORS is restricted, rate limiting is enforced per-IP, and the API surface only exposes actions on registered scripts.

## Documentation

- [CLAUDE.md](CLAUDE.md) — AI agent project context
- [TODO.md](TODO.md) — active work + Post-S5 options
- [CHANGELOG.md](CHANGELOG.md) — release history
- [app/README.md](app/README.md) — desktop app dev guide
- [mobile/README.md](mobile/README.md) — mobile PWA / iOS guide
- [docs/07-port-management-v2.md](docs/07-port-management-v2.md) — current port-management design
- [docs/archive/](docs/archive/) — Week 0 planning history
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

**v0.2.0 릴리즈 완료.** Post-MVP S1~S5 및 모바일/원격 통합까지 전부 반영된 상태.

스크립트, 그룹 실행, 가상 스크롤 로그 뷰어, 포트 대시보드, Cloudflare 터널, 세션 복원, 커맨드 팔레트, QR 페어링 모바일 클라이언트까지 — 백엔드 Rust 코어 **167개 테스트 통과**, 프론트엔드 **23개 테스트 통과**.

## 기능

- **스크립트** — `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `docker-compose.yml` / `.vscode/launch.json` 자동 감지, 원클릭 start/stop/restart, `zsh -l -c` 로그인 쉘 래핑으로 `nvm`/`pyenv` PATH 보존.
- **로그** — 프로세스당 5,000라인 ring buffer, `react-window` 가상 스크롤, ANSI 컬러 렌더링, substring 검색, 멀티탭. SQLite FTS 인덱스로 영구 히스토리 지원.
- **포트** — 선언형 `PortSpec`(스크립트별 멀티 포트) + 2초 `lsof` 폴링 + 400ms TCP liveness probe, 충돌 시 원클릭 kill.
- **그룹** — "Morning Stack" 스타일로 여러 스크립트를 400ms 간격으로 순차 실행. 개별 실패가 나머지를 막지 않음.
- **모바일** — Capacitor 기반 iOS/PWA 동반 앱. QR 코드 페어링, S1~S5 기능 전부 미러링, Cloudflare Tunnel 경유 접근.
- **자동 업데이터** — GitHub Releases 채널에서 Tauri 서명 업데이트 피드 수신.
- **Docker Compose** — 1급 프로젝트 타입. compose 서비스를 스크립트로 취급.
- **세션 복원** — 앱 종료 시 running 스크립트를 스냅샷, 재시작 시 복원 프롬프트.
- **⌘K 팔레트** — 프로젝트/스크립트/액션 퍼지 검색. 로그 드로어(`⌘L`)와 대시보드(`⌘,`) 단축키 제공.

## 빠른 시작

최신 서명 DMG 설치:

```bash
# 옵션 A — 원라이너 설치 스크립트
curl -fsSL https://raw.githubusercontent.com/jkeloper/procman/main/scripts/install.sh | bash

# 옵션 B — DMG 직접 다운로드
open "https://github.com/jkeloper/procman/releases/latest/download/procman_0.2.0_aarch64.dmg"
```

DMG는 서명·노터라이즈되어 있어 quarantine 우회 불필요.

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
# Rust 백엔드 — 167개 unit test
cd app/src-tauri
cargo test --lib

# 프론트엔드 — 23개 test
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
├── scripts/              # install.sh, watch-install.sh, release.sh
├── docs/                 # 설계 스펙 + Week 0 기획 아카이브
└── spikes/               # Week 0 스파이크 판정 (archival)
```

### 기술 스택
- **데스크톱** — Tauri v2.10, Rust 1.85+, tokio, DashMap, notify, React 18/TS, Vite, shadcn/ui, Tailwind v4
- **로그** — `react-window` 가상화 + `ansi-to-html` + SQLite FTS5
- **모바일** — Capacitor + React/TS (데스크톱과 shadcn/Tailwind 공유)
- **원격 API** — REST + WebSocket (Cloudflare Tunnel 경유), bearer token 인증, rate limiting

## 원격 접근

1. 데스크톱 → **Dashboard → Network → Start (LAN)**
2. **Expose via Cloudflare** 클릭 → 공개 HTTPS URL 획득
3. 폰에서 QR 코드 스캔 → 연결 완료

토큰은 256-bit CSPRNG bearer token. CORS 제한, per-IP rate limiting 적용, API 표면은 등록된 스크립트에 대한 액션만 노출.

## 문서

- [CLAUDE.md](CLAUDE.md) — AI 에이전트용 프로젝트 컨텍스트
- [TODO.md](TODO.md) — 진행 중 작업 + Post-S5 선택지
- [CHANGELOG.md](CHANGELOG.md) — 릴리즈 히스토리
- [app/README.md](app/README.md) — 데스크톱 앱 개발 가이드
- [mobile/README.md](mobile/README.md) — 모바일 PWA/iOS 가이드
- [docs/07-port-management-v2.md](docs/07-port-management-v2.md) — 현행 포트 관리 설계
- [docs/archive/](docs/archive/) — Week 0 기획 히스토리
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 스파이크 최종 판정

## 기여

Pull request 환영. [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) 참고.

## 라이선스

[MIT](LICENSE)

</details>
