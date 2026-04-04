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

### S2 — PTY 인터랙션 (1일)
- [ ] S2.1 `portable-pty` crate 통합
- [ ] S2.2 docker exec / S2.3 python -i / S2.4 ssh 시나리오
- [ ] S2.5 컬러 시퀀스 육안 검증
- [ ] S2.6 판정서

### S3 — xterm.js on WKWebView (0.5일)
- [ ] S3.1 xterm.js + @xterm/addon-webgl 통합
- [ ] S3.2 10만 라인 주입 + FPS 벤치
- [ ] S3.3 WebGL 활성화 확인
- [ ] S3.4 측정 / S3.5 판정서

### S4 — Rust self-assessment (1일, 사용자 직접)
- [ ] S4.1 과제 A: tokio async 기본기 (2h)
- [ ] S4.2 과제 B: tokio::process + broadcast 스트리밍 (2h)
- [ ] S4.3 과제 C: portable-pty 에코 셸 (1~2h)
- [ ] S4.4 `SELF-ASSESSMENT.md` 작성 → ★ 2차 Go/No-Go 게이트

### 최종
- [ ] `spikes/FINAL-VERDICT.md` (Manager+Evaluator 통합 판정)

## Sprint 1 — 기반 & 등록 (Week 1-2)
- [ ] T01: Tauri+React+TS 스캐폴드
- [ ] T02: shadcn/ui + Tailwind + 기본 레이아웃
- [ ] T03: Config 스키마 확정 (TS + Rust serde)
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
