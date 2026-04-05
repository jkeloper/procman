# procman

Mac용 프로세스 매니저 GUI. 로컬 개발환경의 여러 서버·tunnel·docker 프로세스를 한 화면에서 관리.

## 상태
🟢 **MVP 완료** (2026-04-05)

Week 0 스파이크 + Sprint 1-3 전부 단일 세션 완주. **Tauri v2** 기반.

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

### 빌드 (DMG)
```bash
cd app
pnpm tauri build
# 결과: src-tauri/target/release/bundle/dmg/procman_0.1.0_aarch64.dmg
```

코드서명은 선택 (Developer ID 인증서 필요). 서명 없이 쓰려면 빌드 후
`xattr -cr /Applications/procman.app` 로 quarantine 해제.

### 테스트
```bash
cd app/src-tauri
cargo test --lib    # 15 unit tests
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
├── docs/                       # 기획 문서 (Charter/WBS/Decision)
└── spikes/                     # Week 0 스파이크 산출물 (archival)
```

## 테스트 완료 (15/15 Rust)
- types round-trip (empty / full / minimal YAML)
- ConfigStore (missing → default / atomic save+load / no temp leftover)
- LogBuffer (monotonic seq / ring eviction / tail-N)
- lsof parser (single/dup IPv4+IPv6)
- scan (port inference / Rust detect / multi-stack / PM from lockfile)

## 문서
- [CLAUDE.md](CLAUDE.md) — AI 작업용 프로젝트 컨텍스트
- [TODO.md](TODO.md) — 작업 목록 (전부 완료)
- [CHANGELOG.md](CHANGELOG.md) — 변경 이력
- [docs/](docs/) — 기획 문서
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 판정
