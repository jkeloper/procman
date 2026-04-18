# procman — Mobile Companion

데스크톱 procman을 외출·침대·다른 방에서 조작하기 위한 모바일 동반 앱.
- **PWA** (React/TS + Capacitor) — 브라우저에서 직접 설치 가능
- **iOS 네이티브 셸** (Capacitor) — App Store 우회 설치 시 사용

전체 개요는 [루트 README](../README.md) 참고. 데스크톱 앱은 [app/](../app/).

## 아키텍처
```
[Desktop procman] --REST/WS--> [Cloudflare Tunnel] --HTTPS--> [Mobile PWA/iOS]
         ↑
   remote.rs  (REST + WebSocket, CORS: trycloudflare.com + LAN IPs)
```

데스크톱 `src-tauri/src/remote.rs`가 REST + WebSocket 서버를 띄우고, `cloudflared` 터널로 외부 노출. 모바일은 QR 코드 1회 스캔으로 페어링.

## Prerequisites
- Node 20+
- pnpm 10
- (iOS 빌드 시) Xcode 15+ + Apple Developer 계정

## 개발 모드
```bash
cd mobile
pnpm install
pnpm dev                              # Vite PWA (port 5174)
```

## PWA 빌드 & 배포
```bash
pnpm build                            # dist/
# dist/를 정적 호스팅(GitHub Pages, Vercel 등)에 배포
# PWA manifest가 포함되어 있어 홈 화면 추가 시 풀스크린으로 실행
```

## iOS 빌드
```bash
pnpm build
npx cap sync ios
npx cap open ios                      # Xcode로 열고 서명 + 빌드
```

iOS 프로젝트는 [ios/App/](ios/App/)에 커밋되어 있음. Capacitor가 자동 생성한 부분(`ios/App/CapApp-SPM/`)은 건드리지 말 것.

## 페어링 플로우
1. 데스크톱 procman → Remote Access 카드에서 "터널 시작"
2. 화면에 QR 코드 + pairing token 표시
3. 모바일에서 PWA 열고 QR 스캔 → 자동으로 endpoint + token 저장
4. 이후 연결 시 저장된 token 재사용

## 기능 (S1-S5 전부 미러링)
- 프로젝트 리스트 (펼쳐진 상태 유지 — start/stop 후에도)
- 스크립트 start/stop/restart + 실시간 상태
- 로그 뷰어 (substring 검색 포함)
- 포트 dashboard + liveness dot
- CPU/RSS 메트릭 표시
- Cloudflare tunnel run/kill
- 그룹 실행
- ⌘K 커맨드 팔레트 (모바일에서는 검색 버튼)

## 디렉토리 구조
```
mobile/
├── src/                              # React PWA 소스 (app/src와 공유 컴포넌트 일부 재사용)
│   ├── api/                          # REST + WebSocket 클라이언트
│   ├── components/                   # 데스크톱 UI의 모바일 포팅
│   └── pairing/                      # QR 스캐너 + token 저장소
├── public/                           # PWA manifest + 아이콘
├── ios/App/                          # Capacitor iOS 프로젝트 (Xcode workspace)
└── capacitor.config.ts
```

## 보안 경계
- 터널 endpoint는 pairing token 없이는 의미있는 작업 불가
- CORS는 `trycloudflare.com` + LAN IPs로 제한 (`remote.rs`)
- Governor rate limiting은 Tauri 컨텍스트에서 실패하므로 사용하지 않음 (참고: [SECURITY.md](../SECURITY.md))
- 신뢰 경계: 터널 endpoint를 타인에게 공유하지 말 것
