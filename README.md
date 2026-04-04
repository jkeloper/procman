# procman

Mac용 프로세스 매니저 GUI. 로컬 개발환경의 여러 서버·tunnel·docker 프로세스를 한 화면에서 관리.

## 상태
🟢 **Sprint 1 Day 1 완료** (2026-04-05)

- Week 0 스파이크 4건 전부 GO (S0/S1/S2/S3), S4 SKIP, **Tauri v2 확정**
- Sprint 1 Day 1: 프로젝트 승격 + shadcn/ui + 3-pane 레이아웃 + 명령 스텁 + 타입 시스템
- 잔여 리스크: R_Rust_Proficiency HIGH → T05 게이트(Week 2) 재평가

## 핵심 기능 (계획)
- 스크립트 등록/실행/중지
- 실시간 로그 스트리밍
- 포트 충돌 감지 + 원클릭 해결 (킬러 기능)
- 그룹 프로파일 실행 ("Morning Stack")
- ⌘K 커맨드 팔레트
- YAML 기반 설정 (git 친화적)

## 기술 스택
- **Tauri v2.10** (Rust 백엔드 + React/TS 프론트엔드)
- **shadcn/ui** + Tailwind v4
- **portable-pty** (PTY 세션) / **tokio** (async)
- Mac 전용 (macOS 14+)

## 디렉토리 구조
```
procman/
├── app/                    # Tauri 메인 앱
│   ├── src/                # React 프론트엔드
│   │   ├── layouts/        # MainLayout (3-pane shell)
│   │   ├── components/     # project/process/log + ui/
│   │   ├── api/            # Tauri invoke 래퍼 + zod 스키마
│   │   └── App.tsx
│   └── src-tauri/          # Rust 백엔드
│       └── src/
│           ├── types.rs    # 도메인 타입 (serde)
│           ├── commands/   # IPC 명령 (project/process/port)
│           ├── stress.rs   # spike reference (T11)
│           └── pty.rs      # spike reference (T16-T17)
├── docs/                   # 기획 문서 6종
└── spikes/                 # Week 0 스파이크 산출물 (archival)
```

## 개발 실행

Prerequisites: Rust 1.85+, Node 20+, pnpm 10

```bash
cd app
source "$HOME/.cargo/env"   # if cargo not in PATH
pnpm install
pnpm tauri dev              # starts Vite + Tauri on port 1420
```

## 문서
- [CLAUDE.md](CLAUDE.md) — AI 작업용 프로젝트 컨텍스트
- [TODO.md](TODO.md) — 작업 목록
- [CHANGELOG.md](CHANGELOG.md) — 변경 이력
- [docs/](docs/) — 기획 문서 (Charter, 기술리서치, UX비전, 평가서, 로드맵, 의사결정)
- [docs/monday-kickoff.md](docs/monday-kickoff.md) — Sprint 1 원안 (참조)
- [spikes/FINAL-VERDICT.md](spikes/FINAL-VERDICT.md) — Week 0 최종 판정
