# TODO

## 🎯 Post-MVP Roadmap (S1~S5) — 2026-04-15 착수
- [x] **S1** 포트 관리 v2 (선언 기반) — docs/07 기반, 3일. **2026-04-16 완료**
      (PortSpec/migrate/3 commands/ScriptEditor/PortPicker/handleStart, 77 tests)
      remainders: VSCode scanner `extract_ports_from_launch`, Dashboard script-grouped view
- [x] **S2** 포트 v3 소유권 + 헬스체크 — **2026-04-16 완료** (TCP probe + reachable 필드 + 3s 폴링 + liveness dot. 80 tests)
      deferred: 진짜 ownership proof (wrapper_pid + bound_at_ms 기록)
- [ ] **S3** 관측성 (로그 검색/파일/메트릭) — 5일
- [ ] **S4** 크래시/복구 UX (auto-restart 정책, depends_on) — 5일
- [ ] **S5** 마감 (온보딩, Cmd+K 커버리지, 테스트, 문서) — 7일

## 🔮 병렬 선택지 (Post-S5 재평가)
- [ ] Docker Compose 네이티브 통합 (v0.2 원래 범위)
- [ ] Multi-window / tear-off 로그 패널
- [ ] Scheduled/cron 실행 (반복 작업)
- [ ] 팀 공유 기능 (v1.0 원래 범위)
- [ ] xterm.js 기반 PTY 인터랙션 터미널
- [ ] 장기 로그 검색 (Elasticsearch 또는 sqlite FTS)

## ✅ Blocker 해소 (2026-04-05)
- [x] **Q1**: Rust 숙련도 → **DEFERRED** (Week 0 S4로 실증 판정, Manager+Planner 협의 위임)
- [x] **Q2**: 타임라인 → **A. 7주 안전** (스파이크 1주 + MVP 6주)
- [x] **Q3**: 크로스플랫폼 → **A. Mac 전용 영구**
- [ ] (선택) Q4: 주당 개발 투입 시간
- [ ] 시드 데이터: "가장 자주 실행하는 3개 프로젝트"
- [ ] "이것만 되면 쓴다" 마지노선 기능 1개 지정
- [ ] MVP 목표 일자 확정 (2026-05-31 잠정)

## Week 0 — 스파이크 (D-Day 조기 착수 2026-04-05)

### S0 — 사전 준비 ✅ 완료
- [x] S0.1 Git init + `.gitignore` + `.tool-versions`
- [x] S0.2 `spikes/` 디렉토리 구조
- [x] S0.3 도구 설치 (pnpm, Rust stable 1.94.1, hyperfine)
- [x] S0.4 Tauri v2.10.3 스캐폴드
- [x] S0.5 Electron Plan B 스켈레톤 (dormant)
- [x] S0.6 Tauri #7684 검증 → v2 empirical test 필요

### S1 — stdout 스트레스 테스트 (1.5일)
- [x] S1.1 line-emitter (초안 bash→Rust 바이너리 교체, bash는 0.8%만 달성)
- [x] S1.2 Rust stress harness (`cargo check` 통과)
- [x] S1.3 FE per-eid seq gap 검출 UI
- [x] S1.4 RSS 1s 폴링 + CSV 다운로드
- [x] S1.5 측정 3회 완료 (~53k events/sec, 3.4M lines/run, **drops=0**)
- [x] S1.6 판정서 [spikes/s1-stdout/REPORT.md](spikes/s1-stdout/REPORT.md) — **★ 1차 게이트 ✅ GO**

### S2 — PTY 인터랙션 (1일) ✅ GO
- [x] S2.1 `portable-pty = "0.8"` 통합 ([pty.rs](spikes/tauri-harness/src-tauri/src/pty.rs))
- [x] S2.2 docker run alpine (PASS, 4.2s with first-pull)
- [x] S2.3 python3 -i REPL (PASS, "42" + py3 확인)
- [x] S2.4 ssh localhost (FAIL expected — sshd 꺼짐, PTY 레이어는 정상)
- [x] S2.5 ANSI escape 시퀀스 (PASS, `\x1b[31m` 원본 전달)
- [x] S2.6 판정서 [spikes/s2-pty/REPORT.md](spikes/s2-pty/REPORT.md)

### S3 — xterm.js on WKWebView (0.5일) ✅ GO (effective)
- [x] S3.1 xterm.js v6 + @xterm/addon-webgl + @xterm/addon-fit 통합
- [x] S3.2 10만 라인 dump 벤치 (34k lps, 7-color ANSI)
- [x] S3.3 WebGL2 활성화 확인 (WKWebView 지원)
- [x] S3.4 측정: avg 59.9fps, p5 58.3fps, min 54.5fps
- [x] S3.5 판정서 [spikes/s3-xterm/REPORT.md](spikes/s3-xterm/REPORT.md) — **effectively GO** (0.17% miss, rAF 상한)

### S4 — Rust self-assessment — **SKIPPED** (사용자 Option C 선택, 리스크 감수)
- [~] S4.1~S4.4 건너뜀. Week 2 종료(T05) 시점 재평가로 대체

### 최종
- [x] [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) 작성 — **Tauri v2 확정**
- [x] 3-agent 교차점검 (Evaluator 7.0/10, User-tester NPS 5/10, Architecture)
- [x] Critical Fix Pack (UNI-1~UNI-7 + B4) 전부 적용

## v0.2 Feature Pack (2026-04-06)
- [x] VSCode launch.json scanner (5 types, 변수 치환, JSONC 파서) + 8 tests
- [x] VSCode Import Dialog + "VSCode import" 버튼 통합
- [x] Cloudflare Tunnels 섹션 (installed detect / named list / running detect / Run / Kill)
- [x] 포트 클릭 → 로그 점프 (pid→script 역인덱스)
- [x] 디자인 리프레시: JetBrains Mono, glass effect, compact rows, micro-interactions, dot status
- [x] 30/30 Rust unit tests

## Critical Fix Pack (2026-04-06)
- [x] UNI-1: `blocking_lock()` → async `.lock().await` (데드락 위험 제거)
- [x] UNI-2: generation epoch + try_wait 기반 kill (PID race 방지)
- [x] UNI-3: `runtime.json` 분리 + 500ms debounced flush (config.yaml 오염 제거)
- [x] UNI-4: RestoreAll이 spawn 전에 clear_last_running 호출
- [x] UNI-5: ⌘K 팔레트에 Groups 섹션 추가
- [x] UNI-7: 타입 단일화 (dead `ProcessStatus`/`ProcessHandle`/legacy LogLine 제거)
- [x] B4: `delete_script`/`delete_project`가 실행 중 프로세스 kill (orphan 방지)
- [x] 라인 8KB 트렁케이션 + reader 에러 로깅 (M3)
- [x] log_buffer_size 설정값 연결 (설정 파이프라인)

## Sprint 1 — 기반 & 등록 (Week 1-2)
**Actual Kick-off: 2026-04-05** (사용자 override로 일요일 즉시 착수, Manager 재가동 승인)

### Day 1 (2026-04-05) ✅
- [x] T01 (스캐폴드) — Week 0에서 spikes/tauri-harness로 선행 완료
- [x] W-D1-01: spikes/tauri-harness → app/ 승격 (git mv, history 보존) + identifier rename (procman)
- [x] T02: shadcn/ui + Tailwind v4 + 12 components
- [x] W-D1-03: 3-pane MainLayout (ProjectList 280px / ProcessGrid flex / LogViewer 280px drawer)
- [x] W-D1-04: Rust 명령 스텁 8종 + 도메인 타입 (Project/Script/ProcessHandle/LogLine/PortInfo) + // LEARN 주석
- [x] W-D1-05: api/tauri.ts + zod 스키마 (런타임 검증 래퍼)

### Day 2 (2026-04-05, 사용자 "한번에 쭉" override) ✅ Sprint 1 전체 완료
- [x] T03: Config 스키마 확정 + 3 round-trip 테스트
- [x] T04: ConfigStore YAML atomic read/write + 3 테스트
- [x] T05: Project CRUD IPC 4종 (list/create/update/delete)
- [x] T06: Script CRUD IPC 4종 (scripts nested in Project)
- [x] T07: Project 리스트 UI + New 다이얼로그 + 폴더 피커
- [x] T08: Script 편집 Drawer + Start/Edit/Delete 버튼
- [x] T09: config.yaml 파일시스템 watcher (notify, debounced 200ms)
- [x] T10: package.json 자동 감지 + 스캔 다이얼로그 + bulk import
- [ ] T05: Project CRUD IPC (4종)
- [ ] T06: Script CRUD IPC (4종)
- [ ] T07: Project 리스트 UI + 폼
- [ ] T08: Script 편집 Drawer UI
- [ ] T09: config.yaml FileSystem watcher
- [ ] T10: 프로젝트 자동 감지 (package.json 스캔)

## Sprint 2 — 실행 & 로그 (2026-04-05 단일 세션 완료) ✅
- [x] T11: ProcessManager spawn (tokio::process + DashMap + Arc)
- [x] T12: Login shell 래핑 (`zsh -l -c`) + FORCE_COLOR/CLICOLOR_FORCE env
- [x] T13: Kill 로직 (killpg SIGTERM → 1.5s grace → SIGKILL)
- [x] T14: 상태 이벤트 브로드캐스트 (`process://status`)
- [x] T15: Log ring buffer 5000줄 + 3 unit tests
- [x] T16: Log 이벤트 스트림 (`log://{script_id}`)
- [x] T17: Log Viewer UI (react-window + ansi-to-html, 다중 탭)
- [x] T18: Start/Stop/Restart 버튼 + StatusBadge 실시간
- [x] T19: 그룹 CRUD + Morning Stack 순차 실행 (400ms 딜레이)
- [x] T20: 크래시 감지 & 배지 (exit_code != 0 AND !user_killed)

## Sprint 3 — 포트 관리 & 완성도 (2026-04-05 단일 세션 완료) ✅
- [x] T21: PortScanner (lsof -F pcnT 파싱, 2s 폴링) — Sprint 1에서 선행
- [x] T22: 충돌 감지 (Dashboard matched/other 포트 테이블) — Sprint 1에서 선행
- [x] T23: 원클릭 kill (SIGTERM 1.5s → SIGKILL) — Sprint 1에서 선행
- [x] T24: ⌘K/Ctrl+K 커맨드 팔레트 (프로젝트/스크립트/액션 퍼지 검색)
- [x] T25: 단축키 — ⌘K 팔레트, ⌘L 로그 토글, ⌘, 대시보드로
- [~] T26: 로그 디스크 rotate — 메모리 ring buffer(5000)로 충분, skip
- [x] T27: 세션 복원 — `last_running` 추적 + 재시작 시 RestorePrompt
- [ ] T28: DMG 빌드 + 코드서명 — 수동 릴리즈 단계, README에 빌드 가이드만 추가

## Post-MVP (v0.2+)
- [ ] Docker 컨테이너 직접 제어
- [ ] Cloudflare Tunnel 전용 UI
- [ ] VSCode 연동 (자동 오픈)
- [ ] 메트릭 대시보드 (CPU/메모리 그래프)
- [ ] 알림 (Slack/Discord)
- [ ] 장기 로그 검색
- [ ] E2E 자동화 테스트
- [ ] 팀 공유/동기화
