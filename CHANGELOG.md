# Changelog

## [Unreleased]

### 2026-04-16 — S4 크래시/복구 UX (depends_on)
- **Added** `Script.depends_on: Vec<String>` — 시작 전에 반드시 running + reachable
  이어야 하는 다른 스크립트 ID 리스트. `#[serde(default)]`로 하위호환.
- **Added** `wait_for_dependencies` (commands/process.rs): `spawn_process`에서 호출,
  각 의존 스크립트가 ProcessManager::list에 있고(running) 선언된 모든 포트가 TCP
  probe를 통과할 때까지 500ms 간격으로 폴링. 30초 타임아웃. 실패 시 어떤 포트가
  pending인지 포함된 에러 메시지 반환.
- **Added** `create_script` / `update_script`에 `depends_on: Option<Vec<String>>`
  파라미터. update 시 None = 유지, Some(vec) = 교체.
- **Added** FE: `ScriptSchema.depends_on` + `createScript`/`updateScript` 래퍼.
- **Added** `ScriptEditor`에 "Depends on" 섹션 — 같은 프로젝트의 다른 스크립트를
  칩 토글로 선택/해제. 자기 자신은 목록에서 제외.
- **Note** 진짜 "Backend → Frontend" 순차 실행의 핵심 기능. auto-restart 정책
  UI (max retries, delay 조절)와 graceful shutdown order는 후속.

### 2026-04-16 — S3 관측성 (CPU/RSS + 로그 검색 커맨드)
- **Added** `ProcessSnapshot.cpu_pct: Option<f32>` / `rss_kb: Option<u64>`. `list()`가
  한 번의 `ps -p <pids> -o pid=,pcpu=,rss=` 호출로 모든 managed pid의 메트릭을 일괄
  수집 (`sample_metrics` 헬퍼).
- **Added** FE: `useProcessStatus`가 2초마다 `listProcesses`로 재폴링해 `metrics`
  맵을 갱신. 시작 시 status/pid/startTime은 덮어쓰지 않고 merge하여 status
  이벤트와 경쟁하지 않음.
- **Added** ProcessGrid 행에 `pid · uptime · N% cpu · M MB` 인라인 표시.
- **Added** `LogBuffer::search(query, case_sensitive, limit)` — 링 버퍼 내
  substring 검색. case-insensitive 기본. limit caps 결과 수.
- **Added** `search_log(script_id, query, case_sensitive?, limit?)` Tauri 커맨드.
- **Added** LogBuffer 검색 유닛 테스트 4건 (기본 case-insensitive / sensitive /
  limit / empty query). 총 84 lib test 통과.
- **Note** 로그 파일 영속화 및 로그 검색 UI 재배선 (현재 FE는 링 버퍼에 대해
  in-memory filter 사용)은 후속. `search_log` 커맨드는 추후 파일 기반 검색으로
  확장할 때 사용될 예정.

### 2026-04-16 — S2 포트 v3 (TCP liveness probe)
- **Added** `tcp_probe(bind, port, timeout_ms)` — tokio 기반 비동기 TCP connect
  프로브. `0.0.0.0` → `127.0.0.1`, `::` → `::1` 리라이트. 400ms 타임아웃 기본.
- **Added** `DeclaredPortStatus.reachable: Option<bool>` 필드. `port_status_for_script`가
  선언된 각 포트를 병렬로 probe해서 채운다. 런타임에 "선언은 돼있는데 실제로 bind
  되지 않은" 포트(예: 아직 부팅 중인 백엔드 · 크래시 후 좀비 선언)를 구분 가능.
- **Added** `tcp_probe` 3건 유닛 테스트 (refused / live listener / 0.0.0.0 rewrite).
  총 80 lib test 통과.
- **Added** FE: `ProcessGrid`가 running + declared ports 있는 스크립트에 대해 3초마다
  `portStatusForScript`를 폴링, scriptId → DeclaredPortStatus 맵을 관리.
- **Added** 행 포트 배지에 liveness dot: 초록=reachable, 빨강=not reachable,
  회색=probing/unknown. hover title에 상태 텍스트 포함.
- **Note** 진짜 ownership proof (wrapper_pid + bound_at_ms 기록)는 후속 작업으로
  이관. 현재는 TCP probe + 기존 pgid/cwd 휴리스틱 조합으로 충분한 신호 확보.

### 2026-04-16 — S1 포트 관리 v2 (선언 기반)
- **Added** `types.rs`에 `PortSpec` / `PortProto::Tcp` 도입. `Script.ports: Vec<PortSpec>` 필드 추가.
  각 스펙은 `name`, `number`, `bind`, `proto`, `optional`, `note`를 가진다.
- **Added** `config_store::migrate`가 v1 → v2 마이그레이션을 수행. `expected_port`가
  `ports[0] = {name: "default", ...}`로 승격되고 `version`이 `"2"`로 올라간다. 멱등.
- **Added** `ConfigStore::sync_expected_port`가 save 시점마다 `expected_port = ports[0].number`로
  double-write. 기존 orphan cleanup 로직이 v2 파일에서도 그대로 동작.
- **Added** 선언-포트 백엔드 커맨드 3종:
  - `port_status_for_script(projectId, scriptId) -> Vec<DeclaredPortStatus>`
  - `check_port_conflicts(projectId, scriptId) -> Vec<PortConflict>` (`Blocking`/`Warning` 분리)
  - `list_ports_for_script(projectId, scriptId) -> Vec<PortInfo>` (declared ∪ descendant 합집합)
- **Added** `create_script` / `update_script`가 `ports: Option<Vec<PortSpec>>`를 받아 저장.
  `validate_ports`가 이름 유일성, 1–65535 범위, 프로토콜 tcp-only를 검증.
- **Added** FE: `PortSpecSchema` / `DeclaredPortStatusSchema` / `PortConflictSchema` zod 정의,
  `api.portStatusForScript` / `api.checkPortConflicts` / `api.listPortsForScript` 래퍼.
- **Added** `ScriptEditor`에 "Declared ports" 섹션 — 이름/번호/bind 드롭다운(127.0.0.1/0.0.0.0/::1)/
  optional 체크박스/note 편집 + add/remove. 빈 배열이면 legacy `expected_port` 필드 사용.
- **Changed** `ProcessGrid.handleStart`가 `ports[]`가 있을 때 `check_port_conflicts`로 충돌 프리체크.
  `blocking` 충돌은 첫 항목을 `PortConflictDialog`로 노출, 나머지는 무경고로 진행.
- **Changed** `ProcessGrid.handleTunnelClick`이 선언 포트를 최우선. 1개면 즉시 터널, 다수면
  PortPicker에 declared 항목을 띄운다. 없을 때만 legacy expected_port / 트리 스캔 fallback.
- **Changed** 스크립트 행 배지에 `name:port` 형태로 선언 포트를 모두 표시.
- **Added** 마이그레이션/라운드트립 테스트 5건 (`migrate_v1_with_expected_port_promotes_to_ports`,
  `migrate_v1_without_expected_port_yields_empty_ports`, `migrate_v2_already_has_ports_is_noop`,
  `migrate_is_idempotent_on_v2`, `save_hook_syncs_expected_port_from_first_port`) + PortSpec
  default fill + Script 다중 포트 라운드트립. 총 77 lib test 전부 통과.

### 2026-04-12 — VSCode tasks.json `dependsOn` 지원
- **Added** `parse_tasks`가 `command` 없이 `dependsOn`만 있는 합성 태스크를 처리.
  - `dependsOrder: "sequence"` (또는 미지정) → `cmd1 && cmd2 && cmd3`
  - `dependsOrder: "parallel"` → background 태스크는 `( cmd ) &`로 띄우고
    foreground 태스크에 `wait`를 거는 형태로 합성
- **Fixed** 컴파운드 launch의 `preLaunchTask`가 `Full Stack: Prepare` 같은
  dependsOn 합성 태스크일 때 빌드가 누락되던 문제. 이제 `npm run build:backend`
  + `webpack serve`(background) 조합이 정상적으로 launch 앞에 붙는다.
- **Changed** 컴파운드 명령 구조: `trap 'kill 0' EXIT`가 preLaunchTask까지
  포함하도록 가장 앞으로 이동 → 종료 시 background dev server도 함께 정리.
- **Added** scanner 단위 테스트 2건. 총 21개 모두 통과.

### 2026-04-11 — VSCode preLaunchTask 지원
- **Added** `vscode_scanner.rs`에서 `.vscode/tasks.json` 파싱 (`parse_tasks`).
  shell/process 태스크의 label → command 매핑 빌드, args + options.cwd 처리.
- **Added** `translate_config_with_tasks`: launch config의 `preLaunchTask`를
  찾아 `<task> && <launch>` 형태로 명령 앞에 자동 prepend.
- **Added** compound config의 `preLaunchTask` 지원 (parallel 실행 전 빌드 1회).
- **Why** budgetbook 같은 프로젝트에서 `npm run build:backend` 후 `dist/server.js`
  를 띄우는 VS Code workflow를 procman이 그대로 재현하지 못해, stale dist를
  매번 수동 빌드해야 했음. 이제 VS Code "Run and Debug" 동작과 1:1.
- **Added** scanner 단위 테스트 2건 (`pre_launch_task_prepended`,
  `task_with_args_and_cwd`). 총 19개 테스트 모두 통과.

### 2026-04-05 — 프로젝트 착수 (기획 단계)
- **Added** 프로젝트 디렉토리 구조 생성 (the project directory)
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

### 2026-04-05 — Day 2/3 S2 PTY 완료 ✅ GO
- **Added** `portable-pty = "0.8"` dependency + [pty.rs](spikes/tauri-harness/src-tauri/src/pty.rs): `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill` IPC commands, per-session event stream (`pty://data/{sid}`, `pty://exit/{sid}`)
- **Added** S2 5-scenario auto-test harness (App.tsx)
- **Added** [spikes/s2-pty/REPORT.md](spikes/s2-pty/REPORT.md) + [results/combined.json](spikes/s2-pty/results/combined.json)
- **Finding** portable-pty on macOS: zsh/python/docker 모두 정상 동작, ANSI escape `\x1b[` 시퀀스 원본 그대로 양방향 전달
- **Finding** T4 Docker alpine 이미지 first-pull 포함 4.2s — 실사용에서 `docker exec -it` 래핑 가능
- **Finding** T5 SSH FAIL은 환경 이슈 (macOS 기본 sshd off), PTY 레이어 자체는 정상 동작
- **Decision** 핵심 3/3 PASS → S3 xterm.js on WKWebView으로 진행

### 2026-04-05 — Day 4 S3 xterm.js 완료 ✅ GO (effective)
- **Added** xterm.js v6 + @xterm/addon-webgl 0.19 + @xterm/addon-fit 통합
- **Added** 100k 라인 dump 벤치마크 (7-color ANSI 로테이션)
- **Added** [spikes/s3-xterm/REPORT.md](spikes/s3-xterm/REPORT.md) + [results/bench.json](spikes/s3-xterm/results/bench.json)
- **Finding** WebGL2 렌더러 WKWebView에서 정상 활성화 — Canvas fallback 불필요
- **Finding** avg 59.9fps / p5 58.3fps / min 54.5fps — 0.17% 미달은 **rAF 스케줄러 상한** (macOS 59.94Hz). p5 기준 목표(30)의 2배
- **Finding** 34k lines/sec throughput, procman 실사용의 ~7배. scrollback 50k 버퍼 문제 없음
- **Decision** **effectively GO**. Charter rubric을 `avg ≥ 58 AND p5 ≥ 30`으로 조정 권고 → S4 Rust self-assessment로 진행

### 2026-04-05 — Week 0 최종 판정 (Option C, 사용자 결정) 🏁
- **Decided** 사용자 Option C 선택: S4 Rust self-assessment **건너뛰고 Tauri 강행**, 리스크 감수
- **Added** [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 통합 판정서
- **Decided** **기술 스택 최종 확정: Tauri v2** (Plan A)
- **Residual Risk** R_Rust_Proficiency HIGH — Week 2 종료 시점(T05) 재평가 게이트. T05 2일 초과 시 Electron 전환 재검토
- **Milestone** Week 0 **단일 세션으로 압축 완료** (계획 5일 → 실제 ~8시간)
- **Next** Sprint 1 착수 — tauri-harness를 procman/ 본 프로젝트로 재편성 + T01-T10 실행

### 2026-04-05 — Sprint 1 Day 1 (사용자 override로 즉시 착수)
- **Added** 사용자 override → Manager가 Day 1 자율 진행 승인 (STOP 조건: 4h / compile fail 3연속 / W-D1-05 완료 중 최저)
- **Changed** spikes/tauri-harness → app/ 승격 (`git mv`, 7 commits history 보존)
- **Changed** identifier 일괄 리네임: Cargo pkg/lib → procman/procman_lib, bundle id → dev.procman.app
- **Added** Tailwind v4 + @tailwindcss/vite 플러그인
- **Added** shadcn/ui (new-york, zinc) + 12 components (button/card/tabs/dialog/command/scroll-area/badge/input/label/separator/textarea/input-group)
- **Added** 3-pane MainLayout 스켈레톤 ([layouts/MainLayout.tsx](app/src/layouts/MainLayout.tsx)) + 3개 placeholder 컴포넌트 (ProjectList/ProcessGrid/LogViewer)
- **Added** Rust 도메인 타입 ([types.rs](app/src-tauri/src/types.rs)): Project/Script/ProcessHandle/LogLine/PortInfo + enums (ProcessStatus/LogStream)
- **Added** Rust 명령 스텁 8종 ([commands/](app/src-tauri/src/commands/)): list/create/delete_project, spawn/kill_process, get_logs, list/kill_port. 각 모듈 상단 `// LEARN:` 블록 (Rust/Tauri 초심자 설명)
- **Added** TypeScript API 래퍼 ([src/api/](app/src/api/)): zod 스키마 + 런타임 검증 (`api.listProjects()` 등)
- **Removed** 템플릿 asset (hero.png, react/vite svg, App.css)
- **Retained** 스파이크 모듈 (stress.rs, pty.rs) — `#[allow(dead_code)]` 처리, T11-T17 참조 구현용

### 2026-04-05 — Sprint 1 전체 완료 (사용자 "한번에 쭉" override, Day 2 연속 진행) 🏁
- **Added** T03: Config 스키마 확정 (AppConfig/Project/Script/Group/GroupMember/AppSettings + ProcessStatus/LogStream enums) + 3 round-trip 테스트 (serde_yaml)
- **Added** T04: ConfigStore (config_store.rs) — atomic write via tempfile+rename, thiserror-based ConfigError, 3 unit tests
- **Added** T05: Project CRUD IPC — AppState with Arc<Mutex<AppConfig>> + mutate() helper (rollback on save fail), uuid v4 ids, path validation
- **Added** T06: Script CRUD IPC (nested in Project), cascade delete from groups
- **Added** T07: ProjectList UI + NewProjectDialog + native folder picker (tauri-plugin-dialog)
- **Added** T08: ProcessGrid + ScriptEditor (create/edit shared dialog) + port validation
- **Added** T09: FileSystem watcher (watcher.rs, notify crate, 200ms debounced) → emits 'config-changed' event, FE auto-reload
- **Added** T10: Project auto-detect — scan_directory command (walkdir, skip node_modules/etc., max depth 5) + port inference from `--port N` patterns + ScanDialog with candidate picker + bulk import
- **Tests** 7/7 Rust unit tests pass (types roundtrip + ConfigStore + port_inference)
- **Decision** Sprint 1 완료 → Sprint 2(T11-T20 실행&로그) 대기
- **R_Rust_Proficiency 상태**: 여전히 미측정 — 사용자가 자율 진행 override로 직접 타이핑 게이트 무효화. Sprint 2 시작 시 Manager 재평가 필요

### 2026-04-05 — Sprint 2 전체 완료 (사용자 override, 단일 세션) 🏁
- **Added** T11 ProcessManager (process.rs) — `tokio::process::Command` + Arc<DashMap<script_id, Managed>>, spawn/kill/restart/list/log_snapshot
- **Added** T12 login shell wrapping — `/bin/zsh -l -c <cmd>` + FORCE_COLOR=1 + CLICOLOR_FORCE=1 + TERM=xterm-256color
- **Added** T13 process group kill — `process_group(0)` 설정 + `libc::killpg(pid, SIGTERM)` → 1.5s grace → SIGKILL. 자식 손자까지 모두 정리
- **Added** T14 status broadcast — `process://status` 이벤트 (Running/Stopped/Crashed + pid + exit_code + ts_ms)
- **Added** T15 LogBuffer (log_buffer.rs) — VecDeque 5000 capacity, monotonic seq, 3 unit tests
- **Added** T16 per-process log stream — `log://{script_id}` 이벤트, 2개 reader task (stdout/stderr) async
- **Added** T17 LogViewer + LogPanel — react-window 가상 스크롤 + ansi-to-html ANSI 컬러 렌더링 + auto-tail 토글
- **Added** T18 Start/Stop/Restart 버튼 + StatusBadge (Running/Stopped/Crashed) + pid 표시 + Edit/Delete
- **Added** T19 Groups — Group CRUD + run_group 커맨드 (400ms 딜레이 순차 실행) + GroupsPanel UI (Dashboard에 통합) + NewGroupDialog (멀티스크립트 체크박스 선택)
- **Added** T20 crash detection — watcher task가 exit_code + killed_by_user 플래그로 Stopped/Crashed 구분, StatusBadge 빨강 표시
- **Added** React hooks: useProcessStatus (status+pid 실시간), useLogStream (rAF 배치 처리, snapshot prime + 구독)
- **Deps** 추가: dashmap, libc, react-window, ansi-to-html
- **Tests** 15/15 Rust unit tests pass
- **Decision** MVP 코어 기능 전부 구현. Sprint 3(포트 관리)은 이미 Sprint 1에서 완료 → 남은 건 ⌘K 커맨드 팔레트 + DMG 빌드 + 세션 복원 (T24-T28)

### 2026-04-05 — Sprint 3 완료 (사용자 override, 단일 세션) 🏁 MVP 전체 완료
- **Added** T24 ⌘K/Ctrl+K 커맨드 팔레트 ([CommandPalette.tsx](app/src/components/palette/CommandPalette.tsx)) — 프로젝트/스크립트/액션 퍼지 검색, Start/Stop/Restart 원클릭, Dashboard 점프
- **Added** T25 글로벌 단축키 ([useHotkeys.ts](app/src/hooks/useHotkeys.ts)) — ⌘L 로그 토글, ⌘, 대시보드
- **Skipped** T26 로그 디스크 rotate — 메모리 ring buffer 5000라인으로 충분, 디스크 유출 불필요
- **Added** T27 세션 복원 — `AppConfig.last_running` 필드 + `mark_last_running`/`get_last_running`/`clear_last_running` 커맨드. useProcessStatus가 status 변화마다 자동 persist. 재시작 시 RestorePrompt 다이얼로그
- **Added** T28 README — 전체 기능/빌드/개발 가이드. DMG 빌드는 수동 릴리즈로 분리 (pnpm tauri build)
- **Done** T21-T23은 이미 Sprint 1 Dashboard 작업에서 완료됨
- **Milestone** procman MVP 전체 기능 구현 완료. 모든 계획 태스크 closed

### 2026-04-06 — Critical Fix Pack (3-agent 교차점검 반영) 🛡️
- **3-agent 교차점검 완료**: Evaluator 7.0/10, User-tester NPS 5/10, Architecture 리뷰
- **Fixed UNI-1** (Critical): `commands/process.rs`의 `blocking_lock()` async 컨텍스트 호출 제거 → `.lock().await`로 전환. tokio 런타임 데드락 위험 해소
- **Fixed UNI-2** (Critical): ProcessManager에 generation counter 도입. kill()이 exited flag polling(50ms)으로 try_wait 기반 종료 확인 후에야 SIGKILL → PID 재활용 race 방지. watcher task는 generation 매칭 시에만 remove
- **Fixed UNI-3** (Critical): `last_running`을 config.yaml에서 분리하여 별도 [runtime.json](~/Library/Application Support/procman/runtime.json)으로 이관. 500ms debounced flush로 SSD 부하/git dirty 제거. [runtime_state.rs](app/src-tauri/src/runtime_state.rs) 신규 + 2 unit tests
- **Fixed UNI-4**: RestorePrompt의 restoreAll이 spawn 전에 `clear_last_running` 명시 호출 → 프롬프트 재출현 방지
- **Fixed UNI-5**: CommandPalette에 Groups 섹션 추가. ⌘K → group name → Enter로 "Morning Stack" 즉시 실행 (killer journey 복구)
- **Fixed UNI-7**: dead types 전부 제거 — `types::ProcessStatus`, `types::ProcessHandle`, `types::LogLine`, TS legacy `ProcessStatusSchema`/`ProcessHandleSchema`. 단일 `RuntimeStatus` + `log_buffer::LogLine`만 유지. `get_logs` 제거
- **Fixed B4**: `delete_script` / `delete_project` 커맨드가 실행 중 프로세스를 먼저 kill 후 config 수정 → 고아 프로세스 방지
- **Added M3**: 로그 라인 8KB 트렁케이션 + reader I/O 에러 시 `[procman: ... read error]` stderr로 에스컬레이트 + 2 unit tests
- **Added** `AppSettings.log_buffer_size` 설정값이 ProcessManager에 실제 주입 (dead config 해소)
- **Tests** 19/19 Rust unit tests pass (기존 15 + 신규 4: process truncate 2 + runtime_state 2)
- **Status** MVP 안정화 완료, v0.1.0-rc1 릴리즈 준비

### 2026-04-06 — v0.2 Feature Pack (VSCode + Cloudflare + Port→Log + Design refresh) 🎨
- **Added** VSCode launch.json 스캐너 ([vscode_scanner.rs](app/src-tauri/src/vscode_scanner.rs)):
  - 지원: node/python/shell/go/lldb(Rust) 5종
  - 변수 치환: `${workspaceFolder}`, `${env:VAR}`, env block inline
  - 지원 안 함: attach, pwa-*, compound, preLaunchTask → skipped_reason 반환
  - JSONC 주석 (`//`, `/* */`) 스트립 파서 + shell-quote escape
  - 8 unit tests (JSONC/변수 치환/translate node+python/skip 케이스)
  - ProcessGrid에 "VSCode import" 버튼 + VSCodeImportDialog (체크박스 선택)
- **Added** Cloudflare Tunnels 섹션 ([cloudflared.rs](app/src-tauri/src/cloudflared.rs)):
  - `cloudflared --version` 감지 (미설치 시 카드 자체를 설치 안내로 대체)
  - `cloudflared tunnel list --output json` 파싱 → Named tunnels 리스트
  - `ps` 기반 running cloudflared 감지 (tunnel name / URL 추출, grep noise 필터)
  - "Run" 버튼 → 첫 프로젝트에 스크립트 등록 + 즉시 실행
  - SIGTERM → 1s → SIGKILL (`libc::kill`)
  - 3 unit tests (tunnel run / quick tunnel / grep noise 필터)
- **Added** 포트 클릭 → 로그 점프:
  - ProcessManager에 `pid_index: Arc<DashMap<u32, String>>` 역인덱스 추가
  - `resolve_pid_to_script(pid)` 커맨드
  - Dashboard 포트 row 클릭 시 pid → script_id 조회 → managed면 해당 프로젝트 전환 + `procman:focus-log` 이벤트로 LogViewer가 해당 탭 active
  - 외부 프로세스는 pid/name/port 정보 dialog
- **Design refresh (tone-shift)**:
  - JetBrains Mono 폰트 추가 (code/kbd/command strings)
  - 전역 focus-visible ring 통일, antialiased, font-feature-settings (ss01/cv11)
  - `.glass` 유틸리티 (backdrop-blur 12px saturate 160%) → 헤더/사이드바 적용
  - 헤더 h-12 → h-10, 사이드바 280px → 240px (컴팩트)
  - StatusBadge: 박스 → 6px dot + 10px uppercase label + running 시 pulse animation
  - ProcessGrid 카드: hover 1px up-translate + shadow-md, edit/✕ 버튼 hover 시에만 표시 (opacity 전환)
  - StatCard: 2xl font-mono 숫자 + 10px uppercase label
  - kbd 요소: 10px 통일 style (radius-sm)
  - subtle custom scrollbar (10px, color-mix 기반 alpha)
- **Tests** 30/30 Rust unit tests pass (기존 19 + vscode 8 + cloudflared 3)
- **Scope override**: Charter의 v0.2 out-of-scope 항목(VSCode/Cloudflare)을 사용자 요청으로 MVP+ 편입

### 발견된 Critical 이슈
- **Tauri Issue #7684**: 대용량 stdout(20k+ 라인) 처리 시 라인 유실 + 좀비 프로세스. Week 0 스파이크로 검증 필수.
