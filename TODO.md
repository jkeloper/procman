# TODO

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
- [ ] Evaluator 독립 리뷰 대기
- [ ] **Week 2 종료 재평가 게이트**: T05 2일 초과 시 Electron 전환 재검토

## Sprint 1 — 기반 & 등록 (Week 1-2)
**Actual Kick-off: 2026-04-05** (사용자 override로 일요일 즉시 착수, Manager 재가동 승인)

### Day 1 (2026-04-05) ✅
- [x] T01 (스캐폴드) — Week 0에서 spikes/tauri-harness로 선행 완료
- [x] W-D1-01: spikes/tauri-harness → app/ 승격 (git mv, history 보존) + identifier rename (procman)
- [x] T02: shadcn/ui + Tailwind v4 + 12 components
- [x] W-D1-03: 3-pane MainLayout (ProjectList 280px / ProcessGrid flex / LogViewer 280px drawer)
- [x] W-D1-04: Rust 명령 스텁 8종 + 도메인 타입 (Project/Script/ProcessHandle/LogLine/PortInfo) + // LEARN 주석
- [x] W-D1-05: api/tauri.ts + zod 스키마 (런타임 검증 래퍼)

### Day 2~ (대기)
- [ ] T03: Config 스키마 확정 (TS + Rust serde) — **첫 본격 Rust 작성 지점**
- [ ] T04: ConfigStore (YAML read/write, atomic)
- [ ] T05: Project CRUD IPC (4종)
- [ ] T06: Script CRUD IPC (4종)
- [ ] T07: Project 리스트 UI + 폼
- [ ] T08: Script 편집 Drawer UI
- [ ] T09: config.yaml FileSystem watcher
- [ ] T10: 프로젝트 자동 감지 (package.json 스캔)

## Sprint 2 — 실행 & 로그 (Week 3-4)
- [ ] T11: ProcessManager spawn (tokio)
- [ ] T12: Login shell 래핑 (R2 대응)
- [ ] T13: Kill 로직 (SIGTERM→SIGKILL, pgid)
- [ ] T14: 상태 이벤트 브로드캐스트
- [ ] T15: Log ring buffer 5000줄
- [ ] T16: Log 이벤트 스트림 (log://{id})
- [ ] T17: Log Viewer UI (react-window)
- [ ] T18: 시작/중지/재시작 버튼
- [ ] T19: 그룹 CRUD + Morning Stack 실행
- [ ] T20: 크래시 감지 & 배지

## Sprint 3 — 포트 관리 & 완성도 (Week 5-6)
- [ ] T21: PortScanner (lsof, 1s 폴링)
- [ ] T22: 충돌 감지 배너
- [ ] T23: 원클릭 해결 (킬러 기능)
- [ ] T24: ⌘K 커맨드 팔레트 (cmdk)
- [ ] T25: 단축키/핫키 매핑
- [ ] T26: 로그 디스크 rotate (옵션)
- [ ] T27: 앱 재시작 시 세션 복원 프롬프트
- [ ] T28: .dmg 빌드 + 코드서명 + README

## Post-MVP (v0.2+)
- [ ] Docker 컨테이너 직접 제어
- [ ] Cloudflare Tunnel 전용 UI
- [ ] VSCode 연동 (자동 오픈)
- [ ] 메트릭 대시보드 (CPU/메모리 그래프)
- [ ] 알림 (Slack/Discord)
- [ ] 장기 로그 검색
- [ ] E2E 자동화 테스트
- [ ] 팀 공유/동기화
