# procman — Desktop App

Tauri v2 + React/TS. The Mac-only process manager GUI at the heart of procman. For the overall project overview see the [root README](../README.md).

## Prerequisites
- Rust 1.85+ (install via `rustup`)
- Node 20+
- pnpm 10

## Dev mode
```bash
cd app
source "$HOME/.cargo/env"
pnpm install
pnpm tauri dev              # Vite + Tauri window (port 1420, <1s HMR)
```

## Build & install
`scripts/install.sh` does a release build, copies the bundle to `/Applications/procman.app`, clears quarantine, and launches the app — all in one shot:

```bash
./scripts/install.sh                  # default (release)
./scripts/install.sh --no-run         # install only
./scripts/install.sh --debug          # debug build (~5x faster)
```

Auto-rebuild on source changes:
```bash
brew install fswatch                  # one-time
./scripts/watch-install.sh            # debug
./scripts/watch-install.sh --release  # release
```

(For day-to-day work `pnpm tauri dev` is faster. The pipeline above is for "keep the installed copy in sync".)

## Testing
```bash
cd src-tauri
cargo test --lib                      # 167 unit tests
```

## Directory layout
```
app/
├── src/                              # React frontend
│   ├── api/                          # invoke wrappers + zod schemas
│   ├── components/
│   │   ├── dashboard/                # dashboard (ports + groups + tunnels)
│   │   ├── project/                  # project list / scan / creation
│   │   ├── process/                  # script grid / editor / status badges
│   │   ├── log/                      # log viewer (react-window)
│   │   ├── group/                    # group panel / dialogs
│   │   ├── palette/                  # ⌘K command palette
│   │   ├── session/                  # session-restore prompt
│   │   ├── remote/                   # remote API pairing card
│   │   └── ui/                       # shadcn primitives
│   ├── hooks/                        # useProcessStatus, useLogStream, useHotkeys
│   └── layouts/                      # MainLayout (3-pane)
└── src-tauri/                        # Rust backend
    └── src/
        ├── types.rs                  # domain types (serde)
        ├── config_store.rs           # atomic YAML read/write
        ├── process.rs                # ProcessManager (spawn/kill/restart)
        ├── log_buffer.rs             # 5000-line ring buffer + search
        ├── watcher.rs                # config.yaml FS watcher
        ├── state.rs                  # AppState
        ├── metrics.rs                # CPU/RSS 2s polling
        ├── port_probe.rs             # TCP liveness probe
        ├── cloudflared.rs            # tunnel run/kill/recover
        ├── remote.rs                 # REST + WebSocket remote API
        └── commands/                 # IPC commands (project/script/process/port/scan/group/session)
```

## Config files
- `~/Library/Application Support/procman/config.yaml` — projects/scripts/groups (git-friendly)
- `~/Library/Application Support/procman/runtime.json` — runtime state (last_running etc., flushed with a 500ms debounce)
- FS watcher auto-reloads on external edits (200ms debounce)

## Code signing & distribution
Signing isn't required for personal use. `scripts/install.sh` automatically clears the quarantine flag with `xattr -cr`. For external distribution you'll need an Apple Developer account ($99/year).

---

# procman — 데스크톱 앱 (한국어)

Tauri v2 + React/TS. Mac 전용 프로세스 매니저 GUI 본체. 전체 프로젝트 개요는 [루트 README](../README.md) 참고.

## Prerequisites
- Rust 1.85+ (`rustup` 권장)
- Node 20+
- pnpm 10

## 개발 모드
```bash
cd app
source "$HOME/.cargo/env"
pnpm install
pnpm tauri dev              # Vite + Tauri 창 (port 1420, <1초 HMR)
```

## 빌드 & 설치
`scripts/install.sh`가 release 빌드 + `/Applications/procman.app` 설치 + quarantine 해제 + 실행까지 원클릭:

```bash
./scripts/install.sh                  # 기본 (release)
./scripts/install.sh --no-run         # 설치만
./scripts/install.sh --debug          # debug 빌드 (~5배 빠름)
```

소스 수정 시 자동 재빌드:
```bash
brew install fswatch                  # 최초 1회
./scripts/watch-install.sh            # debug
./scripts/watch-install.sh --release  # release
```

(일상 개발은 `pnpm tauri dev`가 빠름. 위 파이프라인은 "설치된 버전 동기화" 용도.)

## 테스트
```bash
cd src-tauri
cargo test --lib                      # 167 unit tests
```

## 디렉토리 구조
```
app/
├── src/                              # React 프론트엔드
│   ├── api/                          # invoke 래퍼 + zod 스키마
│   ├── components/
│   │   ├── dashboard/                # 대시보드 (포트 + 그룹 + tunnels)
│   │   ├── project/                  # 프로젝트 리스트/스캔/생성
│   │   ├── process/                  # 스크립트 그리드/편집/상태 뱃지
│   │   ├── log/                      # 로그 뷰어 (react-window)
│   │   ├── group/                    # 그룹 패널/다이얼로그
│   │   ├── palette/                  # ⌘K 커맨드 팔레트
│   │   ├── session/                  # 복원 프롬프트
│   │   ├── remote/                   # 원격 API 페어링 카드
│   │   └── ui/                       # shadcn
│   ├── hooks/                        # useProcessStatus, useLogStream, useHotkeys
│   └── layouts/                      # MainLayout (3-pane)
└── src-tauri/                        # Rust 백엔드
    └── src/
        ├── types.rs                  # 도메인 타입 (serde)
        ├── config_store.rs           # atomic YAML read/write
        ├── process.rs                # ProcessManager (spawn/kill/restart)
        ├── log_buffer.rs             # 5000-line ring buffer + search
        ├── watcher.rs                # config.yaml FS watcher
        ├── state.rs                  # AppState
        ├── metrics.rs                # CPU/RSS 2s 폴링
        ├── port_probe.rs             # TCP liveness probe
        ├── cloudflared.rs            # 터널 run/kill/recover
        ├── remote.rs                 # REST + WebSocket 원격 API
        └── commands/                 # IPC 명령 (project/script/process/port/scan/group/session)
```

## 설정 파일
- `~/Library/Application Support/procman/config.yaml` — 프로젝트/스크립트/그룹 (git 친화적)
- `~/Library/Application Support/procman/runtime.json` — 런타임 상태 (last_running 등, 500ms debounce flush)
- FS watcher로 외부 수정 시 자동 리로드 (200ms debounce)

## 코드서명 & 배포
개인용이면 서명 불필요. `scripts/install.sh`가 자동으로 `xattr -cr`로 quarantine 해제. 외부 배포 시 Apple Developer 계정($99/년) 필요.
