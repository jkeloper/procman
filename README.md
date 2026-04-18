# 🐸 procman

한국어 | [English](README.en.md)

Mac용 프로세스 매니저 GUI. 로컬 개발환경의 여러 서버·tunnel·docker 프로세스를 한 화면에서 관리.

## 상태
🟢 **Post-MVP S1~S5 완료** + **모바일/원격 통합 완료** (2026-04-17)

Week 0 스파이크 + Sprint 1-3(단일 세션) + v0.2 Feature Pack + Post-MVP S1-S5 완료.
이후 모바일 PWA(S1-S5 동기화) + iOS Capacitor + Remote API(REST/WS) + cloudflared
터널 자동 복구 + 모바일 QR 페어링까지 통합. **Tauri v2** + **Capacitor** 기반.

### Post-MVP 주요 추가
- **S1 포트 관리 v2** — `Script.ports: Vec<PortSpec>`로 멀티 포트 선언. 이름/번호/
  bind/optional/note 편집. v1→v2 자동 마이그레이션.
- **S2 TCP liveness probe** — 선언된 각 포트에 대해 400ms 타임아웃 TCP connect로
  실제 bind 여부 확인. ProcessGrid 행 배지에 초록/빨강/회색 dot.
- **S3 관측성** — CPU%/RSS MB를 `ps`로 2초마다 수집, pid 옆에 인라인 표시. 로그
  버퍼 substring 검색 커맨드.
- **S4 depends_on** — 스크립트 시작 전에 의존 스크립트의 선언 포트가 전부 TCP
  probe를 통과할 때까지 30초까지 대기. "Backend → Frontend" 순차 실행.

## 기능

### 프로젝트 & 스크립트
- 폴더 선택 → 직접 하위 디렉토리 스캔 (`package.json`/`Cargo.toml`/`go.mod`/`pyproject.toml`/`docker-compose.yml`)
- 멀티스택 자동 감지 + 패키지 매니저 자동 선택 (pnpm/yarn/bun/npm)
- package.json의 `scripts`에서 `--port N` 플래그 자동 추출

### 프로세스 실행
- `zsh -l .c` 로그인 쉘 래핑 (nvm/pyenv PATH 보존)
- `FORCE_COLOR=1` 환경변수로 ANSI 컬러 출력 유지
- 프로세스 그룹 kill (`killpg` SIGTERM → 1.5s 유예 → SIGKILL) — 자식·손자 프로세스까지 정리
- 크래시 감지 (exit_code != 0 AND !user_killed)
- 상태 실시간 브로드캐스트 (`process://status` 이벤트)

### 로그 뷰어
- 프로세스당 5000라인 메모리 ring buffer
- 멀티탭 (프로세스 시작 시 자동으로 새 탭)
- `react-window` 가상 스크롤 + `ansi-to-html` 컬러 렌더링
- auto-tail follow 토글
- stdout (회색) / stderr (빨강) 구분

### 포트 대시보드
- `lsof -nP -iTCP -sTCP:LISTEN` 2초 폴링
- **Matched ports**: 등록된 스크립트의 `expected_port`와 매칭 → "port 5173 = procman/dev"
- **Other ports**: 시스템 프로세스
- 원클릭 kill 버튼

### 그룹 ("Morning Stack")
- 여러 스크립트를 묶어서 순차 실행 (400ms 딜레이)
- 실패해도 나머지 계속 시도, 개별 결과 반환

### ⌘K 커맨드 팔레트
- `⌘K` / `Ctrl+K`: 프로젝트/스크립트/액션 퍼지 검색
- Start / Stop / Restart 원클릭
- 대시보드 점프

### 단축키
| 키 | 동작 |
|---|---|
| `⌘K` / `Ctrl+K` | 커맨드 팔레트 |
| `⌘L` / `Ctrl+L` | 로그 드로어 토글 |
| `⌘,` / `Ctrl+,` | 대시보드로 |

### 세션 복원
- 앱 종료 시 running 상태 스크립트 기록
- 재시작 시 복원 프롬프트 → 일괄 재실행

### 설정 파일
- `~/Library/Application Support/procman/config.yaml` (git 친화적)
- atomic write (tempfile + rename)
- FileSystem watcher → 외부 수정 시 자동 리로드

## 기술 스택
- **Tauri v2.10** (Rust 백엔드 + React/TS 프론트엔드)
- **shadcn/ui** + Tailwind v4
- **tokio** (async runtime)
- **DashMap** (프로세스 레지스트리)
- **notify** (FS watcher)
- **react-window** + **ansi-to-html** (로그 뷰어)
- 시스템 다크모드 자동 추종
- Mac 전용 (macOS 14+)

## 개발

### Prerequisites
- Rust 1.85+ (rustup 권장)
- Node 20+
- pnpm 10

### 개발 모드
```bash
cd app
source "$HOME/.cargo/env"   # cargo PATH 로드
pnpm install
pnpm tauri dev              # Vite + Tauri 창 (port 1420)
```

### 빌드 & 설치 (원클릭)
```bash
# release 빌드 + /Applications 설치 + quarantine 해제 + 실행
./scripts/install.sh

# 옵션
./scripts/install.sh --no-run   # 설치만, 실행 X
./scripts/install.sh --debug    # 빠른 debug 빌드 (release보다 ~5배 빠름)
```

결과물: `/Applications/procman.app` — Dock/Launchpad/Spotlight에서 바로 실행.

### 자동 재빌드 파이프라인
소스 수정 시 자동으로 `/Applications/procman.app` 재빌드+재설치:
```bash
brew install fswatch   # 최초 1회
./scripts/watch-install.sh          # debug 빌드 (기본)
./scripts/watch-install.sh --release  # release 빌드
```

(일상 개발은 `pnpm tauri dev` 권장 — HMR로 <1초 반영.
 이 파이프라인은 "설치된 버전도 최신으로 유지하고 싶다" 용도.)

### 코드서명 & 배포
개인용이면 서명 불필요. 다른 사람 배포 시 애플 개발자 계정($99/년) 필요.
`scripts/install.sh`는 자동으로 `xattr -cr`로 quarantine 해제.

### 릴리즈 (외부 배포)
서명·notarize까지 한 방에 수행하는 `scripts/release.sh` 사용:
```bash
# 로컬 — 인증서 keychain 설치 + 환경변수 세팅 후
export APPLE_ID="you@example.com"  # your Apple Developer account
export APPLE_TEAM_ID="XXXXXXXXXX"
export APPLE_NOTARIZE_PASSWORD="abcd-efgh-ijkl-mnop"  # app-specific password
# DEVELOPER_ID_APPLICATION 은 보통 자동 감지 (security find-identity)
./scripts/release.sh --version 0.2.0
# → app/src-tauri/target/release/bundle/dmg/procman_0.2.0_aarch64.dmg
```

GitHub Actions 릴리즈(`git tag v0.2.0 && git push --tags`)는
`.github/workflows/release.yml`이 macos-latest에서 같은 스크립트를 실행한다.
필요한 repo secrets: `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_NOTARIZE_PASSWORD`,
`TAURI_SIGNING_PRIVATE_KEY` (auto-updater용, Worker I에서 사용).

### 테스트
```bash
cd app/src-tauri
cargo test --lib    # 86 unit tests
```

## 디렉토리 구조
```
procman/
├── app/                        # Tauri 메인 앱
│   ├── src/                    # React 프론트엔드
│   │   ├── api/                # invoke 래퍼 + zod 스키마
│   │   ├── components/
│   │   │   ├── dashboard/      # 대시보드 (포트 + 그룹)
│   │   │   ├── project/        # 프로젝트 리스트/스캔/생성
│   │   │   ├── process/        # 스크립트 그리드/편집/상태 뱃지
│   │   │   ├── log/            # 로그 뷰어 (react-window)
│   │   │   ├── group/          # 그룹 패널/다이얼로그
│   │   │   ├── palette/        # ⌘K 커맨드 팔레트
│   │   │   ├── session/        # 복원 프롬프트
│   │   │   └── ui/             # shadcn
│   │   ├── hooks/              # useProcessStatus, useLogStream, useHotkeys
│   │   └── layouts/            # MainLayout (3-pane)
│   └── src-tauri/              # Rust 백엔드
│       └── src/
│           ├── types.rs        # 도메인 타입 (serde)
│           ├── config_store.rs # atomic YAML read/write
│           ├── process.rs      # ProcessManager (spawn/kill/restart)
│           ├── log_buffer.rs   # 5000-line ring buffer
│           ├── watcher.rs      # config.yaml FS watcher
│           ├── state.rs        # AppState (Arc<Mutex<AppConfig>>)
│           └── commands/       # IPC 명령 (project/script/process/port/scan/group/session)
├── mobile/                     # 모바일 PWA + iOS Capacitor 앱
├── vscode-extension/           # VSCode 사이드바 확장
├── scripts/                    # install.sh / watch-install.sh
├── docs/
│   ├── 07-port-management-v2.md  # 현행 포트 관리 설계
│   └── archive/                  # Week 0 기획 히스토리 (참고용)
└── spikes/                     # Week 0 스파이크 판정 (archival)
```

## 문서 맵
- [CLAUDE.md](CLAUDE.md) — AI 작업용 프로젝트 컨텍스트
- [TODO.md](TODO.md) — 작업 목록 + Post-S5 선택지
- [CHANGELOG.md](CHANGELOG.md) — 변경 이력
- [app/README.md](app/README.md) — 데스크톱 앱 개발 가이드
- [mobile/README.md](mobile/README.md) — 모바일 PWA/iOS 가이드
- [docs/07-port-management-v2.md](docs/07-port-management-v2.md) — 현행 포트 관리 설계
- [docs/archive/](docs/archive/) — Week 0 기획 히스토리
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 스파이크 최종 판정
