# procman

Mac용 프로세스 매니저 GUI. 로컬 개발환경의 여러 서버·tunnel·docker 프로세스를 한 화면에서 관리.

## 상태
🟢 **Week 0 D1 — 스파이크 S0~S1 골격 완료** (2026-04-05)

- Q3 Mac 전용 / Q2 7주 안전 확정, Q1 Rust는 S4 실증 판정으로 DEFER
- Tauri v2.10.3 + Electron Plan B 스켈레톤 양쪽 준비
- S1 stdout 스트레스 하네스(Rust + React) `cargo check` 통과
- Day 2: S1.5 3회 측정 실행 → S1.6 판정서 → 1차 Go/No-Go 게이트

## 핵심 기능 (계획)
- 스크립트 등록/실행/중지
- 실시간 로그 스트리밍
- 포트 충돌 감지 + 원클릭 해결 (킬러 기능)
- 그룹 프로파일 실행 ("Morning Stack")
- ⌘K 커맨드 팔레트
- YAML 기반 설정 (git 친화적)

## 기술 스택 (후보)
- Plan A: Tauri v2 (Rust + React/TS)
- Plan B: Electron + node-pty

## 개발 로드맵
- **Week 0**: 스파이크 검증 (4.5일)
- **Sprint 1 (Week 1-2)**: 기반 & 등록
- **Sprint 2 (Week 3-4)**: 실행 & 로그
- **Sprint 3 (Week 5-6)**: 포트 관리 & 완성도

자세한 내용은 [docs/](docs/) 디렉토리 참고. 스파이크 산출물은 [spikes/](spikes/) 참고.

## 문서
- [CLAUDE.md](CLAUDE.md) — AI 작업용 프로젝트 컨텍스트
- [TODO.md](TODO.md) — 작업 목록
- [CHANGELOG.md](CHANGELOG.md) — 변경 이력
- [docs/](docs/) — 기획 문서 (Charter, 기술리서치, UX비전, 평가서, 로드맵, 의사결정)
