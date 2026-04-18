# procman — Mobile Companion

A mobile companion for controlling desktop procman from outside, in bed, or across the house.
- **PWA** (React/TS + Capacitor) — installable straight from the browser
- **iOS native shell** (Capacitor) — for sideloading outside the App Store

For the overall project overview see the [root README](../README.md). The desktop app lives in [app/](../app/).

## Architecture
```
[Desktop procman] --REST/WS--> [Cloudflare Tunnel] --HTTPS--> [Mobile PWA/iOS]
         ↑
   remote.rs  (REST + WebSocket, CORS: trycloudflare.com + LAN IPs)
```

The desktop `src-tauri/src/remote.rs` hosts a REST + WebSocket server and exposes it through a `cloudflared` tunnel. The mobile client pairs in one QR-code scan.

## Prerequisites
- Node 20+
- pnpm 10
- (iOS builds only) Xcode 15+ and an Apple Developer account

## Dev mode
```bash
cd mobile
pnpm install
pnpm dev                              # Vite PWA (port 5174)
```

## PWA build & deploy
```bash
pnpm build                            # → dist/
# Deploy dist/ to any static host (GitHub Pages, Vercel, etc.).
# The PWA manifest is bundled, so "Add to Home Screen" gives a fullscreen install.
```

## iOS build
```bash
pnpm build
npx cap sync ios
npx cap open ios                      # open in Xcode, sign, build
```

The iOS project is committed under [ios/App/](ios/App/). Leave the Capacitor-generated parts (`ios/App/CapApp-SPM/`) untouched.

## Pairing flow
1. Desktop procman → Remote Access card → "Start Tunnel"
2. The desktop shows a QR code + pairing token
3. Open the PWA on mobile, scan the QR → endpoint + token saved automatically
4. Subsequent connections reuse the stored token

## Features (full S1–S5 mirror)
- Project list (stays expanded across start/stop)
- Script start/stop/restart with live status
- Log viewer (with substring search)
- Port dashboard + liveness dot
- CPU/RSS metric display
- Cloudflare tunnel run/kill
- Group execution
- ⌘K command palette (surfaced as a search button on mobile)

## Directory layout
```
mobile/
├── src/                              # React PWA source (shares some components with app/src)
│   ├── api/                          # REST + WebSocket client
│   ├── components/                   # mobile-ported desktop UI
│   └── pairing/                      # QR scanner + token store
├── public/                           # PWA manifest + icons
├── ios/App/                          # Capacitor iOS project (Xcode workspace)
└── capacitor.config.ts
```

## Security boundary
- The tunnel endpoint is useless without the pairing token
- CORS is restricted to `trycloudflare.com` + LAN IPs (`remote.rs`)
- Governor rate limiting doesn't work under the Tauri context and is intentionally not used (see [SECURITY.md](../SECURITY.md))
- Trust boundary: do not share the tunnel endpoint with anyone you don't trust

---

# procman — 모바일 동반 앱 (한국어)

데스크톱 procman을 외출·침대·다른 방에서 조작하기 위한 모바일 동반 앱.
- **PWA** (React/TS + Capacitor) — 브라우저에서 직접 설치 가능
- **iOS 네이티브 셸** (Capacitor) — App Store 우회 설치 시 사용

전체 프로젝트 개요는 [루트 README](../README.md) 참고. 데스크톱 앱은 [app/](../app/).

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
